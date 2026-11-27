import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { LibraryWatcher } from "./watcher.ts";

let root: string;
const watchers: LibraryWatcher[] = [];

afterEach(async () => {
  for (const watcher of watchers.splice(0)) await watcher.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met in time");
}

it("triggers a rescan when a file is added, within the debounce window", async () => {
  root = await mkdtemp(join(tmpdir(), "mc-watch-"));
  let rescans = 0;
  const watcher = new LibraryWatcher({
    movieRoot: root,
    rescan: () => {
      rescans += 1;
    },
    debounceMs: 100,
  });
  watchers.push(watcher);
  await watcher.start();

  await writeFile(join(root, "Some.Movie.2020.mkv"), "x");
  await waitFor(() => rescans > 0);
  expect(rescans).toBe(1);
});

it("debounces a burst of changes into a single rescan", async () => {
  root = await mkdtemp(join(tmpdir(), "mc-watch-"));
  let rescans = 0;
  const watcher = new LibraryWatcher({
    movieRoot: root,
    rescan: () => {
      rescans += 1;
    },
    debounceMs: 100,
  });
  watchers.push(watcher);
  await watcher.start();

  for (let i = 0; i < 10; i++) {
    await writeFile(join(root, `Movie.${i}.mkv`), "x");
  }
  await waitFor(() => rescans > 0);
  expect(rescans).toBe(1);
});

it("stops watching: no rescan fires after stop", async () => {
  root = await mkdtemp(join(tmpdir(), "mc-watch-"));
  let rescans = 0;
  const watcher = new LibraryWatcher({
    movieRoot: root,
    rescan: () => {
      rescans += 1;
    },
    debounceMs: 50,
  });
  await watcher.start();
  await watcher.stop();

  await writeFile(join(root, "Late.Movie.2021.mkv"), "x");
  // A stopped watcher must stay silent; give a stray event time to fire.
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(rescans).toBe(0);
});

it("watches a directory that does not exist yet", async () => {
  root = await mkdtemp(join(tmpdir(), "mc-watch-"));
  const movies = join(root, "movies");
  let rescans = 0;
  const watcher = new LibraryWatcher({
    movieRoot: movies,
    rescan: () => {
      rescans += 1;
    },
    debounceMs: 100,
  });
  watchers.push(watcher);
  await watcher.start();

  await mkdir(movies, { recursive: true });
  await writeFile(join(movies, "New.Movie.2022.mkv"), "x");
  await waitFor(() => rescans > 0);
  expect(rescans).toBe(1);
});

it("does not rescan when a file lands in an ignored directory", async () => {
  root = await mkdtemp(join(tmpdir(), "mc-watch-"));
  const cache = join(root, ".cache");
  await mkdir(cache, { recursive: true });
  let rescans = 0;
  const watcher = new LibraryWatcher({
    movieRoot: root,
    ignoredPaths: [cache],
    rescan: () => {
      rescans += 1;
    },
    debounceMs: 100,
  });
  watchers.push(watcher);
  await watcher.start();

  // What the server writes into its cache: a converted subtitle.
  await writeFile(join(cache, "Some.Movie.2020.en.vtt"), "WEBVTT\n");
  // A rescan would fire one debounce after the write; wait longer than
  // that and expect silence.
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(rescans).toBe(0);
});

it("still rescans when a movie is added next to an ignored directory", async () => {
  root = await mkdtemp(join(tmpdir(), "mc-watch-"));
  const cache = join(root, ".cache");
  await mkdir(cache, { recursive: true });
  let rescans = 0;
  const watcher = new LibraryWatcher({
    movieRoot: root,
    ignoredPaths: [cache],
    rescan: () => {
      rescans += 1;
    },
    debounceMs: 100,
  });
  watchers.push(watcher);
  await watcher.start();

  await writeFile(join(root, "Some.Movie.2020.mkv"), "x");
  await waitFor(() => rescans > 0);
  expect(rescans).toBe(1);
});

it("keeps watching when an ignored path would hold the movie root", async () => {
  root = await mkdtemp(join(tmpdir(), "mc-watch-"));
  let rescans = 0;
  const watcher = new LibraryWatcher({
    movieRoot: root,
    // A cache set to the movie root itself cannot be ignored — every
    // path of the library lies inside it — so the watcher stays alive
    // rather than going quiet for ever.
    ignoredPaths: [root],
    rescan: () => {
      rescans += 1;
    },
    debounceMs: 100,
  });
  watchers.push(watcher);
  await watcher.start();

  await writeFile(join(root, "Some.Movie.2020.mkv"), "x");
  await waitFor(() => rescans > 0);
  expect(rescans).toBe(1);
});
