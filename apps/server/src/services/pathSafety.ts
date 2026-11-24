/**
 * Path safety: the one place that decides which files the server is allowed
 * to read.
 *
 * Every file the player gets goes through here: a catalog id is turned into
 * an absolute path that is guaranteed to live inside the movie root. Paths
 * that climb out of the root, and files that only appear to be inside it
 * because a symbolic link points elsewhere, are refused.
 */
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { eq } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { mediaItems } from "../db/schema.ts";

export type PathSafetyErrorCode =
  /** The id or the path makes no sense. */
  | "INVALID_ID"
  /** The file is not in the catalog. */
  | "NOT_FOUND"
  /** The file lies outside the movie root. */
  | "OUTSIDE_ROOT";

/** The error every refusal of this module raises. */
export class PathSafetyError extends Error {
  readonly code: PathSafetyErrorCode;

  constructor(code: PathSafetyErrorCode, message: string) {
    super(message);
    this.name = "PathSafetyError";
    this.code = code;
  }
}

export interface PathSafetyOptions {
  /** The directory that holds the movies — the equivalent of MOVIE_ROOT. */
  movieRoot: string;
  /** The catalog the ids come from. */
  db: Db;
}

/**
 * True when `candidate` lies strictly inside `root`.
 *
 * The root itself does not count: it is a directory, and no route serves it.
 */
export function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return false;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

/**
 * Resolves a path to a real file inside the movie root.
 *
 * The path may be absolute or relative to the root; it is resolved against
 * the root first, so `../../etc/passwd` cannot escape. The resolved path is
 * then compared with the root, and the real path of the file is compared
 * with the real path of the root — a symbolic link that points out of the
 * library is refused as well.
 *
 * @throws {PathSafetyError} `OUTSIDE_ROOT` when the file is not in the
 * root, `NOT_FOUND` when it does not exist.
 */
export async function resolveInsideRoot(
  root: string,
  candidate: string,
): Promise<string> {
  if (candidate.length === 0) {
    throw new PathSafetyError("INVALID_ID", "An empty path is not a file");
  }

  const rootAbs = resolve(root);
  const target = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(rootAbs, candidate);

  if (!isInside(rootAbs, target)) {
    throw new PathSafetyError("OUTSIDE_ROOT", `${target} is outside the movie root`);
  }

  let rootReal: string;
  try {
    rootReal = await realpath(rootAbs);
  } catch {
    rootReal = rootAbs;
  }

  let targetReal: string;
  try {
    targetReal = await realpath(target);
  } catch {
    throw new PathSafetyError("NOT_FOUND", `${target} does not exist`);
  }

  if (!isInside(rootReal, targetReal)) {
    throw new PathSafetyError(
      "OUTSIDE_ROOT",
      `${target} points outside the movie root`,
    );
  }

  const info = await stat(targetReal);
  if (!info.isFile()) {
    throw new PathSafetyError("NOT_FOUND", `${target} is not a file`);
  }

  return targetReal;
}

/**
 * Turns a catalog id into the absolute path of its file.
 *
 * @throws {PathSafetyError} `INVALID_ID` when the id is not a catalog id,
 * `NOT_FOUND` when the catalog does not know it, `OUTSIDE_ROOT` when its
 * file does not live in the movie root.
 */
export async function resolveMediaPath(
  options: PathSafetyOptions,
  mediaItemId: number,
): Promise<string> {
  if (!Number.isInteger(mediaItemId) || mediaItemId <= 0) {
    throw new PathSafetyError("INVALID_ID", `${mediaItemId} is not a catalog id`);
  }

  const row = options.db
    .select({ path: mediaItems.path })
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId))
    .get();

  if (!row) {
    throw new PathSafetyError(
      "NOT_FOUND",
      `The catalog has no movie with id ${mediaItemId}`,
    );
  }

  return resolveInsideRoot(options.movieRoot, row.path);
}

/**
 * Opens the file of a catalog id for reading.
 *
 * The file is opened with `O_NOFOLLOW`, so a symbolic link put in its place
 * between the check and the open is not followed.
 */
export async function openMediaFile(
  options: PathSafetyOptions,
  mediaItemId: number,
): Promise<{ handle: FileHandle; path: string }> {
  const path = await resolveMediaPath(options, mediaItemId);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  return { handle, path };
}
