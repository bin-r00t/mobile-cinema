/**
 * The settings of the subtitles: the button of the controls bar, and the
 * panel behind it.
 *
 * The button turns the subtitles on and off; the panel picks the track,
 * sets the size and nudges the timing. Every change is a change of state
 * in the player, so it takes effect at once — nothing is reloaded.
 */
import { useState } from "react";

import type { SubtitleTrack } from "./ScriptTab";
import type { SubtitleSize } from "./SubtitleOverlay";

/** How far one nudge of the timing shifts the subtitles, in milliseconds. */
const OFFSET_STEP_MS = 500;

/** How far the timing may be shifted, in either direction. */
const OFFSET_LIMIT_MS = 10000;

/** The sizes the subtitles come in, as the panel offers them. */
const SIZES: readonly SubtitleSize[] = ["small", "medium", "large"];

/** The name of a track, as the panel shows it in the list. */
function trackLabel(track: SubtitleTrack): string {
  const language = track.language ?? "Unknown";
  return track.isPrimary ? `${language} (primary)` : language;
}

/** The timing as "+1.5s", "−0.5s" or "0s". */
export function formatOffset(offsetMs: number): string {
  const seconds = Math.round(offsetMs / 100) / 10;
  if (seconds === 0) return "0s";
  return `${seconds > 0 ? "+" : "−"}${Math.abs(seconds)}s`;
}

export interface SubtitleSettingsProps {
  /** The tracks the movie has, already the ones with a WebVTT file. */
  tracks: readonly SubtitleTrack[];
  /** True while the subtitles are on. */
  enabled: boolean;
  /** The track that is picked, as its id. */
  trackId: number | null;
  /** How big the subtitles are drawn. */
  size: SubtitleSize;
  /** How far the subtitles are shifted, in milliseconds. */
  offsetMs: number;
  /** Turns the subtitles on or off. */
  onEnabledChange: (enabled: boolean) => void;
  /** Picks a track, as its id. */
  onTrackChange: (trackId: number) => void;
  /** Sets the size of the subtitles. */
  onSizeChange: (size: SubtitleSize) => void;
  /** Sets the timing of the subtitles, in milliseconds. */
  onOffsetChange: (offsetMs: number) => void;
}

export function SubtitleSettings({
  tracks,
  enabled,
  trackId,
  size,
  offsetMs,
  onEnabledChange,
  onTrackChange,
  onSizeChange,
  onOffsetChange,
}: SubtitleSettingsProps) {
  const [open, setOpen] = useState(false);

  const nudgeOffset = (direction: 1 | -1) => {
    const next = offsetMs + direction * OFFSET_STEP_MS;
    onOffsetChange(Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, next)));
  };

  return (
    <div className="subtitle-settings">
      <button
        type="button"
        className="player-button subtitle-settings-cc"
        onClick={() => onEnabledChange(!enabled)}
        aria-pressed={enabled}
        aria-label="Subtitles"
        title="Subtitles"
      >
        CC
      </button>
      <button
        type="button"
        className="player-button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label="Subtitle options"
        title="Subtitle options"
      >
        ⚙
      </button>

      {open && (
        <div
          className="subtitle-settings-panel"
          role="group"
          aria-label="Subtitle options"
        >
          {tracks.length > 1 && (
            <label className="subtitle-settings-row">
              <span className="subtitle-settings-label">Track</span>
              <select
                className="subtitle-settings-select"
                value={trackId ?? -1}
                onChange={(event) => onTrackChange(Number(event.target.value))}
                aria-label="Subtitle track"
              >
                {tracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {trackLabel(track)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="subtitle-settings-row">
            <span className="subtitle-settings-label">Size</span>
            <span className="subtitle-settings-sizes">
              {SIZES.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  className="subtitle-settings-button"
                  onClick={() => onSizeChange(candidate)}
                  aria-pressed={size === candidate}
                >
                  {candidate === "small" ? "S" : candidate === "medium" ? "M" : "L"}
                </button>
              ))}
            </span>
          </div>

          <div className="subtitle-settings-row">
            <span className="subtitle-settings-label">Timing</span>
            <span className="subtitle-settings-timing">
              <button
                type="button"
                className="subtitle-settings-button"
                onClick={() => nudgeOffset(-1)}
                aria-label="Show the subtitles 0.5 seconds earlier"
              >
                −0.5s
              </button>
              <span className="subtitle-settings-value">{formatOffset(offsetMs)}</span>
              <button
                type="button"
                className="subtitle-settings-button"
                onClick={() => nudgeOffset(1)}
                aria-label="Show the subtitles 0.5 seconds later"
              >
                +0.5s
              </button>
              <button
                type="button"
                className="subtitle-settings-button"
                onClick={() => onOffsetChange(0)}
                disabled={offsetMs === 0}
                aria-label="Reset the timing of the subtitles"
              >
                0
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
