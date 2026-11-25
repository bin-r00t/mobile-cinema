/**
 * The movies of the library: a searchable, sortable and paged list, and the
 * detail of a single movie.
 *
 * The list is what the library page of the player shows: a grid of posters
 * that can be searched by title, sorted and paged. The total count tells the
 * page how many movies there are in total, so it can show a pager.
 *
 * The detail route returns the catalog row of a movie, decorated with the
 * URLs the player will call next: the poster, the subtitle tracks as VTT,
 * and the endpoints that stream the file itself. It never opens a file —
 * that is the job of the streaming routes — but it does check that the
 * file the catalog knows about is really servable, because a playback
 * mode advertised here must be one the player can actually use.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db/client.ts";
import { mediaItems, subtitleTracks } from "../db/schema.ts";
import { PathSafetyError, resolveInsideRoot } from "../services/pathSafety.ts";

export interface MoviesRouteOptions {
  /** The catalog the movies come from. */
  db: Db;
  /** The directory that holds the movies — the equivalent of MOVIE_ROOT. */
  movieRoot: string;
  /** Where the derived files live (VTT, HLS playlists). */
  cacheDir: string;
}

/** How much of the description the list shows. */
const DESCRIPTION_SNIPPET_LENGTH = 200;

/** The most movies one page may hold. */
const MAX_PAGE_SIZE = 200;

