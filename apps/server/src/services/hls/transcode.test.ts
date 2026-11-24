import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type Db } from "../../db/client.ts";
import { migrate } from "../../db/migrate.ts";
import { mediaItems } from "../../db/schema.ts";
import {
  HlsError,
  isWebFriendlyContainer,
  masterPlaylist,
  transcodeToHls,
} from "./transcode.ts";

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

let workDir: string;
let root: string;
let cacheDir: string;
let db: Db;
let movieId: number;
let moviePath: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mc-hls-"));
  root = join(workDir, "library");
  cacheDir = join(workDir, "cache");
  await mkdir(root, { recursive: true });

  const dbPath = join(workDir, "catalog.sqlite");
  migrate(dbPath);
  db = createDb(dbPath);

  moviePath = join(root, "Some.Movie.2020.mkv");
  if (hasFfmpeg) {
    // A real matroska file: the browser cannot play it itself, so it has
    // to be transcoded.
    await execFileAsync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=4:size=320x240:rate=10",
      "-c:v",
      "mpeg4",
      moviePath,
    ]);
  } else {
    await writeFile(moviePath, "not a movie");
  }

  const result = db
    .insert(mediaItems)
    .values({
      path: moviePath,
      title: "Some Movie",
      container: "matroska",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  movieId = Number(result.lastInsertRowid);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("masterPlaylist", () => {
  it("lists the renditions with their bandwidth", () => {
    const playlist = masterPlaylist([
      { name: "720p", bandwidth: 2_500_000, resolution: "1280x720" },
      { name: "480p", bandwidth: 1_200_000, resolution: null },
    ]);

    expect(playlist.startsWith("#EXTM3U\n")).toBe(true);
    expect(playlist).toContain(
      "#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720\n720p/index.m3u8",
    );
    expect(playlist).toContain("#EXT-X-STREAM-INF:BANDWIDTH=1200000\n480p/index.m3u8");
  });
});

describe("isWebFriendlyContainer", () => {
  it("knows what a browser can play itself", () => {
    expect(isWebFriendlyContainer("mov,mp4,m4a,3gp,3g2,mj2")).toBe(true);
    expect(isWebFriendlyContainer("matroska,webm")).toBe(true);
    expect(isWebFriendlyContainer("matroska")).toBe(false);
    expect(isWebFriendlyContainer(null)).toBe(false);
  });
});

describe("transcodeToHls", () => {
  it.skipIf(!hasFfmpeg)(
    "turns a mkv into a master playlist with two renditions",
    async () => {
      const cache = await transcodeToHls({ db, movieRoot: root, cacheDir }, movieId);

      expect(cache.cached).toBe(false);
      expect(cache.renditions).toHaveLength(2);
      expect(cache.renditions.map((rendition) => rendition.name)).toEqual([
        "720p",
        "480p",
      ]);
      // The source is smaller than the renditions, so it is not blown up.
      expect(cache.renditions[0]?.resolution).toBe("320x240");

      const master = await readFile(cache.masterPath, "utf8");
      expect(master.startsWith("#EXTM3U")).toBe(true);
      expect(master).toContain("720p/index.m3u8");
      expect(master).toContain("480p/index.m3u8");

      for (const rendition of cache.renditions) {
        const playlist = await readFile(rendition.playlistPath, "utf8");
        expect(playlist).toContain("#EXTM3U");
        expect(playlist).toContain("#EXT-X-TARGETDURATION");
        expect(playlist).toMatch(/segment_\d{5}\.ts/);
      }
    },
  );

  it.skipIf(!hasFfmpeg)("reuses the cache when the movie has not changed", async () => {
    const first = await transcodeToHls({ db, movieRoot: root, cacheDir }, movieId);
    const before = (await stat(first.masterPath)).mtimeMs;

    const second = await transcodeToHls({ db, movieRoot: root, cacheDir }, movieId);

    expect(second.cached).toBe(true);
    expect(second.masterPath).toBe(first.masterPath);
    expect(second.renditions.map((rendition) => rendition.name)).toEqual([
      "720p",
      "480p",
    ]);
    // The playlist was not written again: the same file is still there.
    expect((await stat(second.masterPath)).mtimeMs).toBe(before);
  });

  it.skipIf(!hasFfmpeg)(
    "transcodes again when the movie on disk has changed",
    async () => {
      const first = await transcodeToHls({ db, movieRoot: root, cacheDir }, movieId);
      // A new file with the same name: the fingerprint changes with it.
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

      const second = await transcodeToHls({ db, movieRoot: root, cacheDir }, movieId);
      expect(second.cached).toBe(false);
      expect(second.directory).toBe(first.directory);
    },
  );

  it("reports a missing ffmpeg", async () => {
    await expect(
      transcodeToHls(
        {
          db,
          movieRoot: root,
          // A cache of its own: otherwise the segments of an earlier
          // transcode would be reused and ffmpeg never asked.
          cacheDir: join(cacheDir, "no-ffmpeg"),
          ffmpegPath: join(tmpdir(), "no-such-ffmpeg"),
        },
        movieId,
      ),
    ).rejects.toBeInstanceOf(HlsError);
  });

  it("reports a movie that is not in the catalog", async () => {
    await expect(
      transcodeToHls({ db, movieRoot: root, cacheDir }, 4242),
    ).rejects.toThrow(/no movie with id/);
  });
});
