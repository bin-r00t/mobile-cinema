import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import type { Config } from "../config.ts";
import { createDb } from "../db/client.ts";
import { mediaItems } from "../db/schema.ts";

const VIDEO_COUNT = 300;

/** The fixtures are not real movies, so a missing ffprobe keeps the test honest. */
const NO_FFPROBE = "/definitely/not/here/ffprobe";

let workDir = "";
let dbPath = "";
let movieRoot = "";
let app: Awaited<ReturnType<typeof buildApp>>;

interface RunView {
  id: string;
  status: string;
  finishedAt: string | null;
  progress: { total: number; processed: number };
  counts: { videos: number };
  errors: { count: number; sample: string[] };
}

async function trigger(): Promise<{
  res: { statusCode: number };
  body: { runId: string; alreadyRunning: boolean };
}> {
  const res = await app.inject({ method: "POST", url: "/api/scan" });
  return { res, body: res.json() as { runId: string; alreadyRunning: boolean } };
}

async function status(): Promise<{ state: string; run: RunView | null }> {
  const res = await app.inject({ method: "GET", url: "/api/scan/status" });
  return res.json() as { state: string; run: RunView | null };
}

/** Waits until the runner is idle again. */
async function waitForIdle(): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    const payload = await status();
    if (payload.state === "idle") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the scan did not finish");
}

async function runs(): Promise<RunView[]> {
  const res = await app.inject({ method: "GET", url: "/api/scan/runs" });
  return (res.json() as { runs: RunView[] }).runs;
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mobile-cinema-scan-api-"));
  movieRoot = join(workDir, "movies");
  dbPath = join(workDir, "catalog.sqlite");
  await mkdir(movieRoot, { recursive: true });

  for (let i = 0; i < VIDEO_COUNT; i++) {
    const dir = join(movieRoot, `Movie ${i}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `Some.Movie.${2000 + (i % 25)}.1080p.mkv`), "x");
  }
  await writeFile(join(movieRoot, "notes.txt"), "not a video");

  const config: Config = {
    HOST: "127.0.0.1",
    PORT: 0,
    MOVIE_ROOT: movieRoot,
    DB_PATH: dbPath,
    CACHE_DIR: join(workDir, "cache"),
    FFPROBE_PATH: NO_FFPROBE,
    LOG_LEVEL: "silent",
  };
  app = await buildApp(config);
});

afterAll(async () => {
  await app.close();
  await rm(workDir, { recursive: true, force: true });
});

it("POST /api/scan starts a run, and the status endpoint reports its progress", async () => {
  const { res, body } = await trigger();
  expect(res.statusCode).toBe(202);
  expect(body.alreadyRunning).toBe(false);
  expect(body.runId).toBeTruthy();

  // While the run is going the status endpoint reports its progress: the
  // run id and the counters, which move towards the discovered total.
  let sawProgress = false;
  let previousProcessed = 0;
  for (let attempt = 0; attempt < 5000; attempt++) {
    const payload = await status();
    if (payload.state === "running") {
      expect(payload.run?.id).toBe(body.runId);
      const { total, processed } = payload.run!.progress;
      expect(processed).toBeLessThanOrEqual(total);
      expect(processed).toBeGreaterThanOrEqual(previousProcessed);
      previousProcessed = processed;
      sawProgress = true;
      if (total === VIDEO_COUNT && processed === VIDEO_COUNT) break;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(sawProgress).toBe(true);

  await waitForIdle();

  // The finished run is reported with its counts and its error summary.
  const finished = (await status()).run;
  expect(finished?.id).toBe(body.runId);
  expect(finished?.status).toBe("completed");
  expect(finished?.counts.videos).toBe(VIDEO_COUNT);
  expect(finished?.errors.count).toBe(0);
  expect(finished?.finishedAt).toBeTruthy();
}, 60000);

it("the run scans the library into the catalog", async () => {
  // The scan really walks the files: every movie of the root has a row.
  const db = createDb(dbPath);
  const rows = db.select().from(mediaItems).all();
  expect(rows.length).toBe(VIDEO_COUNT);
  expect(rows.map((row) => row.title).every((title) => title.length > 0)).toBe(true);
}, 60000);

it("the finished run is in the history, newest first", async () => {
  const list = await runs();
  expect(list.length).toBeGreaterThan(0);
  const ids = list.map((run) => Number(run.id));
  expect(ids).toEqual([...ids].sort((a, b) => b - a));
  expect(list.every((run) => run.status === "completed")).toBe(true);
}, 60000);

it("concurrent scan requests do not start two overlapping runs", async () => {
  await waitForIdle();
  const before = (await runs()).length;

  const results = await Promise.all(Array.from({ length: 5 }, () => trigger()));

  const runIds = new Set(results.map(({ body }) => body.runId));
  expect(runIds.size).toBe(1);
  expect(results.filter(({ res }) => res.statusCode === 202).length).toBe(1);
  expect(results.filter(({ res }) => res.statusCode === 200).length).toBe(4);
  expect(results.filter(({ body }) => body.alreadyRunning).length).toBe(4);

  await waitForIdle();

  // One run was started, so the history grew by one row and not by five.
  const list = await runs();
  expect(list.length).toBe(before + 1);
  expect(list.filter((run) => run.id === results[0]!.body.runId)).toHaveLength(1);
}, 60000);
