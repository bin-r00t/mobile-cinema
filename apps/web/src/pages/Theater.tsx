import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { Player, type PlayerHandle } from "../components/Player";
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
  const playerRef = useRef<PlayerHandle>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

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

  const { movie } = state;
  // The media of the player is kept as it is, so that the player does not
  // take the movie apart again on every render.
  const playerMedia = useMemo(
    () => ({
      id: movie.id,
      title: movie.title,
      streamUrl: movie.streamUrl,
      hlsUrl: movie.hlsUrl,
    }),
    [movie.id, movie.title, movie.streamUrl, movie.hlsUrl],
  );
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

      <div className={`theater-player${phase === "intro" ? " theater-player-hidden" : ""}`}>
        <Player
          ref={playerRef}
          media={playerMedia}
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
        <h1 className="theater-title">{movie.title}</h1>
        {metadata.length > 0 && <p className="theater-meta">{metadata.join(" · ")}</p>}
        {movie.description && <p className="theater-description">{movie.description}</p>}

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