const querySchema = z.object({
  q: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length === 0 ? undefined : value,
    z.string().trim().min(1).optional(),
  ),
  sort: z.enum(["title", "year", "added"]).default("title"),
  order: z.enum(["asc", "desc"]).default("asc"),
  year: z.coerce.number().int().min(1800).max(2200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** The content types the poster files may have. */
const POSTER_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/**
 * Escapes the characters that have a meaning in a LIKE pattern, so a search
 * for "100%" does not match everything.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function error(code: string, message: string) {
  return { error: { code, message } };
}

/**
 * A short version of the description: the list shows a teaser, not the
 * whole plot.
 */
function snippet(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed.length <= DESCRIPTION_SNIPPET_LENGTH) return trimmed;
  return `${trimmed.slice(0, DESCRIPTION_SNIPPET_LENGTH).trimEnd()}…`;
}

/**
 * True when `candidate` lies strictly inside `root` (the root itself
 * does not count).
 */
function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return false;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

/**
 * True when the file exists as a real file inside the movie root —
 * a symlink that escapes the root does not count.
 */
async function isServable(root: string, path: string): Promise<boolean> {
  try {
    const rootAbs = root.endsWith(sep) ? root.slice(0, -1) : root;
    // resolve, not join: a catalog path that is already absolute
    // replaces the root instead of being glued onto it.
    const resolved = resolve(rootAbs, path);
    if (!isInside(rootAbs, resolved)) return false;
    const [rootReal, fileReal, info] = await Promise.all([
      realpath(rootAbs),
      realpath(resolved),
      stat(resolved),
    ]);
    return info.isFile() && isInside(rootReal, fileReal);
  } catch {
    return false;
  }
}

export async function moviesRoutes(
  app: FastifyInstance,
  opts: MoviesRouteOptions,
): Promise<void> {
  const { db, movieRoot, cacheDir } = opts;

  app.get("/api/movies", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "query"}: ${issue.message}`)
        .join("; ");
      return reply.status(400).send(error("VALIDATION_ERROR", message));
    }

    const { q, sort, order, year, limit, offset } = parsed.data;

    const filters: SQL[] = [];
    if (q !== undefined) {
      filters.push(sql`${mediaItems.title} LIKE ${`%${escapeLike(q)}%`} ESCAPE '\\'`);
    }
    if (year !== undefined) {
      filters.push(eq(mediaItems.year, year));
    }
    const where = filters.length > 0 ? and(...filters) : undefined;

    const direction = order === "asc" ? asc : desc;
    const sortColumn =
      sort === "year"
        ? mediaItems.year
        : sort === "added"
          ? mediaItems.createdAt
          : mediaItems.title;

    const rows = db
      .select({
        id: mediaItems.id,
        title: mediaItems.title,
        year: mediaItems.year,
        description: mediaItems.description,
        durationMs: mediaItems.durationMs,
        posterPath: mediaItems.posterPath,
        addedAt: mediaItems.createdAt,
      })
      .from(mediaItems)
      .where(where)
      .orderBy(
        ...(sort === "year"
          ? // A movie without a year sorts last, whatever the direction is.
            [sql`${mediaItems.year} IS NULL`, direction(sortColumn)]
          : [direction(sortColumn)]),
        // The id breaks a tie, so the order of the list never changes.
        asc(mediaItems.id),
      )
      .limit(limit)
      .offset(offset)
      .all();

    const counted = db.select({ total: count() }).from(mediaItems).where(where).all();
    const total = counted[0]?.total ?? 0;

    return reply.send({
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        year: row.year,
        description: snippet(row.description),
        durationMs: row.durationMs,
        posterUrl: row.posterPath ? `/api/posters/${row.id}` : null,
        addedAt: row.addedAt.toISOString(),
      })),
      total,
      limit,
      offset,
    });
  });

  app.get<{ Params: { id: string } }>("/api/movies/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply
        .status(400)
        .send(error("INVALID_ID", `${request.params.id} is not a movie id`));
    }

    const movie = db.select().from(mediaItems).where(eq(mediaItems.id, id)).get();
    if (!movie) {
      return reply
        .status(404)
        .send(error("MOVIE_NOT_FOUND", `The catalog has no movie with id ${id}`));
    }

    const tracks = db
      .select()
      .from(subtitleTracks)
      .where(eq(subtitleTracks.mediaItemId, id))
      .all();

    // A playback mode is only advertised when the player can actually
    // use it: progressive needs the file inside the root, HLS needs a
    // playlist the pipeline has written into the cache.
    const playbackModes: string[] = [];
    if (await isServable(movieRoot, movie.path)) {
      playbackModes.push("progressive");
    }
    try {
      await stat(join(cacheDir, "hls", String(id), "master.m3u8"));
      playbackModes.push("hls");
    } catch {
      // No playlist yet — progressive (if available) is the only mode.
    }

    return {
      movie: {
        id: movie.id,
        title: movie.title,
        year: movie.year,
        description: movie.description,
        posterUrl: movie.posterPath ? `/api/posters/${id}` : null,
        durationMs: movie.durationMs,
        width: movie.width,
        height: movie.height,
        videoCodec: movie.videoCodec,
        container: movie.container,
        sizeBytes: movie.sizeBytes,
        streamUrl: playbackModes.includes("progressive") ? `/api/stream/${id}` : null,
        hlsUrl: playbackModes.includes("hls") ? `/api/hls/${id}/master.m3u8` : null,
        playbackModes,
        subtitles: tracks.map((track) => ({
          id: track.id,
          language: track.language,
          isPrimary: track.isPrimary,
          vttUrl: track.vttPath ? `/api/subtitles/${track.id}.vtt` : null,
        })),
      },
    };
  });

  /**
   * The poster of a movie. The file is read through the path safety module,
   * so only files inside the movie root are ever served.
   */
  app.get("/api/posters/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply
        .status(400)
        .send(error("VALIDATION_ERROR", "The poster id must be a number"));
    }

    const row = db
      .select({ posterPath: mediaItems.posterPath })
      .from(mediaItems)
      .where(eq(mediaItems.id, id))
      .get();

    if (!row || !row.posterPath) {
      return reply
        .status(404)
        .send(error("NOT_FOUND", `The movie ${id} has no poster`));
    }

    let path: string;
    try {
      path = await resolveInsideRoot(movieRoot, row.posterPath);
    } catch (err) {
      if (err instanceof PathSafetyError) {
        return reply
          .status(404)
          .send(error("NOT_FOUND", `The poster of movie ${id} is gone`));
      }
      throw err;
    }

    const contentType = POSTER_CONTENT_TYPES[extname(path).toLowerCase()];
    if (!contentType) {
      return reply
        .status(404)
        .send(error("NOT_FOUND", `The poster of movie ${id} is gone`));
    }

    const image = await readFile(path);
    return reply
      .header("content-type", contentType)
      .header("cache-control", "public, max-age=3600")
      .send(image);
  });
}
