/**
 * The overlay of the subtitles: the cue that is spoken now, drawn over the
 * movie.
 *
 * The WebVTT track is fetched and read here instead of being handed to the
 * video element as a <track>: the browser decides how a native track is
 * drawn, and it cannot shift the timing of its cues. The overlay draws its
 * own text, so its size and its timing offset are the player's to command,
 * and the text stays legible over bright scenes (a dark plate under the
 * text and an outline around it).
 */
import { useEffect, useState } from "react";

import type { SubtitleTrack } from "./ScriptTab";

/** How big the subtitles are drawn. */
export type SubtitleSize = "small" | "medium" | "large";

/** One cue of a subtitle: the text, and when it is spoken. */
export interface SubtitleCue {
  /** Where the cue starts, in seconds. */
  start: number;
  /** Where the cue ends, in seconds. */
  end: number;
  /** What is spoken, lines kept as they are in the file. */
  text: string;
}

/**
 * Reads a timestamp of a WebVTT file, "00:01:23.456" or "01:23,456", as
 * seconds. The hours may be left out; a comma in place of the dot is
 * accepted, the way the files of SubRip sometimes arrive.
 */
export function parseTimestamp(value: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number((match[4] ?? "0").padEnd(3, "0"));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/** The timing line of a cue: "start --> end", plus the settings behind it. */
const CUE_TIMING_PATTERN = /^(\d[\d:.]*)[ \t]*-->[ \t]*(\d[\d:.]*)/;

/**
 * Turns a WebVTT file into cues.
 *
 * The header, the NOTE and STYLE blocks and the identifier of a cue are
 * dropped; only the timing and the text survive. The tags of the text
 * (the italics of <i>, the classes of <c>) are stripped: the overlay does
 * its own styling.
 */
export function parseVttCues(vtt: string): SubtitleCue[] {
  const lines = vtt.replace(/\r\n/g, "\n").split("\n");
  const cues: SubtitleCue[] = [];
  let index = 0;

  while (index < lines.length) {
    const timing = CUE_TIMING_PATTERN.exec((lines[index] ?? "").trim());
    if (!timing) {
      index += 1;
      continue;
    }
    const start = parseTimestamp(timing[1] ?? "");
    const end = parseTimestamp(timing[2] ?? "");
    index += 1;

    const textLines: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() !== "") {
      textLines.push((lines[index] ?? "").replace(/<[^>]*>/g, ""));
      index += 1;
    }

    const text = textLines.join("\n").trim();
    if (start !== null && end !== null && text !== "") {
      cues.push({ start, end, text });
    }
  }

  return cues;
}

/** The cue that is spoken at a moment, or null between two cues. */
export function findActiveCue(
  cues: readonly SubtitleCue[],
  seconds: number,
): SubtitleCue | null {
  for (const cue of cues) {
    if (seconds >= cue.start && seconds < cue.end) return cue;
  }
  return null;
}

export interface SubtitleOverlayProps {
  /** The track the subtitles come from, or null while they are off. */
  track: SubtitleTrack | null;
  /** Where the playback is, in seconds. */
  currentTime: number;
  /** How far the subtitles are shifted, in milliseconds. Positive is later. */
  offsetMs: number;
  /** How big the subtitles are drawn. */
  size: SubtitleSize;
}

export function SubtitleOverlay({
  track,
  currentTime,
  offsetMs,
  size,
}: SubtitleOverlayProps) {
  const [cues, setCues] = useState<SubtitleCue[]>([]);

  const trackId = track?.id ?? null;
  const trackUrl = track?.vttUrl ?? null;

  // The WebVTT of the track, read again when another track is picked. A
  // track that cannot be read leaves the subtitles off: the movie goes on.
  useEffect(() => {
    setCues([]);
    if (!trackUrl) return;
    let cancelled = false;
    fetch(trackUrl)
      .then((response) => (response.ok ? response.text() : ""))
      .then((vtt) => {
        if (!cancelled) setCues(parseVttCues(vtt));
      })
      .catch(() => {
        if (!cancelled) setCues([]);
      });
    return () => {
      cancelled = true;
    };
  }, [trackId, trackUrl]);

  if (!track) return null;

  // A positive offset shows the subtitles later: the moment of the movie
  // is looked up as it was before the shift.
  const cue = findActiveCue(cues, currentTime - offsetMs / 1000);
  if (!cue) return null;

  return (
    <p className="subtitle-overlay" data-size={size} aria-live="off">
      <span className="subtitle-overlay-text">{cue.text}</span>
    </p>
  );
}
