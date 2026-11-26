/**
 * The playback progress: where the player left every movie off.
 *
 * The player posts the position of the movie every few seconds while it
 * plays, and the detail page and the library read it back: the detail page
 * offers to continue where the movie was left, and the library lists the
 * movies that were played last. One row per movie — a movie has one
 * position, not a history of them.
 */
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db/client.ts";
import { mediaItems, playbackProgress } from "../db/schema.ts";

export interface ProgressRouteOptions {
  /** The catalog the movies and the positions come from. */
  db: Db;
}

/** The most entries the recently watched list may hold. */
const MAX_LIMIT = 50;

const postSchema = z.object({
  mediaItemId: z.number().int().min(1),
  positionMs: z.number().int().min(0),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(12),
});

function error(code: string, message: string) {
  return { error: { code, message } };
}

export async function progressRoutes(
  app: FastifyInstance,
  opts: ProgressRouteOptions,
): Promise<void> {
  const { db } = opts;

  app.post("/api/progress", async (request, reply) => {
    const parsed = postSchema.safeParse(request.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; ");
      return reply.status(400).send(error("VALIDATION_ERROR", message));
    }

    const { mediaItemId, positionMs } = parsed.data;

    const movie = db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(eq(mediaItems.id, mediaItemId))
      .get();
    if (!movie) {
      return reply
        .status(404)
        .send(
          error("MOVIE_NOT_FOUND", `The catalog has no movie with id ${mediaItemId}`),
        );
    }

    const updatedAt = new Date();
    // One row per movie: a second post for the same movie moves the row,
    // it does not add one.
    db.insert(playbackProgress)
      .values({ mediaItemId, positionMs, updatedAt })
      .onConflictDoUpdate({
        target: playbackProgress.mediaItemId,
        set: { positionMs, updatedAt },
      })
      .run();

    return reply.status(201).send({
      progress: { movieId: mediaItemId, positionMs, updatedAt: updatedAt.toISOString() },
    });
  });

  app.get("/api/progress", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "query"}: ${issue.message}`)
        .join("; ");
      return reply.status(400).send(error("VALIDATION_ERROR", message));
    }

    const { limit } = parsed.data;

    const rows = db
      .select({
        movieId: playbackProgress.mediaItemId,
        positionMs: playbackProgress.positionMs,
        updatedAt: playbackProgress.updatedAt,
        title: mediaItems.title,
        year: mediaItems.year,
        durationMs: mediaItems.durationMs,
        posterPath: mediaItems.posterPath,
      })
      .from(playbackProgress)
      .innerJoin(mediaItems, eq(playbackProgress.mediaItemId, mediaItems.id))
      // The movie that was played last comes first; the id breaks a tie.
      .orderBy(desc(playbackProgress.updatedAt), desc(playbackProgress.id))
      .limit(limit)
      .all();

    return reply.send({
      items: rows.map((row) => ({
        movieId: row.movieId,
        positionMs: row.positionMs,
        updatedAt: row.updatedAt.toISOString(),
        movie: {
          id: row.movieId,
          title: row.title,
          year: row.year,
          durationMs: row.durationMs,
          posterUrl: row.posterPath ? `/api/posters/${row.movieId}` : null,
        },
      })),
    });
  });

  app.get<{ Params: { movieId: string } }>(
    "/api/progress/:movieId",
    async (request, reply) => {
      const movieId = Number(request.params.movieId);
      if (!Number.isInteger(movieId) || movieId <= 0) {
        return reply
          .status(400)
          .send(error("INVALID_ID", `${request.params.movieId} is not a movie id`));
      }

      if (
        !db
          .select({ id: mediaItems.id })
          .from(mediaItems)
          .where(eq(mediaItems.id, movieId))
          .get()
      ) {
        return reply
          .status(404)
          .send(error("MOVIE_NOT_FOUND", `The catalog has no movie with id ${movieId}`));
      }

      const row = db
        .select({
          movieId: playbackProgress.mediaItemId,
          positionMs: playbackProgress.positionMs,
          updatedAt: playbackProgress.updatedAt,
        })
        .from(playbackProgress)
        .where(eq(playbackProgress.mediaItemId, movieId))
        .get();

      if (!row) {
        return reply.status(404).send(
          error("PROGRESS_NOT_FOUND", `The movie ${movieId} has no stored progress`),
        );
      }

      return {
        progress: {
          movieId: row.movieId,
          positionMs: row.positionMs,
          updatedAt: row.updatedAt.toISOString(),
        },
      };
    },
  );
}
