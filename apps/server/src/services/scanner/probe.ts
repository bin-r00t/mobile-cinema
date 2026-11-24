import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** What ffprobe knows about one media file. Every field is null when unknown. */
export interface ProbeResult {
  /** Duration in milliseconds. */
  durationMs: number | null;
  width: number | null;
  height: number | null;
  /** Codec of the first video stream, e.g. "h264". */
  videoCodec: string | null;
  /** Container format name reported by ffprobe, e.g. "matroska,webm". */
  container: string | null;
  /** Embedded title tag, when the container carries one. */
  tagTitle: string | null;
  /** Embedded plot or description tag, when the container carries one. */
  tagPlot: string | null;
  /** Problems hit while probing. A scan records these instead of failing. */
  warnings: string[];
}

export interface ProbeOptions {
  /** ffprobe binary to run. Defaults to "ffprobe" from PATH. */
  ffprobePath?: string;
}

interface FfprobeOutput {
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }[];
  format?: {
    format_name?: string;
    duration?: string;
    tags?: Record<string, string>;
  };
}

function emptyResult(warning: string): ProbeResult {
  return {
    durationMs: null,
    width: null,
    height: null,
    videoCodec: null,
    container: null,
    tagTitle: null,
    tagPlot: null,
    warnings: [warning],
  };
}

function parseDurationMs(duration: string | undefined): number | null {
  if (duration === undefined) return null;
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

/**
 * Probes one media file with ffprobe.
 *
 * Never throws: a missing ffprobe binary or an unreadable file yields a
 * result with every field null and the problem recorded in `warnings`, so a
 * scan can go on with the rest of the library.
 */
export async function probeMediaFile(
  path: string,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const ffprobe = options.ffprobePath ?? "ffprobe";

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      ffprobe,
      [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        path,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyResult(`ffprobe not found (${ffprobe}); is ffmpeg installed?`);
    }
    const stderr = (err as { stderr?: string }).stderr?.trim();
    return emptyResult(
      `ffprobe failed for ${path}: ${stderr || (err as Error).message}`,
    );
  }

  let output: FfprobeOutput;
  try {
    output = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    return emptyResult(`ffprobe returned invalid JSON for ${path}`);
  }

  const video = output.streams?.find((s) => s.codec_type === "video");
  const tags = output.format?.tags ?? {};
  const warnings: string[] = [];
  const durationMs = parseDurationMs(output.format?.duration);
  if (durationMs === null) {
    warnings.push(`ffprobe reported no duration for ${path}`);
  }

  return {
    durationMs,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    container: output.format?.format_name ?? null,
    tagTitle: tags.title ?? null,
    tagPlot: tags.plot ?? tags.description ?? tags.comment ?? tags.synopsis ?? null,
    warnings,
  };
}
