import { readFile, stat } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLibrary, type FixtureLibrary } from "./fixtures.ts";

describe("fixture library", () => {
  let library: FixtureLibrary | undefined;

  afterEach(async () => {
    await library?.cleanup();
    library = undefined;
  });

  it("creates the media files and their sidecars", async () => {
    library = await createFixtureLibrary();
    const { files } = library;

    await expect(stat(files.video)).resolves.toBeTruthy();
    await expect(stat(files.nfo!)).resolves.toBeTruthy();
    await expect(stat(files.srt!)).resolves.toBeTruthy();
    await expect(stat(files.poster!)).resolves.toBeTruthy();
  });

  it("writes a subtitle that can be read back", async () => {
    library = await createFixtureLibrary();
    const text = await readFile(library.files.srt!, "utf8");
    expect(text).toContain("00:00:01,000 --> 00:00:03,000");
    expect(text).toContain("First line of the script.");
  });

  it("removes the whole tree on cleanup", async () => {
    library = await createFixtureLibrary();
    const root = library.root;
    await library.cleanup();
    library = undefined;
    await expect(stat(root)).rejects.toThrow();
  });
});
