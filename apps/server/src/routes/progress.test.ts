import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import { createDb, type Db } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { mediaItems } from "../db/schema.ts";
import { progressRoutes } from "./progress.ts";

describe("/api/progress", () => {
  let workDir: string;
  let db: Db;
  let app: FastifyInstance;
  let matrixId: number;
  let alienId: number;
  /** A movie that was never played, so it has no stored position. */
  let unplayedId: number;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "mc-progress-"));
    await mkdir(join(workDir, "library"), { recursive: true });

    const dbPath = join(workDir, "catalog.sqlite");
    migrate(dbPath);
    db = createDb(dbPath);

    matrixId = db
      .insert(mediaItems)
      .values({ path: join(workDir, "library", "matrix.mkv"), title: "The Matrix" })
      .run().lastInsertRowid as number;
    alienId = db
      .insert(mediaItems)
      .values({ path: join(workDir, "library", "alien.mkv"), title: "Alien" })
      .run().lastInsertRowid as number;
    unplayedId = db
      .insert(mediaItems)
      .values({
        path: join(workDir, "library", "braveheart.mkv"),
        title: "Braveheart",
      })
      .run().lastInsertRowid as number;

    app = Fastify({ logger: { level: "silent" } });
    await app.register(progressRoutes, { db });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(workDir, { recursive: true, force: true });
  });

  interface ProgressBody {
    progress: { movieId: number; positionMs: number; updatedAt: string };
  }

  interface ListBody {
    items: {
      movieId: number;
      positionMs: number;
      updatedAt: string;
      movie: {
        id: number;
        title: string;
        year: number | null;
        durationMs: number | null;
        posterUrl: string | null;
      };
    }[];
  }

  it("stores the position of a movie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/progress",
      payload: { mediaItemId: matrixId, positionMs: 90_000 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<ProgressBody>();
    expect(body.progress).toMatchObject({ movieId: matrixId, positionMs: 90_000 });
    expect(new Date(body.progress.updatedAt).toString()).not.toBe("Invalid Date");

    const read = await app.inject({ method: "GET", url: `/api/progress/${matrixId}` });
    expect(read.statusCode).toBe(200);
    expect(read.json<ProgressBody>().progress.positionMs).toBe(90_000);
  });

  it("moves the row instead of adding one when the movie is posted again", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/progress",
      payload: { mediaItemId: matrixId, positionMs: 120_000 },
    });
    expect(res.statusCode).toBe(201);

    const read = await app.inject({ method: "GET", url: `/api/progress/${matrixId}` });
    expect(read.json<ProgressBody>().progress.positionMs).toBe(120_000);

    const list = await app.inject({ method: "GET", url: "/api/progress" });
    expect(
      list
        .json<ListBody>()
        .items.filter((item) => item.movieId === matrixId).length,
    ).toBe(1);
  });

  it("lists the movies that were played last, most recent first", async () => {
    await app.inject({
      method: "POST",
      url: "/api/progress",
      payload: { mediaItemId: alienId, positionMs: 30_000 },
    });

    const list = await app.inject({ method: "GET", url: "/api/progress" });
    expect(list.statusCode).toBe(200);
    const items = list.json<ListBody>().items;
    expect(items.map((item) => item.movieId)).toEqual([alienId, matrixId]);
    expect(items[0]?.movie).toMatchObject({
      id: alienId,
      title: "Alien",
      year: null,
      posterUrl: null,
    });
  });

  it("respects the limit of the list", async () => {
    const list = await app.inject({ method: "GET", url: "/api/progress?limit=1" });
    expect(list.json<ListBody>().items.length).toBe(1);
  });

  it("answers 400 for a body that is not a position", async () => {
    const cases = [
      { mediaItemId: matrixId },
      { mediaItemId: matrixId, positionMs: -5 },
      { mediaItemId: matrixId, positionMs: 1.5 },
      { mediaItemId: 0, positionMs: 1000 },
      { positionMs: 1000 },
    ];
    for (const payload of cases) {
      const res = await app.inject({ method: "POST", url: "/api/progress", payload });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        "VALIDATION_ERROR",
      );
    }
  });

  it("answers 404 for a movie the catalog does not know", async () => {
    const post = await app.inject({
      method: "POST",
      url: "/api/progress",
      payload: { mediaItemId: 9999, positionMs: 1000 },
    });
    expect(post.statusCode).toBe(404);
    expect(post.json<{ error: { code: string } }>().error.code).toBe("MOVIE_NOT_FOUND");

    const read = await app.inject({ method: "GET", url: "/api/progress/9999" });
    expect(read.statusCode).toBe(404);
    expect(read.json<{ error: { code: string } }>().error.code).toBe("MOVIE_NOT_FOUND");
  });

  it("answers 404 for a movie without a stored position", async () => {
    const read = await app.inject({ method: "GET", url: `/api/progress/${unplayedId}` });
    expect(read.statusCode).toBe(404);
    expect(read.json<{ error: { code: string } }>().error.code).toBe(
      "PROGRESS_NOT_FOUND",
    );
  });

  it("answers 400 for an id that is not a movie id", async () => {
    const read = await app.inject({ method: "GET", url: "/api/progress/not-a-number" });
    expect(read.statusCode).toBe(400);
    expect(read.json<{ error: { code: string } }>().error.code).toBe("INVALID_ID");
  });
});
