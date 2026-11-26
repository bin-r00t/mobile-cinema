import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { Player, type PlayerHandle } from "../components/Player";
import type { SubtitleTrack } from "../components/ScriptTab";
import { getProgress } from "../api/progress";
import { formatDuration, formatYear } from "../lib/format";
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
  subtitles: SubtitleTrack[];
}

type TheaterState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; movie: TheaterMovie };

/** What the page shows at the moment: the entrance or the movie. */
type Phase = "intro" | "playing";

export function Theater() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<TheaterState>({ status: "loading" });
  const [phase, setPhase] = useState<Phase>("intro");
  /** Where the movie was left the last time it played, as the server knows. */
  const [startAtMs, setStartAtMs] = useState<number | null>(null);
  const playerRef = useRef<PlayerHandle>(null);

  // The media of the player is kept as it is, so that the player does not
  // take the movie apart again on every render. The hooks are called
  // before the movie is known, so that their order never changes.
  const movie = state.status === "ready" ? state.movie : null;
  const playerMedia = useMemo(
    () =>
      movie
        ? {
            id: movie.id,
            title: movie.title,
            streamUrl: movie.streamUrl,
            hlsUrl: movie.hlsUrl,
            subtitles: movie.subtitles,
          }
        : null,
    [movie],
  );

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setStartAtMs(null);

    // The position is asked for next to the movie; a movie without one, or
    // an answer that never comes, starts the movie at the beginning.
    const progress = getProgress(Number(id))
      .then((entry) => (entry === null ? null : entry.positionMs))
      .catch(() => null);

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
      .then(async ({ movie }) => {
        if (cancelled) return;
        setState({ status: "ready", movie });
        setStartAtMs(await progress);
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
  // movie is the whole screen, and the keyboard is the fastest way out of
  // it. Once the movie is up, its player owns the keys, the escape among
  // them — listening twice would walk out of the theater twice.
  const ready = state.status === "ready";
  useEffect(() => {
    if (ready) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") navigate("/");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, ready]);

  /**
   * Starts the movie.
   *
   * The call to play() happens inside the click, so the browser sees the
   * gesture of the user and lets the movie start: without it the browser
   * refuses to play and the page would only show an autoplay error.
   */
  const start = () => {
    setPhase("playing");
    playerRef.current?.play();
  };

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

  const { movie: readyMovie } = state;
  const metadata = [
    formatYear(readyMovie.year),
    formatDuration(readyMovie.durationMs),
    readyMovie.width !== null && readyMovie.height !== null
      ? `${readyMovie.width}×${readyMovie.height}`
      : null,
    readyMovie.videoCodec,
    readyMovie.container ? readyMovie.container.toUpperCase() : null,
  ].filter((part): part is string => part !== null);

  return (
    <section className="theater-page">
      <div className="theater-backdrop" aria-hidden="true">
        {readyMovie.posterUrl ? (
          <img src={readyMovie.posterUrl} alt="" />
        ) : (
          <div className="theater-backdrop-fallback" />
        )}
      </div>
      <div className="theater-scrim" aria-hidden="true" />

      <div className={`theater-player${phase === "intro" ? " theater-player-hidden" : ""}`}>
        <Player
          ref={playerRef}
          startAtMs={startAtMs}
          media={playerMedia ?? {
            id: 0,
            title: "",
            streamUrl: null,
            hlsUrl: null,
            subtitles: [],
          }}
          onExit={() => navigate("/")}
        />
      </div>

      <Link className="theater-exit theater-exit-top" to="/">
        ← Library
      </Link>

      <div
        className={`theater-overlay${
          phase === "playing" ? " theater-overlay-hidden" : ""
        }`}
      >
        <h1 className="theater-title">{readyMovie.title}</h1>
        {metadata.length > 0 && <p className="theater-meta">{metadata.join(" · ")}</p>}
        {readyMovie.description && (
          <p className="theater-description">{readyMovie.description}</p>
        )}

        <div className="theater-actions">
          <button type="button" className="theater-start" onClick={start}>
            ▶ Start
          </button>
          <Link className="theater-exit" to="/">
            ← Back to the library
          </Link>
        </div>
      </div>
    </section>
  );
}
