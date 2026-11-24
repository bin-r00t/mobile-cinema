import { describe, expect, it } from "vitest";
import { createFixtureLibrary } from "../../test/fixtures.ts";
import { isIgnoredDir, isVideoFile, walkMediaFiles } from "./walk.ts";

describe("walkMediaFiles", () => {
  it("finds every video file below the root", async () => {
    const library = await createFixtureLibrary();
    try {
      const files = await walkMediaFiles(library.moviesDir);
      const paths = files.map((file) => file.path);
      expect(paths).toContain(library.files.video);
      expect(paths).toContain(library.files.nestedVideo);
      expect(files).toHaveLength(2);
    } finally {
      await library.cleanup();
    }
  });

  it("skips ignored and hidden directories", async () => {
    const library = await createFixtureLibrary();
    try {
      const files = await walkMediaFiles(library.moviesDir);
      for (const file of files) {
        for (const ignored of library.ignoredDirs) {
          expect(file.path.startsWith(ignored)).toBe(false);
        }
      }
    } finally {
      await library.cleanup();
    }
  });

  it("returns files sorted by path", async () => {
    const library = await createFixtureLibrary();
    try {
      const files = await walkMediaFiles(library.moviesDir);
      const paths = files.map((file) => file.path);
      expect([...paths].sort((a, b) => a.localeCompare(b))).toEqual(paths);
    } finally {
      await library.cleanup();
    }
  });

  it("returns an empty list for a missing root", async () => {
    const files = await walkMediaFiles("/definitely/not/here");
    expect(files).toEqual([]);
  });
});

describe("helpers", () => {
  it("recognises video extensions case-insensitively", () => {
    expect(isVideoFile("Movie.MKV")).toBe(true);
    expect(isVideoFile("clip.mp4")).toBe(true);
    expect(isVideoFile("notes.txt")).toBe(false);
    expect(isVideoFile("poster.jpg")).toBe(false);
  });

  it("ignores vendor and hidden directories", () => {
    expect(isIgnoredDir("@eaDir")).toBe(true);
    expect(isIgnoredDir(".thumbnails")).toBe(true);
    expect(isIgnoredDir("Movies")).toBe(false);
  });
});
