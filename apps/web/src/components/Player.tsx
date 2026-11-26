import Hls from "hls.js";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
  type TouchEvent,
} from "react";

import { selectPlaybackSource } from "../lib/playback";
import { clearPosition, resumePosition, writePosition } from "../lib/progress";
import {
  PlayerControls,
  type BufferedRange,
  type QualityLevel,
} from "./PlayerControls";
import type { SubtitleTrack } from "./ScriptTab";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { SubtitleOverlay, type SubtitleSize } from "./SubtitleOverlay";
import { SubtitleSettings } from "./SubtitleSettings";
import {
  clamp,
  gestureIntent,
  seekSeconds,
  volumeDelta,
} from "./playerGestures";
import { playerKeyAction, type PlayerKeyAction } from "./playerKeys";
import "../styles/player.css";

/** The movie the player shows. */
export interface PlayerMedia {
  /** The id of the movie in the catalog. */
  id: number;
  /** The title of the movie. */
  title: string;
  /** The progressive stream, or null when the movie has none. */
  streamUrl: string | null;
  /** The HLS master playlist, or null when there is none yet. */
  hlsUrl: string | null;
  /** The subtitle tracks of the movie, empty when it has none. */
  subtitles?: SubtitleTrack[];
}

/** The subtitle tracks of a movie that has none, always the same empty list. */
const NO_SUBTITLES: SubtitleTrack[] = [];

/** What the caller of the player can do with it. */
export interface PlayerHandle {
  /** Starts the movie. */
  play(): void;
  /** Stops the movie. */
  pause(): void;
}

export interface PlayerProps {
  /** The movie to play. */
  media: PlayerMedia;
  /** Called when the user wants to leave the player. */
  onExit?: () => void;
  /** The ref of the player, so that the caller can start and stop it. */
  ref?: Ref<PlayerHandle>;
}

/** How often the position of the movie is written down. */
const SAVE_INTERVAL_MS = 5000;

/** How often the master playlist is asked for while it is being written. */
const PLAYLIST_POLL_MS = 2000;

/** How many times the playlist is asked for before it is given up on. */
const PLAYLIST_POLL_ATTEMPTS = 60;

/**
 * Waits for the master playlist of a movie to be written into the cache.
 *
 * The server answers "not ready yet" while the transcode is running, so the
 * playlist is asked for again and again until it is there.
 */
async function waitForPlaylist(
  movieId: number,
  signal: AbortSignal,
): Promise<boolean> {
  for (let attempt = 0; attempt < PLAYLIST_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetch(`/api/hls/${movieId}/master.m3u8`, { signal });
    // "Not ready yet" is an answer of its own, and it is not a playlist:
    // only the playlist itself (200) means the transcode is done.
    if (response.status === 200) return true;
    if (response.status !== 202) return false;
    await new Promise((resolve) => setTimeout(resolve, PLAYLIST_POLL_MS));
  }
  return false;
}

