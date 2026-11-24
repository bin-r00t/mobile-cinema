/**
 * The scan service: it walks the movie root, works out what it knows about
 * every movie in it and keeps the catalog in step with the files on disk.
 *
 * A scan never lets one bad file stop it. Everything that goes wrong with a
 * single movie is recorded and the rest of the library is scanned anyway.
 */
import { join, sep } from "node:path";

import { eq } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { mediaItems, scanRuns, subtitleTracks } from "../../db/schema.ts";
import { mergeMetadata, readSidecar } from "./sidecar.ts";
import { probeMediaFile } from "./probe.ts";
import {
  convertTrackToVtt,
  discoverSubtitles,
  selectPrimaryTrack,
  type SubtitleTrack,
} from "./subtitles.ts";
import { parseTitle } from "./title.ts";
import { walkMediaFiles, type MediaFile } from "./walk.ts";

export type ScanStatus = "completed" | "failed";

export interface ScanOptions {
  /** The catalog to update. */
  db: Db;
  /** The directory that holds the movies — the equivalent of MOVIE_ROOT. */
  movieRoot: string;
  /** Where the converted subtitles are cached. Omit to skip the conversion. */
  cacheDir?: string;
  /** The ffprobe binary to run. Defaults to "ffprobe" from PATH. */
  ffprobePath?: string;
  /** The languages the player prefers, best first. Defaults to English. */
  preferredLanguages?: readonly string[];
}

export interface ScanItemResult {
  /** Absolute path of the video file. */
  path: string;
  /** The row it landed in. */
  mediaItemId: number;
  /** True when the row was created by this scan, false when it was updated. */
  added: boolean;
  /** Everything that went wrong with this movie. */
  warnings: string[];
}

export interface ScanSummary {
  /** The row in `scan_runs` that records this scan. */
  runId: number;
  status: ScanStatus;
  /** The number of video files found in the root. */
  totalCount: number;
  addedCount: number;
  updatedCount: number;
  removedCount: number;
  items: ScanItemResult[];
  /** The problems of the whole scan, one line each. */
  errors: string[];
}

/** Everything that is known about one movie, gathered before the catalog is touched. */
interface PreparedItem {
  file: MediaFile;
  title: string;
  year: number | null;
  description: string | null;
  posterPath: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  container: string | null;
  tracks: {
    path: string;
    language: string | null;
    format: string;
    isPrimary: boolean;
    vttPath: string | null;
  }[];
  warnings: string[];
}

const MAX_ERROR_SUMMARY = 4000;

function summarise(errors: readonly string[]): string | null {
  if (errors.length === 0) return null;
  const text = errors.join("\n");
  return text.length > MAX_ERROR_SUMMARY
    ? `${text.slice(0, MAX_ERROR_SUMMARY)}…`
    : text;
}

/**
 * Converts a subtitle into WebVTT in the cache. A damaged subtitle yields
 * null rather than an exception: it must not break the scan.
 */
async function convertToVtt(
  track: SubtitleTrack,
  cacheDir: string,
): Promise<string | null> {
  try {
    return await convertTrackToVtt(track, join(cacheDir, "subtitles"));
  } catch {
    return null;
  }
}

/**
 * Gathers everything that is known about one movie: the container tags, the
 * sidecars, the name of the file and the subtitles that belong to it.
 *
 * Never throws: a problem with one movie is recorded in `warnings`.
 */
async function prepareItem(
  file: MediaFile,
  options: ScanOptions,
): Promise<PreparedItem> {
  const warnings: string[] = [];

  const probe = await probeMediaFile(file.path, {
    ffprobePath: options.ffprobePath,
  });
  warnings.push(...probe.warnings);

  const sidecar = await readSidecar(file.path);
  warnings.push(...sidecar.warnings);

  const merged = mergeMetadata(sidecar, {
    tagTitle: probe.tagTitle,
    tagPlot: probe.tagPlot,
  });

  const parsed = parseTitle(file.path);

  const discovered = await discoverSubtitles(file.path);
  const primary = selectPrimaryTrack(discovered, {
    preferredLanguages: options.preferredLanguages,
  });

  const tracks: PreparedItem["tracks"] = [];
  for (const track of discovered) {
    let vttPath: string | null = null;
    if (options.cacheDir) {
      const converted = await convertToVtt(track, options.cacheDir);
      if (converted === null) {
        warnings.push(`Could not convert the subtitle ${track.path}`);
      } else {
        vttPath = converted;
      }
    }
    tracks.push({
      path: track.path,
      language: track.language,
      format: track.format,
      isPrimary: primary !== null && primary.path === track.path,
      vttPath,
    });
  }

  return {
    file,
    title: merged.title ?? parsed.title,
    year: merged.year ?? parsed.year,
    description: merged.description,
    posterPath: merged.posterPath,
    durationMs: probe.durationMs,
    width: probe.width,
    height: probe.height,
    videoCodec: probe.videoCodec,
    container: probe.container,
    tracks,
    warnings,
  };
}

/**
 * Scans the movie root and brings the catalog in line with it.
 *
 * Movies that are new get a row, movies that are already known get their row
 * updated, and movies whose file has disappeared are dropped. Every scan
 * leaves a row in `scan_runs` behind with its counts and its problems.
 */
