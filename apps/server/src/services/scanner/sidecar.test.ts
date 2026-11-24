import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createFixtureLibrary, type FixtureLibrary } from "../../test/fixtures.ts";
import { mergeMetadata, readSidecar } from "./sidecar.ts";

let library: FixtureLibrary;
let dir: string;

beforeAll(async () => {
  library = await createFixtureLibrary();
  dir = await mkdtemp(join(tmpdir(), "mc-sidecar-test-"));
});

afterAll(async () => {
  await library.cleanup();
  await rm(dir, { recursive: true, force: true });
});

it("reads title, plot, year and runtime from the fixture NFO", async () => {
  const result = await readSidecar(library.files.video);
  expect(result.title).toBe("Some Movie");
  expect(result.description).toBe("A fixture movie about fixtures.");
  expect(result.year).toBe(2020);
  expect(result.runtimeMin).toBe(95);
  expect(result.warnings).toEqual([]);
});

it("returns the poster path when a sibling image exists", async () => {
  const result = await readSidecar(library.files.video);
  expect(result.posterPath).toBe(library.files.poster);
});

it("yields nulls without warnings when no sidecars exist", async () => {
  const result = await readSidecar(library.files.nestedVideo);
  expect(result).toMatchObject({
    title: null,
    description: null,
    year: null,
    runtimeMin: null,
    genre: null,
    rating: null,
    posterPath: null,
    warnings: [],
  });
});

it("an NFO plot wins over a .txt file", async () => {
  const video = join(dir, "both.mkv");
  await writeFile(video, "x");
  await writeFile(join(dir, "both.nfo"), "<movie><plot>From the NFO.</plot></movie>");
  await writeFile(join(dir, "both.txt"), "From the readme.");
  const result = await readSidecar(video);
  expect(result.description).toBe("From the NFO.");
});

it("falls back to the .txt readme when there is no NFO plot", async () => {
  const video = join(dir, "txt-only.mp4");
  await writeFile(video, "x");
  await writeFile(join(dir, "txt-only.txt"), "From the readme.\n");
  const result = await readSidecar(video);
  expect(result.description).toBe("From the readme.");
});

it("reads genre and rating from a rich NFO", async () => {
  const video = join(dir, "rich.mkv");
  await writeFile(video, "x");
  await writeFile(
    join(dir, "rich.nfo"),
    [
      "<movie>",
      "  <title>Rich Movie</title>",
      "  <genre>Drama</genre>",
      "  <rating>7.5</rating>",
      "</movie>",
    ].join("\n"),
  );
  const result = await readSidecar(video);
  expect(result.genre).toBe("Drama");
  expect(result.rating).toBe(7.5);
});

it("survives a malformed NFO with a warning", async () => {
  const video = join(dir, "broken.mkv");
  await writeFile(video, "x");
  await writeFile(join(dir, "broken.nfo"), "<movie><title>Never closed");
  const result = await readSidecar(video);
  expect(result.title).toBeNull();
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toMatch(/no readable/);
});

it("merge gives NFO/TXT priority over embedded tags", async () => {
  const sidecar = await readSidecar(library.files.video);
  const merged = mergeMetadata(sidecar, {
    tagTitle: "Embedded Title",
    tagPlot: "Embedded plot.",
  });
  expect(merged.title).toBe("Some Movie");
  expect(merged.description).toBe("A fixture movie about fixtures.");
});

it("merge falls back to embedded tags when sidecars are missing", async () => {
  const sidecar = await readSidecar(library.files.nestedVideo);
  const merged = mergeMetadata(sidecar, {
    tagTitle: "Embedded Title",
    tagPlot: "Embedded plot.",
  });
  expect(merged.title).toBe("Embedded Title");
  expect(merged.description).toBe("Embedded plot.");
});
