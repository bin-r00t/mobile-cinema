import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getProgress } from "../api/progress";
import { pickResumePosition } from "../lib/progress";

/** How a movie is shown to go on: the minutes and the seconds of the position. */
function formatClock(positionMs: number): string {
  const totalSeconds = Math.round(positionMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

interface ResumePromptProps {
  /** The movie the prompt belongs to. */
  movieId: number;
  /** How long the movie is, in milliseconds; null when the catalog is silent. */
  durationMs: number | null;
}

/**
 * The continue-watching prompt of the detail page.
 *
 * When the server holds a position for the movie that is worth coming back
 * to — neither the first seconds nor the last ones — the prompt shows where
 * the movie was left and links into the theater, which picks the movie up
 * from there. Nothing is shown for a movie that was never played.
 */
export function ResumePrompt({ movieId, durationMs }: ResumePromptProps) {
  const [positionMs, setPositionMs] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPositionMs(null);

    getProgress(movieId)
      .then((entry) => {
        if (cancelled) return;
        setPositionMs(
          entry === null
            ? null
            : pickResumePosition(entry.positionMs, durationMs ?? Number.NaN),
        );
      })
      .catch(() => {
        // A server that does not answer takes the prompt with it, not the page.
        if (!cancelled) setPositionMs(null);
      });

    return () => {
      cancelled = true;
    };
  }, [durationMs, movieId]);

  if (positionMs === null) return null;

  return (
    <p className="resume-prompt">
      <Link className="resume-prompt-button" to={`/theater/${movieId}`}>
        ▶ Resume at {formatClock(positionMs)}
      </Link>
    </p>
  );
}