export async function scanLibrary(options: ScanOptions): Promise<ScanSummary> {
  const { db, movieRoot } = options;
  const errors: string[] = [];

  const startedAt = new Date();
  const [run] = await db
    .insert(scanRuns)
    .values({ startedAt, status: "running" })
    .returning({ id: scanRuns.id });

  const runId = run!.id;

  try {
    const files = await walkMediaFiles(movieRoot);
    const prepared: PreparedItem[] = [];

    for (const file of files) {
      try {
        prepared.push(await prepareItem(file, options));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${file.path}: ${message}`);
      }
    }

    const summary = writeToCatalog(db, movieRoot, prepared, runId, errors);

    await db
      .update(scanRuns)
      .set({
        finishedAt: new Date(),
        status: summary.status,
        totalCount: summary.totalCount,
        addedCount: summary.addedCount,
        updatedCount: summary.updatedCount,
        removedCount: summary.removedCount,
        errorSummary: summarise(summary.errors),
      })
      .where(eq(scanRuns.id, runId));

    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    await db
      .update(scanRuns)
      .set({
        finishedAt: new Date(),
        status: "failed",
        totalCount: 0,
        addedCount: 0,
        updatedCount: 0,
        removedCount: 0,
        errorSummary: summarise(errors),
      })
      .where(eq(scanRuns.id, runId));
    throw error;
  }
}

/**
 * Writes the gathered movies into the catalog.
 *
 * The writes are synchronous and happen in one transaction, so the catalog
 * is never left half-updated.
 */
function writeToCatalog(
  db: Db,
  movieRoot: string,
  prepared: readonly PreparedItem[],
  runId: number,
  errors: string[],
): ScanSummary {
  const items: ScanItemResult[] = [];
  let addedCount = 0;
  let updatedCount = 0;

  const summary = db.transaction((tx) => {
    for (const entry of prepared) {
      const now = new Date();
      const existing = tx
        .select({ id: mediaItems.id })
        .from(mediaItems)
        .where(eq(mediaItems.path, entry.file.path))
        .get();

      let mediaItemId: number;
      let added: boolean;

      if (existing) {
        mediaItemId = existing.id;
        added = false;
        updatedCount += 1;
        tx.update(mediaItems)
          .set({
            title: entry.title,
            year: entry.year,
            description: entry.description,
            posterPath: entry.posterPath,
            durationMs: entry.durationMs,
            width: entry.width,
            height: entry.height,
            videoCodec: entry.videoCodec,
            container: entry.container,
            sizeBytes: entry.file.size,
            mtimeMs: entry.file.mtimeMs,
            updatedAt: now,
          })
          .where(eq(mediaItems.id, mediaItemId))
          .run();
      } else {
        added = true;
        addedCount += 1;
        const result = tx
          .insert(mediaItems)
          .values({
            path: entry.file.path,
            title: entry.title,
            year: entry.year,
            description: entry.description,
            posterPath: entry.posterPath,
            durationMs: entry.durationMs,
            width: entry.width,
            height: entry.height,
            videoCodec: entry.videoCodec,
            container: entry.container,
            sizeBytes: entry.file.size,
            mtimeMs: entry.file.mtimeMs,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        mediaItemId = Number(result.lastInsertRowid);
      }

      writeTracks(tx, mediaItemId, entry);

      items.push({
        path: entry.file.path,
        mediaItemId,
        added,
        warnings: entry.warnings,
      });
    }

    // The movies whose file is gone are dropped from the catalog. Only the
    // rows of this root are touched: another root keeps its own movies.
    const seen = new Set(prepared.map((entry) => entry.file.path));
    const known = tx
      .select({ id: mediaItems.id, path: mediaItems.path })
      .from(mediaItems)
      .all();
    const rootPrefix = movieRoot.endsWith(sep) ? movieRoot : `${movieRoot}${sep}`;
    let removedCount = 0;
    for (const row of known) {
      if (!row.path.startsWith(rootPrefix)) continue;
      if (seen.has(row.path)) continue;
      tx.delete(mediaItems).where(eq(mediaItems.id, row.id)).run();
      removedCount += 1;
    }

    return { addedCount, updatedCount, removedCount };
  });

  return {
    runId,
    status: "completed",
    totalCount: prepared.length,
    addedCount: summary.addedCount,
    updatedCount: summary.updatedCount,
    removedCount: summary.removedCount,
    items,
    errors,
  };
}

/**
 * Replaces the subtitle tracks of one movie with the ones just found.
 */
function writeTracks(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  mediaItemId: number,
  entry: PreparedItem,
): void {
  tx.delete(subtitleTracks).where(eq(subtitleTracks.mediaItemId, mediaItemId)).run();

  for (const track of entry.tracks) {
    tx.insert(subtitleTracks)
      .values({
        mediaItemId,
        path: track.path,
        language: track.language,
        format: track.format,
        isPrimary: track.isPrimary,
        vttPath: track.vttPath,
        createdAt: new Date(),
      })
      .onConflictDoUpdate({
        target: subtitleTracks.path,
        set: {
          mediaItemId,
          language: track.language,
          format: track.format,
          isPrimary: track.isPrimary,
          vttPath: track.vttPath,
        },
      })
      .run();
  }
}

/**
 * The subtitle tracks of one movie.
 */
export function listTracks(
  db: Db,
  mediaItemId: number,
): {
  path: string;
  language: string | null;
  format: string;
  isPrimary: boolean;
  vttPath: string | null;
}[] {
  return db
    .select({
      path: subtitleTracks.path,
      language: subtitleTracks.language,
      format: subtitleTracks.format,
      isPrimary: subtitleTracks.isPrimary,
      vttPath: subtitleTracks.vttPath,
    })
    .from(subtitleTracks)
    .where(eq(subtitleTracks.mediaItemId, mediaItemId))
    .all();
}
