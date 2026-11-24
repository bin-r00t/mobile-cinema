/**
 * The movie API: what a player needs before it can start playing.
 *
 * The detail route returns the catalog row of a movie, decorated with the
 * URLs the player will call next: the poster, the subtitle tracks as VTT,
 * and the endpoints that stream the file itself. It never opens a file —
 * that is the job of the streaming routes — but it does check that the
 * file the catalog knows about is really servable, because a playback
 * mode advertised here must be one the player can actually use.
 */
import { realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { Db } from "../db/client.ts";
import { mediaItems, subtitleTracks } from "../db/schema.ts";

/** The shape every API error takes, on every route. */
export interface ErrorEnvelope {
  error: { code: string; message: string };
}

export interface MovieRoutesOptions {
  db: Db;
  /** Where the scanner puts derived files (VTT, HLS playlists). */
  cacheDir: string;
  /** The directory that holds the movies. */
  movieRoot: string;
}

export async function movieRoutes(
  app: FastifyInstance,
  opts: MovieRoutesOptions,
): Promise<void> {
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

  app.get<{ Params: { id: string } }>(
    "/api/movies/:id",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({
          error: { code: "INVALID_ID", message: `${request.params.id} is not a movie id` },
        } satisfies ErrorEnvelope);
      }

      const movie = opts.db
        .select()
        .from(mediaItems)
        .where(eq(mediaItems.id, id))
        .get();
      if (!movie) {
        return reply.code(404).send({
          error: {
            code: "MOVIE_NOT_FOUND",
            message: `The catalog has no movie with id ${id}`,
          },
        } satisfies ErrorEnvelope);
      }

      const tracks = opts.db
        .select()
        .from(subtitleTracks)
        .where(eq(subtitleTracks.mediaItemId, id))
        .all();

      // A playback mode is only advertised when the player can actually
      // use it: progressive needs the file inside the root, HLS needs a
      // playlist the pipeline has written into the cache.
      const playbackModes: string[] = [];
      if (await isServable(opts.movieRoot, movie.path)) {
        playbackModes.push("progressive");
      }
      try {
        await stat(join(opts.cacheDir, "hls", String(id), "index.m3u8"));
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
          posterUrl: movie.posterPath ? `/api/movies/${id}/poster` : null,
          durationMs: movie.durationMs,
          width: movie.width,
          height: movie.height,
          videoCodec: movie.videoCodec,
          container: movie.container,
          sizeBytes: movie.sizeBytes,
          streamUrl:
            playbackModes.includes("progressive")
              ? `/api/movies/${id}/stream`
              : null,
          hlsUrl: playbackModes.includes("hls")
            ? `/api/movies/${id}/hls/index.m3u8`
            : null,
          playbackModes,
          subtitles: tracks.map((track) => ({
            id: track.id,
            language: track.language,
            isPrimary: track.isPrimary,
            vttUrl: track.vttPath ? `/api/subtitles/${track.id}.vtt` : null,
          })),
        },
      };
    },
  );
}
