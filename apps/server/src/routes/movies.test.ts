import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { buildApp } from "../app.ts";
import { createDb, type Db } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { mediaItems, subtitleTracks } from "../db/schema.ts";
import type { Config } from "../config.ts";
import { moviesRoutes } from "./movies.ts";

describe("GET /api/movies and /api/posters/:id", () => {
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
    await app.register(moviesRoutes, {
      db,
      movieRoot: root,
      cacheDir: join(workDir, "cache"),
    });
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
});

describe("GET /api/movies/:id", () => {
  let workDir: string;
  let movieRoot: string;
  let cacheDir: string;
  let outsideDir: string;
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "mc-movies-api-"));
    movieRoot = join(workDir, "library");
    cacheDir = join(workDir, "cache");
    outsideDir = join(workDir, "outside");
    await mkdir(join(movieRoot, "Movies"), { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    const dbPath = join(workDir, "catalog.sqlite");
    migrate(dbPath);
    db = createDb(dbPath);

    const config: Config = {
      HOST: "127.0.0.1",
      PORT: 0,
      MOVIE_ROOT: movieRoot,
      DB_PATH: dbPath,
      CACHE_DIR: cacheDir,
      LOG_LEVEL: "silent",
    };
    app = await buildApp(config);
  });

  afterEach(async () => {
    await app.close();
    await rm(workDir, { recursive: true, force: true });
  });

  function addMovie(overrides: Partial<typeof mediaItems.$inferInsert> = {}) {
    return db
      .insert(mediaItems)
      .values({
        path: join(movieRoot, "Movies", "Some Movie (2020).mp4"),
        title: "Some Movie",
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      })
      .run();
  }

  function addTrack(
    mediaItemId: number,
    overrides: Partial<typeof subtitleTracks.$inferInsert> = {},
  ) {
    return db
      .insert(subtitleTracks)
      .values({
        mediaItemId,
        path: join(movieRoot, "Movies", "Some Movie (2020).en.srt"),
        format: "srt",
        createdAt: new Date(),
        ...overrides,
      })
      .run();
  }

  it("returns the full detail of a movie", async () => {
    const result = addMovie({
      year: 2020,
      description: "A story.",
      posterPath: join(movieRoot, "Movies", "poster.jpg"),
      durationMs: 5_400_000,
      width: 1920,
      height: 1080,
      videoCodec: "h264",
      container: "mp4",
      sizeBytes: 1_000_000,
    });
    const id = Number(result.lastInsertRowid);
    addTrack(id, {
      language: "en",
      isPrimary: true,
      vttPath: join(cacheDir, "subtitles", "1.vtt"),
    });
    addTrack(id, {
      path: join(movieRoot, "Movies", "Some Movie (2020).de.srt"),
      language: "de",
      vttPath: null,
    });

    const res = await app.inject({ method: "GET", url: `/api/movies/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.movie).toMatchObject({
      id,
      title: "Some Movie",
      year: 2020,
      description: "A story.",
      durationMs: 5_400_000,
      videoCodec: "h264",
      container: "mp4",
    });
    expect(body.movie.posterUrl).toBe(`/api/posters/${id}`);
    expect(body.movie.subtitles).toEqual([
      expect.objectContaining({
        language: "en",
        isPrimary: true,
        vttUrl: `/api/subtitles/1.vtt`,
      }),
      expect.objectContaining({ language: "de", vttUrl: null }),
    ]);
  });

  it("answers 404 with the error envelope for an unknown id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/movies/4242" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: "MOVIE_NOT_FOUND" });
  });

  it("answers 400 for an id that is not a number", async () => {
    const res = await app.inject({ method: "GET", url: "/api/movies/abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "INVALID_ID" });
  });

  it("advertises progressive when the file is servable and nothing else", async () => {
    const file = join(movieRoot, "Movies", "Some Movie (2020).mp4");
    await writeFile(file, "a movie");
    const id = Number(addMovie({ path: file }).lastInsertRowid);

    const res = await app.inject({ method: "GET", url: `/api/movies/${id}` });
    expect(res.json().movie.playbackModes).toEqual(["progressive"]);
    expect(res.json().movie.streamUrl).toBe(`/api/stream/${id}`);
    expect(res.json().movie.hlsUrl).toBeNull();
  });

  it("does not advertise progressive for a missing file", async () => {
    const id = Number(addMovie().lastInsertRowid);
    const res = await app.inject({ method: "GET", url: `/api/movies/${id}` });
    expect(res.json().movie.playbackModes).toEqual([]);
    expect(res.json().movie.streamUrl).toBeNull();
  });

  it("does not advertise progressive for a catalog row that escapes the root", async () => {
    const secret = join(outsideDir, "secret.mp4");
    await writeFile(secret, "a secret");
    const link = join(movieRoot, "Movies", "escape.mp4");
    await symlink(secret, link);
    const id = Number(addMovie({ path: link }).lastInsertRowid);

    const res = await app.inject({ method: "GET", url: `/api/movies/${id}` });
    expect(res.json().movie.playbackModes).toEqual([]);
  });

  it("advertises hls when the cache holds a playlist", async () => {
    const file = join(movieRoot, "Movies", "Some Movie (2020).mp4");
    await writeFile(file, "a movie");
    await mkdir(join(cacheDir, "hls", "1"), { recursive: true });
    await writeFile(join(cacheDir, "hls", "1", "master.m3u8"), "#EXTM3U");
    const id = Number(addMovie({ path: file }).lastInsertRowid);

    const res = await app.inject({ method: "GET", url: `/api/movies/${id}` });
    expect(res.json().movie.playbackModes).toEqual(["progressive", "hls"]);
    expect(res.json().movie.hlsUrl).toBe(`/api/hls/${id}/master.m3u8`);
  });

  it("omits posterUrl when the movie has no poster", async () => {
    const id = Number(addMovie().lastInsertRowid);
    const res = await app.inject({ method: "GET", url: `/api/movies/${id}` });
    expect(res.json().movie.posterUrl).toBeNull();
  });
});
