import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { buildApp } from "../app.ts";
import type { Config } from "../config.ts";
import { createDb, type Db } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { mediaItems, subtitleTracks } from "../db/schema.ts";
import { parseWebVtt } from "../test/vtt.ts";

const SRT_EN = [
  "1",
  "00:00:01,000 --> 00:00:03,000",
  "First line of the script.",
  "",
  "2",
  "00:00:04,000 --> 00:00:06,500",
  "Second line of the script.",
  "",
].join("\n");

const SRT_DE = [
  "1",
  "00:00:01,000 --> 00:00:03,000",
  "Erste Zeile des Skripts.",
  "",
].join("\n");

const CACHED_VTT = [
  "WEBVTT",
  "",
  "00:00:01.000 --> 00:00:03.000",
  "First line of the script.",
  "",
  "00:00:04.000 --> 00:00:06.500",
  "Second line of the script.",
  "",
].join("\n");

describe("the subtitle routes", () => {
  let workDir: string;
  let movieRoot: string;
  let cacheDir: string;
  let db: Db;
  let app: FastifyInstance;
  let movieId: number;
  let englishTrackId: number;
  let germanTrackId: number;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "mc-subtitles-"));
    movieRoot = join(workDir, "library");
    cacheDir = join(workDir, "cache");
    await mkdir(join(movieRoot, "Movies"), { recursive: true });
    await mkdir(join(cacheDir, "subtitles"), { recursive: true });

    const dbPath = join(workDir, "catalog.sqlite");
    migrate(dbPath);
    db = createDb(dbPath);

    await writeFile(join(movieRoot, "Movies", "Some Movie (2020).en.srt"), SRT_EN);
    await writeFile(join(movieRoot, "Movies", "Some Movie (2020).de.srt"), SRT_DE);
    await writeFile(join(cacheDir, "subtitles", "en.vtt"), CACHED_VTT);

    const movie = db
      .insert(mediaItems)
      .values({
        path: join(movieRoot, "Movies", "Some Movie (2020).mp4"),
        title: "Some Movie",
        year: 2020,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    movieId = Number(movie.lastInsertRowid);

    const english = db
      .insert(subtitleTracks)
      .values({
        mediaItemId: movieId,
        path: join(movieRoot, "Movies", "Some Movie (2020).en.srt"),
        language: "en",
        format: "srt",
        isPrimary: true,
        vttPath: join(cacheDir, "subtitles", "en.vtt"),
        createdAt: new Date(),
      })
      .run();
    englishTrackId = Number(english.lastInsertRowid);

    const german = db
      .insert(subtitleTracks)
      .values({
        mediaItemId: movieId,
        path: join(movieRoot, "Movies", "Some Movie (2020).de.srt"),
        language: "de",
        format: "srt",
        isPrimary: false,
        vttPath: null,
        createdAt: new Date(),
      })
      .run();
    germanTrackId = Number(german.lastInsertRowid);

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

  describe("GET /api/subtitles/:id.vtt", () => {
    it("serves the WebVTT of a track", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/subtitles/${englishTrackId}.vtt`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("text/vtt; charset=utf-8");
      expect(res.body.startsWith("WEBVTT")).toBe(true);

      const parsed = parseWebVtt(res.body);
      expect(parsed.errors).toEqual([]);
      expect(parsed.cues.map((cue) => cue.text)).toEqual([
        "First line of the script.",
        "Second line of the script.",
      ]);
    });

    it("converts a track that has no converted file yet", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/subtitles/${germanTrackId}.vtt`,
      });

      expect(res.statusCode).toBe(200);
      const parsed = parseWebVtt(res.body);
      expect(parsed.errors).toEqual([]);
      expect(parsed.cues.map((cue) => cue.text)).toEqual(["Erste Zeile des Skripts."]);
    });

    it("answers 404 for a track that does not exist", async () => {
      const res = await app.inject({ method: "GET", url: "/api/subtitles/9999.vtt" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("SUBTITLE_NOT_FOUND");
    });

    it("answers 400 for an id that is not a number", async () => {
      const res = await app.inject({ method: "GET", url: "/api/subtitles/abc.vtt" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("INVALID_ID");
    });

    it("answers 404 when the subtitle file is gone", async () => {
      await rm(join(cacheDir, "subtitles", "en.vtt"));
      await rm(join(movieRoot, "Movies", "Some Movie (2020).en.srt"));

      const res = await app.inject({
        method: "GET",
        url: `/api/subtitles/${englishTrackId}.vtt`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("SUBTITLE_NOT_FOUND");
    });

    it("does not serve a converted file that lies outside the cache", async () => {
      const outside = join(workDir, "outside.vtt");
      await writeFile(outside, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nOutside.\n");
      db.update(subtitleTracks)
        .set({ vttPath: outside })
        .where(eq(subtitleTracks.id, englishTrackId))
        .run();

      // The file outside the cache is ignored; the subtitle of the movie
      // is converted instead.
      const res = await app.inject({
        method: "GET",
        url: `/api/subtitles/${englishTrackId}.vtt`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("Outside.");
      expect(parseWebVtt(res.body).cues).toHaveLength(2);
    });

    it("does not serve a converted file that a symbolic link smuggles out of the cache", async () => {
      const outside = join(workDir, "outside.vtt");
      await writeFile(outside, "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nOutside.\n");
      // A directory of the cache that is really a link somewhere else.
      await symlink(workDir, join(cacheDir, "linked"));
      db.update(subtitleTracks)
        .set({ vttPath: join(cacheDir, "linked", "outside.vtt") })
        .where(eq(subtitleTracks.id, englishTrackId))
        .run();

      const res = await app.inject({
        method: "GET",
        url: `/api/subtitles/${englishTrackId}.vtt`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("Outside.");
      expect(parseWebVtt(res.body).cues).toHaveLength(2);
    });
  });

  describe("GET /api/movies/:id/script", () => {
    it("returns the script of the default track", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/movies/${movieId}/script`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.movieId).toBe(movieId);
      expect(body.trackId).toBe(englishTrackId);
      expect(body.language).toBe("en");
      expect(body.fallback).toBe(false);
      expect(body.text).toBe(
        "First line of the script.\nSecond line of the script.",
      );
    });

    it("returns the script of the language that is asked for", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/movies/${movieId}/script?lang=de`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.trackId).toBe(germanTrackId);
      expect(body.language).toBe("de");
      expect(body.fallback).toBe(false);
      expect(body.text).toBe("Erste Zeile des Skripts.");
    });

    it("matches a language whatever the case", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/movies/${movieId}/script?lang=DE`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().language).toBe("de");
    });

    it("falls back to the primary track when the language is missing", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/movies/${movieId}/script?lang=fr`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.trackId).toBe(englishTrackId);
      expect(body.fallback).toBe(true);
      expect(body.text).toContain("First line of the script.");
    });

    it("answers 404 for a movie without subtitles", async () => {
      const movie = db
        .insert(mediaItems)
        .values({
          path: join(movieRoot, "Movies", "Other Movie (2021).mp4"),
          title: "Other Movie",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();

      const res = await app.inject({
        method: "GET",
        url: `/api/movies/${Number(movie.lastInsertRowid)}/script`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NO_SUBTITLES");
    });

    it("answers 404 for a movie that does not exist", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/movies/4242/script",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("MOVIE_NOT_FOUND");
    });

    it("answers 400 for an id that is not a number", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/movies/abc/script",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("INVALID_ID");
    });
  });
});
