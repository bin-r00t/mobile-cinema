import Hls from "hls.js";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";

import { selectPlaybackSource } from "../lib/playback";
import { clearPosition, resumePosition, writePosition } from "../lib/progress";
import {
  PlayerControls,
  type BufferedRange,
  type QualityLevel,
} from "./PlayerControls";
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
}

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
    if (response.ok) return true;
    if (response.status !== 202) return false;
    await new Promise((resolve) => setTimeout(resolve, PLAYLIST_POLL_MS));
  }
  return false;
}

export function Player({ media, onExit, ref }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const prepareRef = useRef<AbortController | null>(null);
  const lastSaveRef = useRef(0);

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

  // The fields of the movie are taken apart, so that a new movie and a new
  // object that holds the same movie are not two different things.
  const mediaId = media.id;
  const streamUrl = media.streamUrl;
  const hlsUrl = media.hlsUrl;

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

    const source = selectPlaybackSource({ id: mediaId, streamUrl, hlsUrl });
    if (!source) {
      setError("This movie cannot be played.");
      return () => controller.abort();
    }

    if (source.kind === "hls") {
      attachHls(source.url);
      return () => controller.abort();
    }

    video.src = source.url;
    video.load();

    return () => {
      controller.abort();
    };
  }, [attachHls, hlsUrl, mediaId, streamUrl]);

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
  const hlsAttemptedRef = useRef(false);

  const fallBackToHls = useCallback(async () => {
    if (hlsAttemptedRef.current) {
      setError("This movie is served as HLS, and this browser cannot play it.");
      return;
    }
    hlsAttemptedRef.current = true;

    const controller = new AbortController();
    prepareRef.current = controller;
    setPreparing(true);
    setError(null);

    const ready = await waitForPlaylist(mediaId, controller.signal).catch(
      () => false,
    );
    if (controller.signal.aborted) return;

    setPreparing(false);
    if (!ready) {
      setError("The stream of this movie could not be prepared.");
      return;
    }
    attachHls(`/api/hls/${mediaId}/master.m3u8`);
    videoRef.current?.play().catch(() => {
      setError("The browser wants a click before it plays the movie.");
    });
  }, [attachHls, mediaId]);

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

  return (
    <div className="player">
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
      />
    </div>
  );
}
