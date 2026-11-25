/**
 * The HLS pipeline: a movie that a browser cannot play itself is
 * transcoded into HLS segments, and the result is kept on disk so the next
 * player only has to read the playlist.
 *
 * The cache is keyed by the file itself: when the movie on disk has not
 * changed, the segments that are already there are reused.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Db } from "../../db/client.ts";
import { probeMediaFile } from "../scanner/probe.ts";
import { resolveMediaPath } from "../pathSafety.ts";

const execFileAsync = promisify(execFile);

export type HlsErrorCode =
  /** The movie is not in the catalog. */
  | "NOT_FOUND"
  /** ffmpeg is missing or the transcode failed. */
  | "TRANSCODE_FAILED";

/** The error the pipeline raises when it cannot deliver. */
export class HlsError extends Error {
  readonly code: HlsErrorCode;

  constructor(code: HlsErrorCode, message: string) {
    super(message);
    this.name = "HlsError";
    this.code = code;
  }
}

export interface RenditionSpec {
  /** The name of the rendition, e.g. "720p". */
  name: string;
  /** The height of the rendition in pixels. */
  height: number;
  /** The bandwidth of the rendition in bits per second. */
  bandwidth: number;
}

/** The renditions the player can choose from. */
export const DEFAULT_RENDITIONS: readonly RenditionSpec[] = [
  { name: "720p", height: 720, bandwidth: 2_500_000 },
  { name: "480p", height: 480, bandwidth: 1_200_000 },
];

export interface TranscodeOptions {
  /** The catalog the movie comes from. */
  db: Db;
  /** The directory that holds the movies — the equivalent of MOVIE_ROOT. */
  movieRoot: string;
  /** Where the transcoded files are cached. */
  cacheDir: string;
  /** The ffmpeg binary to run. Defaults to "ffmpeg" from PATH. */
  ffmpegPath?: string;
  /** The renditions to produce. Defaults to 720p and 480p. */
  renditions?: readonly RenditionSpec[];
}

export interface HlsRendition {
  /** The name of the rendition, e.g. "720p". */
  name: string;
  /** The height of the rendition in pixels. */
  height: number;
  /** The bandwidth of the rendition in bits per second. */
  bandwidth: number;
  /** The absolute path of the playlist of the rendition. */
  playlistPath: string;
  /** The resolution of the rendition, when it is known. */
  resolution: string | null;
}

export interface HlsCache {
  /** The catalog id of the movie. */
  mediaItemId: number;
  /** The directory that holds the cache of this movie. */
  directory: string;
  /** The absolute path of the master playlist. */
  masterPath: string;
  /** The renditions the master playlist points at. */
  renditions: HlsRendition[];
  /** True when the cache was reused instead of transcoded again. */
  cached: boolean;
}

interface CacheState {
  /** A fingerprint of the source file. */
  fingerprint: string;
  /** The renditions that were produced. */
  renditions: {
    name: string;
    height: number;
    bandwidth: number;
    resolution: string | null;
  }[];
}

/**
 * True for the containers a browser can play itself.
 *
 * ffprobe reports "mov,mp4,m4a,3gp,3g2,mj2" for an mp4 and "matroska,webm"
 * for a webm, so the container is looked at as a list.
 */
export function isWebFriendlyContainer(container: string | null): boolean {
  if (!container) return false;
  const formats = container.toLowerCase().split(",");
  return formats.some((format) => format === "mp4" || format === "webm");
}

/**
 * A fingerprint of the file: the same file keeps the same fingerprint, and
 * a file that changed gets another one.
 */