export function Player({ media, onExit, ref }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const prepareRef = useRef<AbortController | null>(null);
  const lastSaveRef = useRef(0);
  /** Whether the movie has already been asked for as an HLS stream. */
  const hlsAttemptedRef = useRef(false);
  /** The swipe that is under the finger at the moment, or null. */
  const gestureRef = useRef<{
    x: number;
    y: number;
    intent: "seek" | "volume" | null;
    volume: number;
  } | null>(null);

  const [paused, setPaused] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState<BufferedRange[]>([]);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [levels, setLevels] = useState<QualityLevel[]>([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  /** What the swipe under the finger is doing, shown over the movie. */
  const [gestureHint, setGestureHint] = useState<string | null>(null);

  // The fields of the movie are taken apart, so that a new movie and a new
  // object that holds the same movie are not two different things.
  const mediaId = media.id;
  const streamUrl = media.streamUrl;
  const hlsUrl = media.hlsUrl;
  const subtitleTracks = media.subtitles ?? NO_SUBTITLES;

  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [subtitleTrackId, setSubtitleTrackId] = useState<number | null>(null);
  const [subtitleSize, setSubtitleSize] = useState<SubtitleSize>("medium");
  const [subtitleOffsetMs, setSubtitleOffsetMs] = useState(0);

  // Another movie brings its own subtitles: the primary track of the movie
  // is picked, and the timing goes back to the file.
  useEffect(() => {
    const defaultTrack =
      subtitleTracks.find((track) => track.isPrimary && track.vttUrl !== null) ??
      subtitleTracks.find((track) => track.vttUrl !== null) ??
      null;
    setSubtitlesEnabled(defaultTrack !== null);
    setSubtitleTrackId(defaultTrack ? defaultTrack.id : null);
    setSubtitleOffsetMs(0);
  }, [subtitleTracks]);

  /** Puts the HLS stream of a movie on the video element. */
  const attachHls = useCallback((url: string) => {
    const video = videoRef.current;
    if (!video) return;

    hlsRef.current?.destroy();
    hlsRef.current = null;

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hlsRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        setLevels(
          data.levels.map((level, index) => ({
            index,
            height: level.height ?? 0,
            bitrate: level.bitrate,
          })),
        );
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        setCurrentLevel(data.level);
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setError("The stream of this movie could not be played.");
        }
      });
      return;
    }

    // A browser that speaks HLS on its own (Safari) plays the playlist
    // itself. There are no renditions to switch between.
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      return;
    }
    setError("This browser cannot play the HLS stream of this movie.");
  }, []);

  /**
   * Serves the movie through HLS.
   *
   * The playlist is only written into the cache once the transcode is done,
   * so it is asked for until the server hands it out. Only a 200 is a
   * playlist; the 202 of the server means "not ready yet".
   */
  const prepareHls = useCallback(
    async (movieId: number) => {
      prepareRef.current?.abort();
      const controller = new AbortController();
      prepareRef.current = controller;
      setPreparing(true);
      setError(null);

      const ready = await waitForPlaylist(movieId, controller.signal).catch(
        () => false,
      );
      if (controller.signal.aborted) return;

      setPreparing(false);
      if (!ready) {
        setError("The stream of this movie could not be prepared.");
        return;
      }
      attachHls(`/api/hls/${movieId}/master.m3u8`);
    },
    [attachHls],
  );

  // The source of the movie. A movie that the browser cannot play
  // progressively is served through HLS, so the playlist is asked for then.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    prepareRef.current?.abort();
    const controller = new AbortController();
    prepareRef.current = controller;

    setError(null);
    setLevels([]);
    setCurrentLevel(-1);
    setPreparing(false);
    // Another movie may be played through HLS, so the attempt belongs to
    // the movie that is on the screen.
    hlsAttemptedRef.current = false;

    const source = selectPlaybackSource({ id: mediaId, streamUrl, hlsUrl });
    if (!source) {
      setError("This movie cannot be played.");
      return () => controller.abort();
    }

    if (source.kind === "hls") {
      // The playlist is not written into the cache until the transcode is
      // done, so it is asked for until the server hands it out.
      void prepareHls(mediaId);
      return () => controller.abort();
    }

    video.src = source.url;
    video.load();

    return () => {
      controller.abort();
    };
  }, [attachHls, hlsUrl, mediaId, prepareHls, streamUrl]);

  // The player is left behind when the page goes away.
  useEffect(
    () => () => {
      prepareRef.current?.abort();
      hlsRef.current?.destroy();
      hlsRef.current = null;
    },
    [],
  );

  const readBuffered = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const ranges: BufferedRange[] = [];
    for (let index = 0; index < video.buffered.length; index += 1) {
      ranges.push({
        start: video.buffered.start(index),
        end: video.buffered.end(index),
      });
    }
    setBuffered(ranges);
  }, []);

  const savePosition = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    writePosition(mediaId, Math.round(video.currentTime * 1000));
  }, [mediaId]);

  const onTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
    readBuffered();

    const now = Date.now();
    if (now - lastSaveRef.current >= SAVE_INTERVAL_MS) {
      lastSaveRef.current = now;
      savePosition();
    }
  }, [readBuffered, savePosition]);

  const onLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration);

    // The movie is picked up where it was left, unless it was watched to
    // the end.
    const saved = resumePosition(mediaId, video.duration * 1000);
    if (saved !== null) {
      video.currentTime = saved / 1000;
      setCurrentTime(video.currentTime);
    }
  }, [mediaId]);

  /**
   * The browser refused the source.
   *
   * A movie whose container the browser does not know is served through
   * HLS, so the playlist is asked for instead. The attempt is made once, so
   * a browser that cannot play it is told so instead of asking again.
   */
  const fallBackToHls = useCallback(async () => {
    if (hlsAttemptedRef.current) {
      setError("This movie is served as HLS, and this browser cannot play it.");
      return;
    }
    hlsAttemptedRef.current = true;

    await prepareHls(mediaId);
    videoRef.current?.play().catch(() => {
      setError("The browser wants a click before it plays the movie.");
    });
  }, [mediaId, prepareHls]);

  const onVideoError = useCallback(() => {
    void fallBackToHls();
  }, [fallBackToHls]);

  const onEnded = useCallback(() => {
    // The movie is over: there is nothing to come back to.
    clearPosition(mediaId);
    savePosition();
  }, [mediaId, savePosition]);

  const play = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.play().catch(() => {
      setError("The browser wants a click before it plays the movie.");
    });
  }, []);

  const pause = useCallback(() => {
    videoRef.current?.pause();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      play,
      pause,
    }),
    [pause, play],
  );

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) play();
    else pause();
  }, [pause, play]);

  const seek = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = seconds;
    setCurrentTime(seconds);
  }, []);

  const changeVolume = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = value;
    video.muted = value === 0;
    setVolume(value);
    setMuted(video.muted);
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  /**
   * Picks the rendition of the stream.
   *
   * The level is switched inside the stream itself, so the movie does not
   * have to be loaded again to change its quality.
   */
  const changeQuality = useCallback((level: number) => {
    const hls = hlsRef.current;
    if (!hls) return;
    hls.currentLevel = level;
    hls.loadLevel = level;
    setCurrentLevel(level);
  }, []);

  /** Fills the screen with the player, or hands the screen back. */
  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      container.requestFullscreen().catch(() => {
        // The browser refused the screen: the theater keeps its window.
      });
    }
  }, []);

  // The player follows the screen into the fullscreen and out of it,
  // however the way out was asked for.
  useEffect(() => {
    const onFullscreenChange = () => {
      setFullscreen(document.fullscreenElement !== null);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  /** Does what a key or a swipe has asked the player for. */
  const applyAction = useCallback(
    (action: PlayerKeyAction) => {
      const video = videoRef.current;
      if (!video) return;
      switch (action.kind) {
        case "toggle-play":
          if (video.paused) play();
          else pause();
          return;
        case "seek": {
          const limit = duration > 0 ? duration : video.duration || 0;
          seek(clamp(video.currentTime + action.seconds, 0, limit));
          return;
        }
        case "volume":
          changeVolume(clamp(volume + action.delta, 0, 1));
          return;
        case "toggle-mute":
          toggleMute();
          return;
        case "toggle-fullscreen":
          toggleFullscreen();
          return;
        case "exit":
          onExit?.();
          return;
      }
    },
    [
      changeVolume,
      duration,
      onExit,
      pause,
      play,
      seek,
      toggleFullscreen,
      toggleMute,
      volume,
    ],
  );

  // The keys of the player are answered wherever the focus sits, except on
  // the parts of the page that speak for themselves: a slider keeps its own
  // arrows, a button keeps its own space bar.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, select, textarea, button, a, [contenteditable]")
      ) {
        return;
      }
      const action = playerKeyAction(event);
      if (!action) return;
      event.preventDefault();
      applyAction(action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyAction]);

  /** A swipe begins, unless it begins on the bar of controls. */
  const onGestureStart = useCallback(
    (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".player-controls, .player-help")
      ) {
        return;
      }
      const touch = event.touches[0];
      if (!touch) return;
      gestureRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        intent: null,
        volume,
      };
    },
    [volume],
  );

  /** A swipe on the way: the volume follows at once, the seek is shown. */
  const onGestureMove = useCallback(
    (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      const width = containerRef.current?.clientWidth ?? 0;
      const height = containerRef.current?.clientHeight ?? 0;

      if (gesture.intent === null) {
        const intent = gestureIntent(dx, dy);
        if (intent === null) return;
        gesture.intent = intent;
      }

      if (gesture.intent === "volume") {
        const next = clamp(gesture.volume + volumeDelta(dy, height), 0, 1);
        changeVolume(next);
        setGestureHint(`Volume ${Math.round(next * 100)} %`);
        return;
      }

      const seconds = seekSeconds(dx, width);
      setGestureHint(
        `${seconds < 0 ? "Back" : "Ahead"} ${Math.abs(Math.round(seconds))} s`,
      );
    },
    [changeVolume],
  );

  /** The swipe is over: a swipe along the screen seeks the movie. */
  const onGestureEnd = useCallback(
    (event: TouchEvent) => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      setGestureHint(null);
      if (!gesture || gesture.intent !== "seek") return;
      const touch = event.changedTouches[0];
      const video = videoRef.current;
      const width = containerRef.current?.clientWidth ?? 0;
      if (!touch || !video || width <= 0) return;
      const seconds = seekSeconds(touch.clientX - gesture.x, width);
      const limit = duration > 0 ? duration : video.duration || 0;
      seek(clamp(video.currentTime + seconds, 0, limit));
    },
    [duration, seek],
  );

  // The track that is on the screen. A track without a WebVTT file is never
  // picked, and the subtitles that are turned off are no track at all.
  const selectedSubtitleTrack = subtitlesEnabled
    ? subtitleTracks.find(
        (track) => track.id === subtitleTrackId && track.vttUrl !== null,
      ) ?? null
    : null;

  return (
    <div
      ref={containerRef}
      className={`player${fullscreen ? " player-fullscreen" : ""}`}
      onTouchStart={onGestureStart}
      onTouchMove={onGestureMove}
      onTouchEnd={onGestureEnd}
      onTouchCancel={() => {
        gestureRef.current = null;
        setGestureHint(null);
      }}
    >
      <video
        ref={videoRef}
        className="player-video"
        playsInline
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onProgress={readBuffered}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onVolumeChange={() => {
          const video = videoRef.current;
          if (!video) return;
          setVolume(video.volume);
          setMuted(video.muted);
        }}
        onEnded={onEnded}
        onError={onVideoError}
      />

      {(error || preparing) && (
        <p className="player-notice" role="status">
          {error ?? "Preparing the stream…"}
        </p>
      )}

      <SubtitleOverlay
        track={selectedSubtitleTrack}
        currentTime={currentTime}
        offsetMs={subtitleOffsetMs}
        size={subtitleSize}
      />

      {gestureHint && (
        <p className="player-gesture-hint" aria-hidden="true">
          {gestureHint}
        </p>
      )}

      <PlayerControls
        paused={paused}
        currentTime={currentTime}
        duration={duration}
        buffered={buffered}
        volume={volume}
        muted={muted}
        levels={levels}
        currentLevel={currentLevel}
        onTogglePlay={togglePlay}
        onSeek={seek}
        onVolumeChange={changeVolume}
        onToggleMute={toggleMute}
        onQualityChange={changeQuality}
        onExit={onExit}
      >
        {subtitleTracks.length > 0 && (
          <SubtitleSettings
            tracks={subtitleTracks}
            enabled={subtitlesEnabled}
            trackId={subtitleTrackId}
            size={subtitleSize}
            offsetMs={subtitleOffsetMs}
            onEnabledChange={setSubtitlesEnabled}
            onTrackChange={setSubtitleTrackId}
            onSizeChange={setSubtitleSize}
            onOffsetChange={setSubtitleOffsetMs}
          />
        )}

        <button
          type="button"
          className="player-button"
          aria-label="Shortcuts"
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((open) => !open)}
        >
          ?
        </button>
      </PlayerControls>

      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
