/**
 * Translation of subtitle files into WebVTT.
 *
 * The player only speaks WebVTT, so SRT and ASS are converted here. The
 * parsers are forgiving on purpose: a single broken cue is skipped instead
 * of failing the whole file, because one damaged subtitle must not break a
 * scan. A file that yields no cue at all is an error — there is nothing to
 * play.
 */

export type SubtitleFormat = "srt" | "ass" | "vtt";

/** Thrown when a subtitle holds nothing that can be turned into cues. */
export class SubtitleParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubtitleParseError";
  }
}

interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

/** The default columns of an ASS `[Events]` section. */
const ASS_DEFAULT_FIELDS = [
  "Layer",
  "Start",
  "End",
  "Style",
  "Name",
  "MarginL",
  "MarginR",
  "MarginV",
  "Effect",
  "Text",
];

/** Tag markers in a subtitle file that carry no meaning for the player. */
const STYLE_TAG = /\{[^}]*\}/g;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Renders a millisecond offset as the `HH:MM:SS.mmm` form WebVTT wants. */
export function formatVttTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const millis = total % 1000;
  const totalSeconds = (total - millis) / 1000;
  const seconds = totalSeconds % 60;
  const totalMinutes = (totalSeconds - seconds) / 60;
  const minutes = totalMinutes % 60;
  const hours = (totalMinutes - minutes) / 60;

  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

/**
 * Parses a timestamp of the shape `hh:mm:ss,mmm`, `mm:ss.mmm` or the ASS
 * flavour `h:mm:ss.cc`. Returns null when the text is not a timestamp.
 */
export function parseTimestamp(raw: string): number | null {
  const text = raw.trim();
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/.exec(text);
  if (!match) return null;

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  // The last group is milliseconds in SRT and centiseconds in ASS.
  const fraction = Number(match[4]);
  const millis = text.includes(".") && match[4]!.length <= 2 ? fraction * 10 : fraction;

  if (minutes > 59 || seconds > 59) return null;

  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

/** Strips the style markers that only mean something to the original tool. */
function cleanCueText(text: string): string {
  return text
    .replace(STYLE_TAG, "")
    .replace(/\\N|\\n/g, "\n")
    .replace(/\\h/g, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/** Splits an SRT file into its blocks. */
function parseSrt(content: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = content.replace(/^\uFEFF/, "").split(/\r?\n\s*\r?\n/);

  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) continue;

    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) continue;

    const [left, right] = lines[timingIndex]!.split("-->");
    if (left === undefined || right === undefined) continue;

    const startMs = parseTimestamp(left);
    const endMs = parseTimestamp(right.trim().split(/\s+/)[0] ?? "");
    if (startMs === null || endMs === null || endMs < startMs) continue;

    const text = cleanCueText(lines.slice(timingIndex + 1).join("\n"));
    if (text.length === 0) continue;

    cues.push({ startMs, endMs, text });
  }

  return cues;
}

/** Splits the body of an ASS `Dialogue:` line into its columns. */
function splitAssFields(body: string, columnCount: number): string[] {
  const parts = body.split(",");
  if (parts.length <= columnCount) return parts.map((part) => part.trim());

  // The text column is last and may itself contain commas.
  const head = parts.slice(0, columnCount - 1).map((part) => part.trim());
  const tail = parts
    .slice(columnCount - 1)
    .join(",")
    .trim();
  return [...head, tail];
}

/** Parses an ASS file into its cues. */
function parseAss(content: string): Cue[] {
  const cues: Cue[] = [];
  let inEvents = false;
  let fields = ASS_DEFAULT_FIELDS;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inEvents = /^\[events\]$/i.test(trimmed);
      continue;
    }
    if (!inEvents) continue;

    if (/^format\s*:/i.test(trimmed)) {
      fields = trimmed
        .slice(trimmed.indexOf(":") + 1)
        .split(",")
        .map((field) => field.trim());
      continue;
    }
    if (!/^dialogue\s*:/i.test(trimmed)) continue;

    const columns = splitAssFields(
      trimmed.slice(trimmed.indexOf(":") + 1),
      fields.length,
    );

    const startIndex = Math.max(
      0,
      fields.findIndex((f) => f === "Start"),
    );
    const endIndex = Math.max(
      0,
      fields.findIndex((f) => f === "End"),
    );
    const textIndex = Math.max(
      0,
      fields.findIndex((f) => f === "Text"),
    );

    const startMs = parseTimestamp(columns[startIndex] ?? "");
    const endMs = parseTimestamp(columns[endIndex] ?? "");
    if (startMs === null || endMs === null || endMs < startMs) continue;

    const text = cleanCueText(columns[textIndex] ?? "");
    if (text.length === 0) continue;

    cues.push({ startMs, endMs, text });
  }

  return cues;
}

/** Checks that a WebVTT file starts with the signature it must start with. */
function parseVtt(content: string): string {
  const body = content.replace(/^\uFEFF/, "").trim();
  if (body.length === 0) {
    throw new SubtitleParseError("the file is empty");
  }
  if (!/^WEBVTT([ \t].*)?$/.test(body.split(/\r?\n/, 1)[0] ?? "")) {
    throw new SubtitleParseError("the file has no WEBVTT signature");
  }
  return body.endsWith("\n") ? body : `${body}\n`;
}

/**
 * Converts the content of a subtitle file into WebVTT.
 *
 * Throws a {@link SubtitleParseError} when nothing usable can be read from
 * the file; individual broken cues are skipped.
 */
export function toVtt(content: string, format: SubtitleFormat): string {
  if (format === "vtt") {
    return parseVtt(content);
  }

  const cues = format === "ass" ? parseAss(content) : parseSrt(content);
  if (cues.length === 0) {
    throw new SubtitleParseError(`no cue could be read from the ${format} file`);
  }

  const blocks = cues.map(
    (cue) =>
      `${formatVttTimestamp(cue.startMs)} --> ${formatVttTimestamp(cue.endMs)}\n${cue.text}`,
  );

  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}
