import { opendir, stat } from "node:fs/promises";
import { extname, join } from "node:path";

/** Containers we treat as movies. Anything else in the library is ignored. */
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mkv",
  ".mp4",
  ".avi",
  ".mov",
  ".m4v",
  ".webm",
  ".ts",
  ".m2ts",
  ".mpg",
  ".mpeg",
  ".wmv",
  ".flv",
  ".iso",
]);

/**
 * Directories that hold thumbnails, recycle bins or vendor junk. They are
 * skipped wholesale — no need to look inside.
 */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  "@eaDir",
  "@Recycle",
  ".thumbnails",
  ".Trash",
  ".Trashes",
  "$RECYCLE.BIN",
  "System Volume Information",
  "lost+found",
]);

export interface MediaFile {
  /** Absolute path of the video file. */
  path: string;
  /** Size in bytes. */
  size: number;
  /** Modification time in milliseconds since the epoch. */
  mtimeMs: number;
  /** Lower-case extension, including the dot. */
  ext: string;
}

/** True for a directory that must not be descended into. */
export function isIgnoredDir(name: string): boolean {
  if (IGNORED_DIRS.has(name)) return true;
  // Hidden directories hold system state, not media.
  return name.startsWith(".");
}

export function isVideoFile(path: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * Walks `root` and returns every video file below it, sorted by path.
 *
 * Hidden and vendor directories are skipped, and symlinked directories are
 * not followed — a phone drive can contain loops.
 */
export async function walkMediaFiles(root: string): Promise<MediaFile[]> {
  const found: MediaFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await opendir(dir);
    } catch {
      // Unreadable directory (permissions, vanished mount): skip it.
      return;
    }

    for await (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isIgnoredDir(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isVideoFile(entry.name)) continue;

      try {
        const info = await stat(full);
        found.push({
          path: full,
          size: info.size,
          mtimeMs: info.mtimeMs,
          ext: extname(entry.name).toLowerCase(),
        });
      } catch {
        // The file disappeared between listing and stat; skip it.
      }
    }
  }

  await walk(root);
  found.sort((a, b) => a.path.localeCompare(b.path));
  return found;
}
