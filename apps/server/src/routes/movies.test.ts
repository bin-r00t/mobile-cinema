import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { createDb, type Db } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { mediaItems } from "../db/schema.ts";
import { moviesRoutes } from "./movies.ts";

const POSTER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

let workDir: string;
let root: string;
let db: Db;
let app: FastifyInstance;

interface Fixture {
  title: string;
  year: number | null;
  description?: string;
  poster?: boolean;
  addedAt: Date;
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mc-movies-"));
  root = join(workDir, "library");
  await mkdir(root, { recursive: true });

  const dbPath = join(workDir, "catalog.sqlite");
  migrate(dbPath);
  db = createDb(dbPath);

  const fixtures: Fixture[] = [
    {
      title: "Blade Runner",
      year: 1982,
      description: "A blade runner must pursue replicants.",
      poster: true,
      addedAt: new Date("2024-01-02T00:00:00Z"),
    },
    {
      title: "Arrival",
      year: 2016,
      description: "A linguist learns an alien language.",
      addedAt: new Date("2024-03-04T00:00:00Z"),
    },
    {
      title: "Amélie",
      year: 2001,
      addedAt: new Date("2024-02-03T00:00:00Z"),
    },
    {
      title: "The Matrix",
      year: null,
      addedAt: new Date("2024-04-05T00:00:00Z"),
    },
  ];

  for (const fixture of fixtures) {
    let posterPath: string | null = null;
    if (fixture.poster) {
      posterPath = join(root, `${fixture.title}.jpg`);
      await writeFile(posterPath, POSTER);
    }
    db.insert(mediaItems)
      .values({
        path: join(root, `${fixture.title}.mkv`),
        title: fixture.title,
        year: fixture.year,
        description: fixture.description ?? null,
        posterPath,
        durationMs: 5_400_000,
        createdAt: fixture.addedAt,
        updatedAt: fixture.addedAt,
      })
      .run();
  }

  app = Fastify({ logger: { level: "silent" } });
  await app.register(moviesRoutes, { db, movieRoot: root });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(workDir, { recursive: true, force: true });
});

interface MovieItem {
  id: number;
  title: string;
  year: number | null;
  description: string | null;
  durationMs: number | null;
  posterUrl: string | null;
  addedAt: string;
}

const eqTitle = (title: string) => eq(mediaItems.title, title);

async function getMovies(query = ""): Promise<{
  items: MovieItem[];
  total: number;
  limit: number;
  offset: number;
}> {
  const res = await app.inject({ method: "GET", url: `/api/movies${query}` });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("GET /api/movies", () => {
  it("lists every movie with a total count", async () => {
    const body = await getMovies();
    expect(body.total).toBe(4);
    expect(body.items).toHaveLength(4);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("returns the fields the library page needs", async () => {
    const body = await getMovies();
    const blade = body.items.find((item) => item.title === "Blade Runner");
    expect(blade?.year).toBe(1982);
    expect(blade?.durationMs).toBe(5_400_000);
    expect(blade?.description).toBe("A blade runner must pursue replicants.");
    expect(blade?.posterUrl).toMatch(/^\/api\/posters\/\d+$/);
    expect(blade?.addedAt).toBe("2024-01-02T00:00:00.000Z");
  });

  it("searches by title, whatever the case", async () => {
    const body = await getMovies("?q=arrival");
    expect(body.total).toBe(1);
    expect(body.items[0]?.title).toBe("Arrival");
  });

  it("does not treat the wildcards of a search as a pattern", async () => {
    const body = await getMovies("?q=%25");
    expect(body.total).toBe(0);
    expect(body.items).toHaveLength(0);
  });

  it("sorts by title", async () => {
    const body = await getMovies("?sort=title");
    expect(body.items.map((item) => item.title)).toEqual([
      "Amélie",
      "Arrival",
      "Blade Runner",
      "The Matrix",
    ]);

    const descending = await getMovies("?sort=title&order=desc");
    expect(descending.items.map((item) => item.title)).toEqual([
      "The Matrix",
      "Blade Runner",
      "Arrival",
      "Amélie",
    ]);
  });

  it("sorts by year and puts the movies without a year last", async () => {
    const body = await getMovies("?sort=year");
    expect(body.items.map((item) => item.year)).toEqual([1982, 2001, 2016, null]);

    const descending = await getMovies("?sort=year&order=desc");
    expect(descending.items.map((item) => item.year)).toEqual([2016, 2001, 1982, null]);
  });

  it("sorts by the moment the movie was added", async () => {
    const body = await getMovies("?sort=added");
    expect(body.items.map((item) => item.title)).toEqual([
      "Blade Runner",
      "Amélie",
      "Arrival",
      "The Matrix",
    ]);
  });

  it("filters by year", async () => {
    const body = await getMovies("?year=2016");
    expect(body.total).toBe(1);
    expect(body.items[0]?.title).toBe("Arrival");
  });

  it("pages through the movies and still reports the whole total", async () => {
    const first = await getMovies("?sort=title&limit=2&offset=0");
    expect(first.items.map((item) => item.title)).toEqual(["Amélie", "Arrival"]);
    expect(first.total).toBe(4);
    expect(first.limit).toBe(2);
    expect(first.offset).toBe(0);

    const second = await getMovies("?sort=title&limit=2&offset=2");
    expect(second.items.map((item) => item.title)).toEqual([
      "Blade Runner",
      "The Matrix",
    ]);
    expect(second.total).toBe(4);
    expect(second.offset).toBe(2);
  });

  it("keeps the order of the list stable between two calls", async () => {
    const first = await getMovies("?sort=year");
    const second = await getMovies("?sort=year");
    expect(second.items.map((item) => item.id)).toEqual(
      first.items.map((item) => item.id),
    );
  });

  it("shortens a long description", async () => {
    db.update(mediaItems)
      .set({ description: "x".repeat(500) })
      .where(eqTitle("Blade Runner"))
      .run();

    const body = await getMovies("?q=blade");
    expect(body.items[0]?.description?.length).toBeLessThanOrEqual(201);

    db.update(mediaItems)
      .set({ description: "A blade runner must pursue replicants." })
      .where(eqTitle("Blade Runner"))
      .run();
  });

  it("refuses a query it cannot understand", async () => {
    const res = await app.inject({ method: "GET", url: "/api/movies?limit=0" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");

    const unknownSort = await app.inject({
      method: "GET",
      url: "/api/movies?sort=colour",
    });
    expect(unknownSort.statusCode).toBe(400);
  });
});

describe("GET /api/posters/:id", () => {
  it("serves the poster of a movie", async () => {
    const body = await getMovies("?q=blade");
    const id = body.items[0]!.id;

    const res = await app.inject({ method: "GET", url: `/api/posters/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.rawPayload).toEqual(POSTER);
  });

  it("answers 404 for a movie without a poster", async () => {
    const body = await getMovies("?q=arrival");
    const id = body.items[0]!.id;

    const res = await app.inject({ method: "GET", url: `/api/posters/${id}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("answers 404 for a movie that does not exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/posters/9999" });
    expect(res.statusCode).toBe(404);
  });

  it("refuses an id that is not a number", async () => {
    const res = await app.inject({ method: "GET", url: "/api/posters/abc" });
    expect(res.statusCode).toBe(400);
  });
});
