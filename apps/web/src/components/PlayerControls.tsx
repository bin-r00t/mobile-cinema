/**
 * The controls of the player: the play and pause button, the seek bar with
 * the buffered ranges, the volume and the quality of the stream.
 */
import type { ReactNode } from "react";

/** One rendition of an HLS stream. */
export interface QualityLevel {
  /** The index of the level, as hls.js knows it. */
  index: number;
  /** The height of the level in pixels, or 0 when the stream does not say. */
  height: number;
  /** The bitrate of the level in bits per second. */
  bitrate: number;
}

/** A part of the movie that is already in the buffer. */
export interface BufferedRange {
  start: number;
  end: number;
}

export interface PlayerControlsProps {
  /** True while the movie is standing still. */
  paused: boolean;
  /** Where the playback is, in seconds. */
  currentTime: number;
  /** How long the movie is, in seconds. */
  duration: number;
  /** The parts of the movie that are already in the buffer. */
  buffered: readonly BufferedRange[];
  /** The volume of the sound, between 0 and 1. */
  volume: number;
  /** True while the sound is off. */
  muted: boolean;
  /** The renditions of the stream, empty when there is only one. */
  levels: readonly QualityLevel[];
  /** The rendition that is playing, or -1 when the stream decides. */
  currentLevel: number;
  /** Starts or stops the movie. */
  onTogglePlay: () => void;
  /** Jumps to a place in the movie, in seconds. */
  onSeek: (seconds: number) => void;
  /** Sets the volume of the sound, between 0 and 1. */
  onVolumeChange: (volume: number) => void;
  /** Turns the sound on or off. */
  onToggleMute: () => void;
  /** Picks the rendition of the stream, or -1 to let the stream decide. */
  onQualityChange: (level: number) => void;
  /** Leaves the player. */
  onExit?: () => void;
  /** Extra buttons of the bar, sat next to the quality of the stream. */
  children?: ReactNode;
}

/** The time of the movie as "1:02:03" or "2:03". */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const padded = rest < 10 ? `0${rest}` : `${rest}`;
  if (hours > 0) {
    const paddedMinutes = minutes < 10 ? `0${minutes}` : `${minutes}`;
    return `${hours}:${paddedMinutes}:${padded}`;
  }
  return `${minutes}:${padded}`;
}

/** The name of a rendition, as "720p" or by its bitrate when it has no height. */
export function formatLevel(level: QualityLevel): string {
  if (level.height > 0) return `${level.height}p`;
  if (level.bitrate > 0) return `${Math.round(level.bitrate / 1000)} kbps`;
  return `Level ${level.index}`;
}

export function PlayerControls({
  paused,
  currentTime,
  duration,
  buffered,
  volume,
  muted,
  levels,
  currentLevel,
  onTogglePlay,
  onSeek,
  onVolumeChange,
  onToggleMute,
  onQualityChange,
  onExit,
  children,
}: PlayerControlsProps) {
  const span = duration > 0 ? duration : 0;
  const percent = (value: number) => (span > 0 ? Math.min(100, (value / span) * 100) : 0);

  return (
    <div className="player-controls">
      <button
        type="button"
        className="player-button"
        onClick={onTogglePlay}
        aria-label={paused ? "Play" : "Pause"}
      >
        {paused ? "▶" : "❚❚"}
      </button>

      <span className="player-time">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>

      <div className="player-seek">
        <div className="player-seek-track" aria-hidden="true">
          {buffered.map((range) => (
            <span
              key={`${range.start}-${range.end}`}
              className="player-seek-buffered"
              style={{
                left: `${percent(range.start)}%`,
                width: `${percent(range.end - range.start)}%`,
              }}
            />
          ))}
          <span
            className="player-seek-played"
            style={{ width: `${percent(currentTime)}%` }}
          />
        </div>
        <input
          type="range"
          className="player-seek-input"
          min={0}
          max={span || 0}
          step={0.1}
          value={Math.min(currentTime, span || 0)}
          onChange={(event) => onSeek(Number(event.target.value))}
          aria-label="Seek"
        />
      </div>

      <button
        type="button"
        className="player-button"
        onClick={onToggleMute}
        aria-label={muted ? "Unmute" : "Mute"}
        aria-pressed={muted}
      >
        {muted || volume === 0 ? "🔇" : "🔊"}
      </button>
      <input
        type="range"
        className="player-volume"
        min={0}
        max={1}
        step={0.05}
        value={muted ? 0 : volume}
        onChange={(event) => onVolumeChange(Number(event.target.value))}
        aria-label="Volume"
      />

      {levels.length > 0 && (
        <select
          className="player-quality"
          value={currentLevel}
          onChange={(event) => onQualityChange(Number(event.target.value))}
          aria-label="Quality"
        >
          <option value={-1}>Auto</option>
          {levels.map((level) => (
            <option key={level.index} value={level.index}>
              {formatLevel(level)}
            </option>
          ))}
        </select>
      )}

      {children}

      {onExit && (
        <button
          type="button"
          className="player-button"
          onClick={onExit}
          aria-label="Leave the theater"
        >
          ✕
        </button>
      )}
    </div>
  );
}
