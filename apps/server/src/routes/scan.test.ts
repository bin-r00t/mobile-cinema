import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import type { Config } from "../config.ts";

const VIDEO_COUNT = 300;

let movieRoot = "";
let app: Awaited<ReturnType<typeof buildApp>>;

async function waitForIdle(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const res = await app.inject({ method: "GET", url: "/api/scan/status" });
    if (res.json().state === "idle") return;
    // A real timer lets the run take the loop between polls; a tight
    // setImmediate spin would ping-pong with it and slow the scan down.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the scan did not finish");
}

async function trigger() {
  const res = await app.inject({ method: "POST", url: "/api/scan" });
  return { res, body: res.json() as { runId: string; alreadyRunning: boolean } };
}

afterAll(async () => {
  await app.close();
  await rm(movieRoot, { recursive: true, force: true });
});

it("POST /api/scan starts a run and the status endpoint reports its progress", async () => {
  movieRoot = await mkdtemp(join(tmpdir(), "mobile-cinema-scan-"));
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
    DB_PATH: join(movieRoot, "test.db"),
    CACHE_DIR: join(movieRoot, "cache"),
    LOG_LEVEL: "silent",
  };
  app = await buildApp(config);

  const { res, body } = await trigger();
  expect(res.statusCode).toBe(202);
  expect(body.alreadyRunning).toBe(false);
  expect(body.runId).toBeTruthy();

  // While the run is going the status endpoint reports its progress: the
  // run id and the counters, which move towards the discovered total.
  let sawProgress = false;
  let previousProcessed = 0;
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await app.inject({ method: "GET", url: "/api/scan/status" });
    const payload = status.json() as {
      state: string;
      run: {
        id: string;
        progress: { total: number; processed: number };
      } | null;
    };
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

  // The finished run is in the history with counts and an error summary.
  const runs = await app.inject({ method: "GET", url: "/api/scan/runs" });
  expect(runs.statusCode).toBe(200);
  const list = (runs.json() as { runs: Array<Record<string, unknown>> }).runs;
  const finished = list.find((run) => run.id === body.runId);
  expect(finished).toMatchObject({
    status: "completed",
    counts: { videos: VIDEO_COUNT },
    errors: { count: 0, sample: [] },
    progress: { total: VIDEO_COUNT, processed: VIDEO_COUNT },
  });
  expect(finished?.finishedAt).toBeTruthy();
});

it("concurrent scan requests do not start two overlapping runs", async () => {
  await waitForIdle();

  const results = await Promise.all(
    Array.from({ length: 5 }, () => trigger()),
  );

  const runIds = new Set(results.map(({ body }) => body.runId));
  expect(runIds.size).toBe(1);
  expect(results.filter(({ res }) => res.statusCode === 202).length).toBe(1);

  await waitForIdle();

  const runs = await app.inject({ method: "GET", url: "/api/scan/runs" });
  const list = (runs.json() as { runs: Array<{ id: string }> }).runs;
  const matching = list.filter((run) => run.id === results[0]!.body.runId);
  expect(matching.length).toBe(1);
});
