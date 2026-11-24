/**
 * A WebVTT parser that follows the rules a browser applies.
 *
 * The player hands the file to the browser, so the only proof that a
 * converted subtitle really works is that a browser-grade parser reads it.
 * This parser mirrors the parsing algorithm of the WebVTT specification:
 * the signature, the block structure, the timing line and the cue text.
 * It is deliberately strict — a file it accepts is a file a browser accepts.
 */

export interface VttCue {
  /** The optional identifier that precedes the timing line. */
  identifier: string | null;
  /** Start of the cue in milliseconds. */
  startMs: number;
  /** End of the cue in milliseconds. */
  endMs: number;
  /** The text of the cue, with its line breaks. */
  text: string;
}

export interface VttParseResult {
  cues: VttCue[];
  /** The reasons why a block was not accepted. */
  errors: string[];
}

const TIMESTAMP = /(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})/;

function parseTimestamp(raw: string): number | null {
  const match = TIMESTAMP.exec(raw.trim());
  if (!match) return null;

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4]);
  if (minutes > 59 || seconds > 59) return null;

  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

/**
 * Parses a WebVTT file the way a browser does and reports what could not
 * be read.
 */
export function parseWebVtt(input: string): VttParseResult {
  const cues: VttCue[] = [];
  const errors: string[] = [];

  const body = input.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = body.split("\n");

  if (!/^WEBVTT([ \t].*)?$/.test(lines[0] ?? "")) {
    return { cues, errors: ["the file does not start with the WEBVTT signature"] };
  }

  let index = 1;
  // The header may be followed by a header block; skip the lines until the
  // first blank line.
  while (index < lines.length && lines[index]!.trim() !== "") {
    index++;
  }
  index++;

  while (index < lines.length) {
    // Skip the blank lines between the blocks.
    while (index < lines.length && lines[index]!.trim() === "") index++;
    if (index >= lines.length) break;

    const block: string[] = [];
    while (index < lines.length && lines[index]!.trim() !== "") {
      block.push(lines[index]!);
      index++;
    }

    const timingIndex = block.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) {
      errors.push(`a block without a timing line was ignored: ${block[0]}`);
      continue;
    }

    const [left, right] = block[timingIndex]!.split("-->");
    if (left === undefined || right === undefined) {
      errors.push("a timing line without a start and an end was ignored");
      continue;
    }

    const startMs = parseTimestamp(left);
    const endMs = parseTimestamp(right.trim().split(/\s+/)[0] ?? "");
    if (startMs === null || endMs === null) {
      errors.push(
        `a block with an invalid timestamp was ignored: ${block[timingIndex]}`,
      );
      continue;
    }
    if (endMs < startMs) {
      errors.push(
        `a block that ends before it starts was ignored: ${block[timingIndex]}`,
      );
      continue;
    }

    const identifier = timingIndex > 0 ? block[timingIndex - 1]! : null;
    const text = block.slice(timingIndex + 1).join("\n");

    cues.push({ identifier, startMs, endMs, text });
  }

  return { cues, errors };
}
