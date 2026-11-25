import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { formatDuration, formatYear } from "../lib/format";
import { hlsPlaylistUrl, selectPlaybackSource } from "../lib/playback";
import "../styles/theater.css";

interface TheaterMovie {
  id: number;
  title: string;
  year: number | null;
  description: string | null;
  posterUrl: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  container: string | null;
  sizeBytes: number | null;
  streamUrl: string | null;
  hlsUrl: string | null;
}

type TheaterState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; movie: TheaterMovie };

/** What the page shows at the moment: the entrance or the movie. */
type Phase = "intro" | "playing";

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
async function waitForPlaylist(movieId: number, signal: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < PLAYLIST_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetch(hlsPlaylistUrl(movieId), { signal });
    if (response.ok) return true;
    if (response.status !== 202) return false;
    await new Promise((resolve) => setTimeout(resolve, PLAYLIST_POLL_MS));
  }
  return false;
}

export function Theater() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<TheaterState>({ status: "loading" });
  const [phase, setPhase] = useState<Phase>("intro");
  const [preparing, setPreparing] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const prepareRef = useRef<AbortController | null>(null);
  const hlsAttemptedRef = useRef(false);
  const kindRef = useRef<"progressive" | "hls">("progressive");
  const checkRef = useRef<number | null>(null);
  const preparingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    // Another movie may be played through HLS, so the attempt belongs to
    // the movie that is on the screen.
    hlsAttemptedRef.current = false;

    fetch(`/api/movies/${id}`)
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(
            body?.error?.message ?? `The server answered ${response.status}`,
          );
        }
        return response.json() as Promise<{ movie: TheaterMovie }>;
      })
      .then(({ movie }) => {
        if (!cancelled) setState({ status: "ready", movie });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message:
              error instanceof Error ? error.message : "The movie could not be loaded",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  // The way out of the theater is the escape key as well as the link: the
  // movie is the whole screen, and the keyboard is the fastest way out of it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") navigate("/");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  // A movie that is being prepared is left alone when the page goes away.
  useEffect(
    () => () => {
      prepareRef.current?.abort();
      if (checkRef.current !== null) window.clearTimeout(checkRef.current);
    },
    [],
  );

  /**
   * Starts the movie.
   *
   * The call to play() happens inside the click, so the browser sees the
   * gesture of the user and lets the movie start: without it the browser
   * refuses to play and the page would only show an autoplay error.
   */
  const playVideo = useCallback((kind: "progressive" | "hls" = kindRef.current) => {
    const video = videoRef.current;
    if (!video) return;
    setPhase("playing");

    // The check of the last attempt is dropped: only the source that is on
    // the screen has a say about what went wrong.
    if (checkRef.current !== null) {
      window.clearTimeout(checkRef.current);
      checkRef.current = null;
    }

    const complain = () => {
      // A browser that does not speak HLS says so; one that wants a
      // gesture leaves the start button on the screen, so the user can ask
      // for it again.
      setPlaybackError(
        kind === "hls"
          ? "This browser cannot play the HLS stream of this movie."
          : "The browser wants a click before it plays the movie.",
      );
    };

    const started = video.play();
    if (started) {
      started.catch(complain);
    }

    // A browser can accept the promise and still play nothing: a stream it
    // does not understand leaves the movie standing at the first frame.
    checkRef.current = window.setTimeout(() => {
      // While the stream is still being prepared there is nothing to
      // complain about yet.
      if (preparingRef.current) return;
      if (video.paused && video.currentTime === 0) complain();
    }, 2500);
  }, []);

  /** Puts a source on the video element. */
  const attach = useCallback((url: string, kind: "progressive" | "hls") => {
    const video = videoRef.current;
    if (!video) return;
    kindRef.current = kind;
    video.src = url;
    video.load();
  }, []);

  /**
   * Serves the movie through HLS.
   *
   * The playlist is only written into the cache once the transcode is
   * done, so it is asked for until the server hands it out.
   */
  const prepareHls = useCallback(
    async (movieId: number) => {
      // The playlist is asked for once. A browser that cannot play it
      // fails again, and asking again would only ask again.
      if (hlsAttemptedRef.current) {
        setPlaybackError(
          "This movie is served as HLS, and this browser cannot play it.",
        );
        return;
      }
      hlsAttemptedRef.current = true;

      prepareRef.current?.abort();
      const controller = new AbortController();
      prepareRef.current = controller;
      preparingRef.current = true;
      setPreparing(true);
      setPlaybackError(null);

      const ready = await waitForPlaylist(movieId, controller.signal).catch(
        () => false,
      );
      if (controller.signal.aborted) return;

      preparingRef.current = false;
      setPreparing(false);
      if (!ready) {
        setPlaybackError("The stream of this movie could not be prepared.");
        return;
      }
      attach(hlsPlaylistUrl(movieId), "hls");
      playVideo("hls");
    },
    [attach, playVideo],
  );

  const start = useCallback(() => {
    if (state.status !== "ready") return;
    const video = videoRef.current;
    const { movie } = state;
    const source = selectPlaybackSource(movie);
    if (!video || !source) {
      setPlaybackError("This movie cannot be played.");
      return;
    }

    // A source that is already on the video element only needs the play.
    if (video.currentSrc || video.src) {
      playVideo();
      return;
    }

    setPlaybackError(null);
    if (source.kind === "hls") {
      void prepareHls(movie.id);
      return;
    }
    attach(source.url, source.kind);
    playVideo(source.kind);
  }, [attach, playVideo, prepareHls, state]);

  /**
   * The browser refused the source.
   *
   * A movie whose container the browser does not know is served through
   * HLS, so the playlist is asked for instead.
   */
  const onVideoError = useCallback(() => {
    if (state.status !== "ready") return;
    setPlaybackError("This movie cannot be played in this browser.");
    void prepareHls(state.movie.id);
  }, [prepareHls, state]);

  if (state.status === "loading") {
    return (
      <section className="theater-page theater-message">
        <p className="muted">Loading the movie…</p>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="theater-page theater-message">
        <h1>Theater mode</h1>
        <p className="muted">{state.message}</p>
        <Link className="theater-exit" to="/">
          ← Back to the library
        </Link>
      </section>
    );
  }

  const { movie } = state;
  const metadata = [
    formatYear(movie.year),
    formatDuration(movie.durationMs),
    movie.width !== null && movie.height !== null
      ? `${movie.width}×${movie.height}`
      : null,
    movie.videoCodec,
    movie.container ? movie.container.toUpperCase() : null,
  ].filter((part): part is string => part !== null);

  return (
    <section className="theater-page">
      <div className="theater-backdrop" aria-hidden="true">
        {movie.posterUrl ? (
          <img src={movie.posterUrl} alt="" />
        ) : (
          <div className="theater-backdrop-fallback" />
        )}
      </div>
      <div className="theater-scrim" aria-hidden="true" />

      <video
        ref={videoRef}
        className={`theater-video${phase === "playing" ? " theater-video-playing" : ""}`}
        playsInline
        preload="metadata"
        controls={phase === "playing"}
        onPlaying={() => setPlaybackError(null)}
        onError={onVideoError}
      />

      <Link className="theater-exit theater-exit-top" to="/">
        ← Library
      </Link>

      <div
        className={`theater-overlay${
          phase === "playing" && !playbackError ? " theater-overlay-hidden" : ""
        }`}
      >
        <h1 className="theater-title">{movie.title}</h1>
        {metadata.length > 0 && <p className="theater-meta">{metadata.join(" · ")}</p>}
        {movie.description && <p className="theater-description">{movie.description}</p>}

        <div className="theater-actions">
          <button
            type="button"
            className="theater-start"
            onClick={start}
            disabled={preparing}
          >
            {preparing ? "Preparing the stream…" : "▶ Start"}
          </button>
          <Link className="theater-exit" to="/">
            ← Back to the library
          </Link>
        </div>

        {playbackError && (
          <p className="theater-error" role="alert">
            {playbackError}
          </p>
        )}
      </div>
    </section>
  );
}
