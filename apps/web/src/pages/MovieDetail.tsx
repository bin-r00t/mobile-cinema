import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ResumePrompt } from "../components/ResumePrompt";
import { ScriptTab, type SubtitleTrack } from "../components/ScriptTab";

interface Movie {
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
  playbackModes: string[];
  subtitles: SubtitleTrack[];
}

type DetailState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; movie: Movie };

function formatRuntime(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  const totalMinutes = Math.round(durationMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatSize(sizeBytes: number | null): string | null {
  if (sizeBytes === null) return null;
  const gibibytes = sizeBytes / 1024 ** 3;
  if (gibibytes >= 1) return `${gibibytes.toFixed(1)} GB`;
  return `${Math.round(sizeBytes / 1024 ** 2)} MB`;
}

function formatResolution(movie: Movie): string | null {
  if (movie.width === null || movie.height === null) return null;
  return `${movie.width}×${movie.height}`;
}

export function MovieDetail() {
  const { id } = useParams();
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [tab, setTab] = useState<"overview" | "script">("overview");

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
        return response.json() as Promise<{ movie: Movie }>;
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

  if (state.status === "loading") {
    return (
      <section className="page page-detail">
        <p className="muted">Loading the movie…</p>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="page page-detail">
        <h1>Movie</h1>
        <p className="muted">{state.message}</p>
        <p>
          <Link to="/">Back to the library</Link>
        </p>
      </section>
    );
  }

  const { movie } = state;
  const metadata = [
    movie.year !== null ? String(movie.year) : null,
    formatRuntime(movie.durationMs),
    formatResolution(movie),
    movie.videoCodec,
    movie.container ? movie.container.toUpperCase() : null,
    formatSize(movie.sizeBytes),
  ].filter((part): part is string => part !== null);

  return (
    <section className="page page-detail">
      <div className="detail-hero">
        <figure className="detail-poster">
          {movie.posterUrl ? (
            <img src={movie.posterUrl} alt={`Poster of ${movie.title}`} />
          ) : (
            <div className="detail-poster-placeholder muted">No poster</div>
          )}
        </figure>

        <div className="detail-info">
          <h1>{movie.title}</h1>
          {metadata.length > 0 && (
            <p className="detail-meta muted">{metadata.join(" · ")}</p>
          )}

          {movie.subtitles.length > 0 && (
            <ul className="detail-subtitles" aria-label="Subtitle tracks">
              {movie.subtitles.map((track) => (
                <li key={track.id} className="detail-subtitle">
                  {track.language ?? "Unknown"}
                  {track.isPrimary && <span className="badge">primary</span>}
                </li>
              ))}
            </ul>
          )}

          <p>
            <Link className="play-button" to={`/theater/${movie.id}`}>
              ▶ Play
            </Link>
          </p>

          <ResumePrompt movieId={movie.id} durationMs={movie.durationMs} />
        </div>
      </div>

      <div className="detail-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "overview"}
          className={tab === "overview" ? "detail-tab active" : "detail-tab"}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "script"}
          className={tab === "script" ? "detail-tab active" : "detail-tab"}
          onClick={() => setTab("script")}
        >
          Script
        </button>
      </div>

      <div className="detail-tab-panel">
        {tab === "overview" &&
          (movie.description ? (
            <p className="detail-description">{movie.description}</p>
          ) : (
            <p className="muted">There is no description for this movie yet.</p>
          ))}
        {tab === "script" && <ScriptTab subtitles={movie.subtitles} />}
      </div>
    </section>
  );
}
