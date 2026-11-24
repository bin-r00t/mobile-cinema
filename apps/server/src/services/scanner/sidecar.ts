import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

/** Poster extensions we look for next to a video, in priority order. */
export const POSTER_EXTENSIONS = [".jpg", ".png", ".webp"] as const;

/** What the sidecar files next to one video know about it. */
export interface SidecarMetadata {
  /** Title from the .nfo, when present. */
  title: string | null;
  /** Plot from the .nfo, or the .txt readme as a fallback. */
  description: string | null;
  year: number | null;
  /** Runtime in minutes, from the .nfo. */
  runtimeMin: number | null;
  genre: string | null;
  /** Audience rating from the .nfo, e.g. 7.5. */
  rating: number | null;
  /** Absolute path of a sibling poster image, when one exists. */
  posterPath: string | null;
  /** Problems hit while reading sidecars. A scan records these instead of failing. */
  warnings: string[];
}

/** The subset of ffprobe output the merge needs. Structural, not imported. */
export interface EmbeddedTags {
  tagTitle: string | null;
  tagPlot: string | null;
}

/** What the catalog stores once sidecars and embedded tags are merged. */
export interface MergedMetadata {
  title: string | null;
  description: string | null;
  year: number | null;
  runtimeMin: number | null;
  genre: string | null;
  rating: number | null;
  posterPath: string | null;
}

/**
 * Extracts the text of the first `<tag>…</tag>` pair in an NFO document.
 * NFO files are Kodi-style XML, often slightly malformed; a tolerant
 * extraction beats refusing the whole file over one bad tag.
 */
function nfoTag(doc: string, tag: string): string | null {
  const match = doc.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"),
  );
  const value = match?.[1]?.trim();
  return value ? value : null;
}

function parseLeadingNumber(value: string | null): number | null {
  if (value === null) return null;
  const match = value.match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the sidecar files sitting next to `videoPath`: a same-basename .nfo
 * (title, plot, year, runtime, genre, rating), a same-basename .txt as a
 * description fallback, and a same-basename poster image.
 *
 * Never throws: missing sidecars simply yield nulls, and a malformed NFO
 * yields whatever tags could still be read, with a warning recorded.
 */
export async function readSidecar(videoPath: string): Promise<SidecarMetadata> {
  const base = videoPath.slice(0, videoPath.length - extname(videoPath).length);
  const warnings: string[] = [];

  let title: string | null = null;
  let plot: string | null = null;
  let year: number | null = null;
  let runtimeMin: number | null = null;
  let genre: string | null = null;
  let rating: number | null = null;

  const nfo = await readIfExists(`${base}.nfo`);
  if (nfo !== null) {
    title = nfoTag(nfo, "title");
    plot = nfoTag(nfo, "plot");
    year = parseLeadingNumber(nfoTag(nfo, "year"));
    runtimeMin = parseLeadingNumber(nfoTag(nfo, "runtime"));
    genre = nfoTag(nfo, "genre");
    const rawRating = parseLeadingNumber(nfoTag(nfo, "rating"));
    rating = rawRating !== null && rawRating >= 0 && rawRating <= 10 ? rawRating : null;
    if (title === null && plot === null) {
      warnings.push(`NFO at ${base}.nfo has no readable <title> or <plot>`);
    }
  }

  let description = plot;
  if (description === null) {
    const txt = await readIfExists(`${base}.txt`);
    const trimmed = txt?.trim();
    if (trimmed) description = trimmed;
  }

  let posterPath: string | null = null;
  for (const ext of POSTER_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (await exists(candidate)) {
      posterPath = candidate;
      break;
    }
  }

  return {
    title,
    description,
    year,
    runtimeMin,
    genre,
    rating,
    posterPath,
    warnings,
  };
}

/**
 * Merges sidecar metadata with the tags embedded in the container.
 * Priority is NFO/TXT (the sidecar result) first, embedded tags second.
 */
export function mergeMetadata(
  sidecar: SidecarMetadata,
  embedded: EmbeddedTags,
): MergedMetadata {
  return {
    title: sidecar.title ?? embedded.tagTitle,
    description: sidecar.description ?? embedded.tagPlot,
    year: sidecar.year,
    runtimeMin: sidecar.runtimeMin,
    genre: sidecar.genre,
    rating: sidecar.rating,
    posterPath: sidecar.posterPath,
  };
}
