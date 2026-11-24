import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, it } from "vitest";

import { buildApp } from "./app.ts";
import type { Config } from "./config.ts";
import { createDb } from "./db/client.ts";
import { migrate } from "./db/migrate.ts";
import { mediaItems } from "./db/schema.ts";

let workDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

afterAll(async () => {
  await app.close();
  await rm(workDir, { recursive: true, force: true });
});

it("a change in the library is scanned automatically, and only while the app lives", async () => {
  workDir = await mkdtemp(join(tmpdir(), "mc-lifecycle-"));
  const movieRoot = join(workDir, "movies");
  const dbPath = join(workDir, "catalog.sqlite");
  await mkdir(movieRoot, { recursive: true });
  migrate(dbPath);

  const config: Config = {
    HOST: "127.0.0.1",
    PORT: 0,
    MOVIE_ROOT: movieRoot,
    DB_PATH: dbPath,
    CACHE_DIR: join(workDir, "cache"),
    LOG_LEVEL: "silent",
  };
  app = await buildApp(config);
  const db = createDb(dbPath);
  const count = () => db.select().from(mediaItems).all().length;

  // Drop a movie into the library: the watcher rescan catalogs it on its own.
  await writeFile(join(movieRoot, "Some.Movie.2020.mkv"), "x");
  for (let attempt = 0; attempt < 1000 && count() === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(count()).toBe(1);

  // Closing the app stops the watcher: further changes are not scanned.
  await app.close();
  await writeFile(join(movieRoot, "Another.Movie.2021.mkv"), "x");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  expect(count()).toBe(1);
});
