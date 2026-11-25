/**
 * Reading the subtitles of a movie.
 *
 * The player wants two things from a subtitle: the WebVTT file it hands to
 * the browser, and the plain text of the script it shows in a tab. Both
 * are derived from the same track of the catalog, so the two always agree.
 *
 * A scan converts the subtitles it finds into WebVTT and writes them into
 * the cache. When that file is there, it is used; when it is not — the scan
 * ran without a cache, or the file has been cleaned away — the subtitle is
 * converted on the spot, so a movie that has a subtitle never answers with
 * an empty track.
 *
 * Every file that is read goes through the path safety rules: the
 * subtitle has to live inside the movie root, the converted file inside the
 * cache directory.
 */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { sep } from "node:path";

import { subtitleTracks } from "../../db/schema.ts";
import { resolveInsideRoot } from "../pathSafety.ts";
import { SubtitleParseError, toVtt, type SubtitleFormat } from "./toVtt.ts";

/** A row of the subtitle catalog. */
export type SubtitleTrackRow = typeof subtitleTracks.$inferSelect;

/** Why a subtitle could not be served. */
export type SubtitleUnavailableCode =
  /** The subtitle file is gone. */
  | "SUBTITLE_NOT_FOUND"
  /** The subtitle file is there but holds nothing that can be played. */
  | "SUBTITLE_BROKEN";

/** The error every refusal of this module raises. */
export class SubtitleUnavailableError extends Error {
  readonly code: SubtitleUnavailableCode;

  constructor(code: SubtitleUnavailableCode, message: string) {
    super(message);
    this.name = "SubtitleUnavailableError";
    this.code = code;
  }
}

export interface SubtitleReadOptions {
  /** The directory that holds the movies. */
  movieRoot: string;
  /** The directory that holds the converted subtitles. */
  cacheDir: string;
}

/**
 * True when `candidate` lies strictly inside `root`.
 *
 * The root itself does not count: it is a directory, and no route serves
 * it.
 */
function isInside(root: string, candidate: string): boolean {
  if (root === candidate) return false;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

/**
 * The real path of a file that lies strictly inside a directory.
 *
 * Both paths are canonicalized first: a symbolic link inside the
 * directory that points somewhere else does not make the file a member of
 * it. Returns null when the file is missing or lies outside.
 */
async function resolveInsideDirectory(
  root: string,
  candidate: string,
): Promise<string | null> {
  let rootReal: string;
  let candidateReal: string;
  try {
    rootReal = await realpath(root);
    candidateReal = await realpath(candidate);
  } catch {
    return null;
  }

  if (!isInside(rootReal, candidateReal)) return null;
  return candidateReal;
}

/**
 * Reads a file without following a symbolic link.
 *
 * A link put in place of the file between the check and the open is not
 * followed: the open fails instead of serving something else.
 */
async function readFileNoFollow(path: string): Promise<string | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * The WebVTT of a track.
 *
 * The converted file of the cache is preferred; when it is missing the
 * subtitle of the movie is converted on the spot.
 *
 * @throws {SubtitleUnavailableError} when the subtitle is gone or holds
 * nothing that can be played.
 */
export async function loadTrackVtt(
  track: SubtitleTrackRow,
  options: SubtitleReadOptions,
): Promise<string> {
  if (track.vttPath) {
    // The converted file has to be a real member of the cache: a symbolic
    // link inside the cache that points somewhere else does not count.
    const candidate = await resolveInsideDirectory(options.cacheDir, track.vttPath);
    if (candidate !== null) {
      const cached = await readFileNoFollow(candidate);
      if (cached !== null && cached.trim().length > 0) return cached;
    }
  }

  // The subtitle of the movie itself. It has to live inside the movie
  // root, and it is read without following a symbolic link.
  let source: string;
  try {
    const path = await resolveInsideRoot(options.movieRoot, track.path);
    source = (await readFileNoFollow(path)) ?? "";
  } catch {
    throw new SubtitleUnavailableError(
      "SUBTITLE_NOT_FOUND",
      `The subtitle ${track.path} is gone`,
    );
  }

  try {
    return toVtt(source, track.format as SubtitleFormat);
  } catch (error) {
    if (error instanceof SubtitleParseError) {
      throw new SubtitleUnavailableError(
        "SUBTITLE_BROKEN",
        `The subtitle ${track.path} holds nothing that can be played`,
      );
    }
    throw error;
  }
}

/**
 * The text of a script: the lines the cues hold, without their timings.
 *
 * The blocks of a WebVTT file are separated by blank lines, and every block
 * that carries a timing line contributes its text.
 */
export function vttToText(vtt: string): string {
  const body = vtt.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const texts: string[] = [];

  for (const block of body.split(/\n{2,}/)) {
    const lines = block
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;

    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    // The header of the file and any block without a timing line hold no
    // text of the script.
    if (timingIndex === -1) continue;

    const text = lines.slice(timingIndex + 1).join("\n").trim();
    if (text.length > 0) texts.push(text);
  }

  return texts.join("\n");
}