function fingerprint(path: string, size: number, mtimeMs: number): string {
  return createHash("sha1")
    .update(`${path}:${size}:${mtimeMs}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * The master playlist that ties the renditions together.
 */
export function masterPlaylist(
  renditions: readonly { name: string; bandwidth: number; resolution: string | null }[],
): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const rendition of renditions) {
    const attributes = [`BANDWIDTH=${rendition.bandwidth}`];
    if (rendition.resolution) {
      attributes.push(`RESOLUTION=${rendition.resolution}`);
    }
    lines.push(`#EXT-X-STREAM-INF:${attributes.join(",")}`);
    lines.push(`${rendition.name}/index.m3u8`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The resolution of a rendition: the source keeps its width, scaled to the
 * height of the rendition. The width is even, so the encoder is happy.
 */
function resolutionFor(
  sourceWidth: number | null,
  sourceHeight: number | null,
  height: number,
): string | null {
  if (!sourceWidth || !sourceHeight || sourceHeight <= 0) return null;
  // The video is never blown up, so a small source keeps its height.
  const effectiveHeight = Math.min(height, sourceHeight);
  const scaled = (sourceWidth * effectiveHeight) / sourceHeight;
  const width = Math.max(2, Math.round(scaled / 2) * 2);
  return `${width}x${effectiveHeight}`;
}

/**
 * Transcodes a movie into HLS segments, or reuses the segments that are
 * already cached.
 *
 * The cache belongs to the movie and lives in `CACHE_DIR/hls/<id>`. It is
 * valid as long as the file on disk has not changed; when it has, the cache
 * is thrown away and built again.
 */
export async function transcodeToHls(
  options: TranscodeOptions,
  mediaItemId: number,
): Promise<HlsCache> {
  const { db, movieRoot, cacheDir } = options;
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";
  const renditionSpecs = options.renditions ?? DEFAULT_RENDITIONS;

  const source = await resolveMediaPath({ db, movieRoot }, mediaItemId);
  const info = await stat(source);
  const stamp = fingerprint(source, info.size, info.mtimeMs);

  const directory = join(cacheDir, "hls", String(mediaItemId));
  const masterPath = join(directory, "master.m3u8");
  const statePath = join(directory, "state.json");

  const cached = await readCache(directory, masterPath, statePath, stamp);
  if (cached) {
    return { mediaItemId, directory, masterPath, renditions: cached, cached: true };
  }

  // The cache is worthless now: build it again from scratch.
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });

  const probe = await probeMediaFile(source);
  const renditions: HlsRendition[] = [];

  for (const spec of renditionSpecs) {
    const renditionDirectory = join(directory, spec.name);
    await mkdir(renditionDirectory, { recursive: true });
    const playlistPath = join(renditionDirectory, "index.m3u8");

    await runFfmpeg(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-i",
      source,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-vf",
      // The video is scaled to the height of the rendition, but never
      // blown up beyond what the source has.
      `scale=-2:min(${spec.height}\\,ih)`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-g",
      "48",
      "-keyint_min",
      "48",
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ac",
      "2",
      "-sn",
      "-hls_time",
      "4",
      "-hls_playlist_type",
      "vod",
      "-hls_flags",
      "independent_segments",
      "-hls_segment_filename",
      join(renditionDirectory, "segment_%05d.ts"),
      playlistPath,
    ]);

    renditions.push({
      name: spec.name,
      height: spec.height,
      bandwidth: spec.bandwidth,
      playlistPath,
      resolution: resolutionFor(probe.width, probe.height, spec.height),
    });
  }

  await writeFile(masterPath, masterPlaylist(renditions), "utf8");

  const state: CacheState = {
    fingerprint: stamp,
    renditions: renditions.map((rendition) => ({
      name: rendition.name,
      height: rendition.height,
      bandwidth: rendition.bandwidth,
      resolution: rendition.resolution,
    })),
  };
  await writeFile(statePath, JSON.stringify(state), "utf8");

  return { mediaItemId, directory, masterPath, renditions, cached: false };
}

/**
 * The cache of a movie, when it is still valid.
 *
 * The fingerprint of the file on disk decides: an unchanged file keeps the
 * segments that are already there, a changed file invalidates them. This
 * answers without transcoding anything, so a route can tell "the playlist
 * is ready" from "the playlist has to be built first" cheaply.
 *
 * @throws {PathSafetyError} `INVALID_ID` when the id is not a catalog id,
 * `NOT_FOUND` when the catalog does not know it, `OUTSIDE_ROOT` when its
 * file does not live in the movie root.
 */
export async function validHlsCache(
  options: TranscodeOptions,
  mediaItemId: number,
): Promise<HlsCache | null> {
  const { db, movieRoot, cacheDir } = options;

  const source = await resolveMediaPath({ db, movieRoot }, mediaItemId);
  const info = await stat(source);
  const stamp = fingerprint(source, info.size, info.mtimeMs);

  const directory = join(cacheDir, "hls", String(mediaItemId));
  const masterPath = join(directory, "master.m3u8");
  const statePath = join(directory, "state.json");

  const renditions = await readCache(directory, masterPath, statePath, stamp);
  if (!renditions) return null;

  return { mediaItemId, directory, masterPath, renditions, cached: true };
}

/**
 * The renditions of a cache that is still valid, or null when there is
 * nothing to reuse.
 */
async function readCache(
  directory: string,
  masterPath: string,
  statePath: string,
  stamp: string,
): Promise<HlsRendition[] | null> {
  let state: CacheState;
  try {
    state = JSON.parse(await readFile(statePath, "utf8")) as CacheState;
  } catch {
    return null;
  }

  if (state.fingerprint !== stamp) return null;

  try {
    await stat(masterPath);
  } catch {
    return null;
  }

  return state.renditions.map((rendition) => ({
    ...rendition,
    playlistPath: join(directory, rendition.name, "index.m3u8"),
  }));
}

/**
 * Runs ffmpeg and turns a failure into an error the route can answer with.
 */
async function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(ffmpeg, args, { maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new HlsError(
        "TRANSCODE_FAILED",
        `ffmpeg not found (${ffmpeg}); is ffmpeg installed?`,
      );
    }
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new HlsError(
      "TRANSCODE_FAILED",
      `ffmpeg failed: ${stderr || (err as Error).message}`,
    );
  }
}
