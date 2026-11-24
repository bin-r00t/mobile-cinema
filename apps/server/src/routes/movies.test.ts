import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createDb, type Db } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { mediaItems, subtitleTracks } from "../db/schema.ts";
import type { Config } from "../config.ts";

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
  addTrack(id, { language: "en", isPrimary: true, vttPath: join(cacheDir, "subtitles", "1.vtt") });
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
  expect(body.movie.posterUrl).toBe(`/api/movies/${id}/poster`);
  expect(body.movie.subtitles).toEqual([
    expect.objectContaining({ language: "en", isPrimary: true, vttUrl: `/api/subtitles/1.vtt` }),
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
  expect(res.json().movie.streamUrl).toBe(`/api/movies/${id}/stream`);
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
  await writeFile(join(cacheDir, "hls", "1", "index.m3u8"), "#EXTM3U");
  const id = Number(addMovie({ path: file }).lastInsertRowid);

  const res = await app.inject({ method: "GET", url: `/api/movies/${id}` });
  expect(res.json().movie.playbackModes).toEqual(["progressive", "hls"]);
  expect(res.json().movie.hlsUrl).toBe(`/api/movies/${id}/hls/index.m3u8`);
});

it("omits posterUrl when the movie has no poster", async () => {
  const id = Number(addMovie().lastInsertRowid);
  const res = await app.inject({ method: "GET", url: `/api/movies/${id}` });
  expect(res.json().movie.posterUrl).toBeNull();
});
