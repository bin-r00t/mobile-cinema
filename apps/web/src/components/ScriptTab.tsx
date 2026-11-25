import { useEffect, useState } from "react";

export interface SubtitleTrack {
  id: number;
  language: string | null;
  isPrimary: boolean;
  vttUrl: string | null;
}

interface Cue {
  start: string;
  end: string;
  text: string;
}

type ScriptState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; cues: Cue[] };

const TIMING_PATTERN = /^(\d{2}:\d{2}:\d{2}[.,]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[.,]\d{3})/;

/**
 * Turns a WebVTT file into cues. Cue numbers, NOTE blocks and styling
 * blocks are dropped; only the timing and the spoken text survive.
 */
function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  const lines = vtt.replace(/\r\n/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const timing = TIMING_PATTERN.exec(line.trim());
    if (!timing) {
      index += 1;
      continue;
    }

    index += 1;
    const textLines: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() !== "") {
      textLines.push((lines[index] ?? "").trim());
      index += 1;
    }
    index += 1;

    const text = textLines.join(" ").trim();
    if (text.length > 0) {
      cues.push({ start: timing[1] ?? "", end: timing[2] ?? "", text });
    }
  }

  return cues;
}

/** "00:01:23.456" reads as "1:23" in the script list. */
function formatCueTime(timestamp: string): string {
  const [hours = "0", minutes = "0", rest = "0"] = timestamp.split(":");
  const seconds = rest.split(/[.,]/)[0] ?? "0";
  const totalMinutes = Number(hours) * 60 + Number(minutes);
  return `${totalMinutes}:${seconds.padStart(2, "0")}`;
}

function trackLabel(track: SubtitleTrack): string {
  const language = track.language ?? "Unknown";
  return track.isPrimary ? `${language} (primary)` : language;
}

export function ScriptTab({ subtitles }: { subtitles: SubtitleTrack[] }) {
  const tracks = subtitles.filter((track) => track.vttUrl !== null);
  const defaultTrack =
    tracks.find((track) => track.isPrimary) ?? tracks[0] ?? null;
  const [selectedId, setSelectedId] = useState<number | null>(
    defaultTrack?.id ?? null,
  );
  const [state, setState] = useState<ScriptState>({ status: "idle" });

  const selected = tracks.find((track) => track.id === selectedId) ?? defaultTrack;

  useEffect(() => {
    if (!selected?.vttUrl) {
      setState({ status: "idle" });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    fetch(selected.vttUrl)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`The server answered ${response.status}`);
        }
        return response.text();
      })
      .then((vtt) => {
        if (!cancelled) setState({ status: "ready", cues: parseVtt(vtt) });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message:
              error instanceof Error ? error.message : "The script could not be loaded",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selected?.vttUrl]);

  if (subtitles.length === 0) {
    return <p className="muted">This movie has no subtitle tracks yet.</p>;
  }
  if (tracks.length === 0) {
    return (
      <p className="muted">
        The subtitle tracks of this movie have no script to show yet.
      </p>
    );
  }

  return (
    <div className="script-tab">
      {tracks.length > 1 && (
        <div className="script-track-picker" role="tablist" aria-label="Subtitle track">
          {tracks.map((track) => (
            <button
              key={track.id}
              type="button"
              className={
                track.id === selected?.id ? "script-track active" : "script-track"
              }
              onClick={() => setSelectedId(track.id)}
            >
              {trackLabel(track)}
            </button>
          ))}
        </div>
      )}

      {state.status === "loading" && <p className="muted">Loading the script…</p>}
      {state.status === "error" && (
        <p className="muted">The script is not available: {state.message}</p>
      )}
      {state.status === "ready" && state.cues.length === 0 && (
        <p className="muted">The script of this track is empty.</p>
      )}
      {state.status === "ready" && state.cues.length > 0 && (
        <ol className="script-cues">
          {state.cues.map((cue, cueIndex) => (
            <li key={cueIndex} className="script-cue">
              <span className="script-cue-time">{formatCueTime(cue.start)}</span>
              <span className="script-cue-text">{cue.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
