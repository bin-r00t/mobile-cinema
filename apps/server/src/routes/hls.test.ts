import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import { createDb, type Db } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { mediaItems } from "../db/schema.ts";
import {
  transcodeToHls,
  type HlsCache,
  type TranscodeOptions,
} from "../services/hls/transcode.ts";
import { hlsRoutes, type Transcoder } from "./hls.ts";

const execFileAsync = promisify(execFile);

async function binaryExists(name: string): Promise<boolean> {
  try {
    await execFileAsync(name, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

const hasFfmpeg = await binaryExists("ffmpeg");

/** Lets the microtasks and the timers of the server run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

let workDir: string;
let root: string;
let cacheDir: string;
let db: Db;
let movieId: number;
let app: FastifyInstance;

/**
 * Collects the lines the server writes to its log, so a test can check
 * what the operator sees.
 */
class LogCapture {
  lines: string[] = [];

  write(line: string): void {
    this.lines.push(line);
  }
}

/** Set when the transcode of the test movie is through. */
let transcodeDone: Promise<void>;
let transcodeStarted = false;
let transcoder: Transcoder;

beforeEach(async () => {
  transcodeStarted = false;
  workDir = await mkdtemp(join(tmpdir(), "mc-hls-route-"));
  root = join(workDir, "library");
  cacheDir = join(workDir, "cache");
  await mkdir(root, { recursive: true });

  const dbPath = join(workDir, "catalog.sqlite");
  migrate(dbPath);
  db = createDb(dbPath);

  const moviePath = join(root, "Some.Movie.2020.mkv");
  if (hasFfmpeg) {
    // A real matroska file: the browser cannot play it itself.
    await execFileAsync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=2:size=320x240:rate=10",
      "-c:v",
      "mpeg4",
      moviePath,
    ]);
  } else {
    await writeFile(moviePath, "not a movie");
  }

  const row = db
    .insert(mediaItems)
    .values({ path: moviePath, title: "Some Movie", container: "matroska" })
    .returning({ id: mediaItems.id })
    .get();
  movieId = row.id;

  transcodeDone = new Promise((resolve) => {
    /**
     * The transcoder of the test: the real one, so the cache on disk is
     * the real thing, with a promise that says when it is through.
     */
    transcoder = async (
      options: TranscodeOptions,
      mediaItemId: number,
    ): Promise<HlsCache> => {
      transcodeStarted = true;
      try {
        return await transcodeToHls(options, mediaItemId);
      } finally {
        resolve();
      }
    };
  });

  app = Fastify({ logger: false });
  await app.register(hlsRoutes, {
    db,
    movieRoot: root,
    cacheDir,
    transcoder,
    retryAfterSeconds: 1,
  });
});

afterEach(async () => {
  await app.close();
  // The transcode writes into the cache: it has to be through before the
  // temporary tree goes away.
  if (transcodeStarted) {
    await Promise.race([
      transcodeDone,
      new Promise((resolve) => setTimeout(resolve, 30_000)),
    ]);
  }
  await rm(workDir, { recursive: true, force: true });
});

describe("GET /api/hls/:id/master.m3u8", () => {
  it("answers a non-numeric id with a 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/hls/nope/master.m3u8" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ID");
  });

  it("answers an id the catalog does not know with a 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/hls/9999/master.m3u8" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("answers 202 with a retry hint while the transcode is running", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/hls/${movieId}/master.m3u8`,
    });

    expect(res.statusCode).toBe(202);
    expect(res.headers["retry-after"]).toBe("1");
    expect(res.json().status).toBe("transcoding");
    expect(res.json().mediaItemId).toBe(movieId);
    expect(res.json().retryAfterMs).toBe(1000);
  });

  it("keeps answering 202 while the transcode is still running", async () => {
    await app.inject({ method: "GET", url: `/api/hls/${movieId}/master.m3u8` });

    const second = await app.inject({
      method: "GET",
      url: `/api/hls/${movieId}/master.m3u8`,
    });

    expect(second.statusCode).toBe(202);
    expect(second.json().status).toBe("transcoding");
  });

  it.skipIf(!hasFfmpeg)("serves the playlist once the transcode is ready", async () => {
    await app.inject({ method: "GET", url: `/api/hls/${movieId}/master.m3u8` });
    await transcodeDone;

    const res = await app.inject({
      method: "GET",
      url: `/api/hls/${movieId}/master.m3u8`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.apple.mpegurl");
    expect(res.headers["cache-control"]).toBe("no-cache");

    const playlist = res.body;
    expect(playlist.startsWith("#EXTM3U")).toBe(true);
    expect(playlist).toContain("720p/index.m3u8");
    expect(playlist).toContain("480p/index.m3u8");
  });

  it.skipIf(!hasFfmpeg)("serves the playlist of a rendition and its segments", async () => {
    await app.inject({ method: "GET", url: `/api/hls/${movieId}/master.m3u8` });
    await transcodeDone;

    const variant = await app.inject({
      method: "GET",
      url: `/api/hls/${movieId}/720p/index.m3u8`,
    });

    expect(variant.statusCode).toBe(200);
    expect(variant.headers["content-type"]).toBe("application/vnd.apple.mpegurl");
    expect(variant.body).toContain("#EXTM3U");
    expect(variant.body).toMatch(/segment_\d{5}\.ts/);

    const segment = await app.inject({
      method: "GET",
      url: `/api/hls/${movieId}/720p/segment_00000.ts`,
    });

    expect(segment.statusCode).toBe(200);
    expect(segment.headers["content-type"]).toBe("video/mp2t");
    expect(segment.headers["content-length"]).toBe(
      String(segment.rawPayload.length),
    );
    expect(segment.rawPayload.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasFfmpeg)("answers a HEAD request with the headers and no body", async () => {
    await app.inject({ method: "GET", url: `/api/hls/${movieId}/master.m3u8` });
    await transcodeDone;

    const res = await app.inject({
      method: "HEAD",
      url: `/api/hls/${movieId}/master.m3u8`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.apple.mpegurl");
    expect(Number(res.headers["content-length"])).toBeGreaterThan(0);
    expect(res.rawPayload.length).toBe(0);
  });

  it("refuses to serve a file that climbs out of the cache", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/hls/${movieId}/..%2F..%2F..%2Fetc/secret.ts`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("refuses a file that is not an HLS file", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/hls/${movieId}/720p/movie.mp4`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("reports a transcode that did not work out", async () => {
    const failing = Fastify({ logger: false });
    await failing.register(hlsRoutes, {
      db,
      movieRoot: root,
      cacheDir,
      transcoder: async () => {
        throw new Error("ffmpeg exploded");
      },
      retryAfterSeconds: 1,
    });

    const first = await failing.inject({
      method: "GET",
      url: `/api/hls/${movieId}/master.m3u8`,
    });
    expect(first.statusCode).toBe(202);

    // The failure of the transcode is reported on the next request.
    await settle();
    const second = await failing.inject({
      method: "GET",
      url: `/api/hls/${movieId}/master.m3u8`,
    });

    expect(second.statusCode).toBe(500);
    expect(second.json().error.code).toBe("TRANSCODE_FAILED");
    expect(second.json().error.message).toBe("The movie could not be transcoded.");

    await failing.close();
  });

  it("keeps the detail of a failed transcode out of the answer and in the log", async () => {
    const log = new LogCapture();
    const failing = Fastify({ logger: { stream: log } });
    await failing.register(hlsRoutes, {
      db,
      movieRoot: root,
      cacheDir,
      transcoder: async () => {
        throw new Error("ffmpeg exploded: /tmp/secret/movie.mkv");
      },
      retryAfterSeconds: 1,
    });

    await failing.inject({
      method: "GET",
      url: `/api/hls/${movieId}/master.m3u8`,
    });
    await settle();
    const res = await failing.inject({
      method: "GET",
      url: `/api/hls/${movieId}/master.m3u8`,
    });

    expect(res.statusCode).toBe(500);
    // The stderr of ffmpeg and the paths of the machine stay in the log.
    expect(res.body).not.toContain("ffmpeg exploded");
    expect(res.body).not.toContain("/tmp/secret/movie.mkv");
    expect(res.body).not.toContain(root);
    expect(res.body).not.toContain(cacheDir);

    await failing.close();

    const written = log.lines.join("\n");
    expect(written).toContain("ffmpeg exploded");
    expect(written).toContain(String(movieId));
  });

  it("answers a movie the catalog does not know without a path", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/hls/9999/master.m3u8",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(res.body).not.toContain(root);
    expect(res.body).not.toContain(workDir);
  });
});
