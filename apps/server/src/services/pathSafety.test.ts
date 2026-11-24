import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb, type Db } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { mediaItems } from "../db/schema.ts";
import {
  PathSafetyError,
  isInside,
  openMediaFile,
  resolveInsideRoot,
  resolveMediaPath,
} from "./pathSafety.ts";

let workDir: string;
let root: string;
let outsideDir: string;
let db: Db;

const MOVIE = join("Movies", "Some Movie (2020).mp4");

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mc-pathsafety-"));
  root = join(workDir, "library");
  outsideDir = join(workDir, "outside");
  await rm(root, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });

  await mkdir(join(root, "Movies"), { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  await writeFile(join(root, MOVIE), "a movie");
  await writeFile(join(outsideDir, "secret.mp4"), "a secret");

  const dbPath = join(workDir, "catalog.sqlite");
  migrate(dbPath);
  db = createDb(dbPath);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function addMovie(path: string): number {
  const result = db
    .insert(mediaItems)
    .values({ path, title: "Some Movie", createdAt: new Date(), updatedAt: new Date() })
    .run();
  return Number(result.lastInsertRowid);
}

describe("resolveInsideRoot", () => {
  it("resolves a file inside the root", async () => {
    const path = await resolveInsideRoot(root, join(root, MOVIE));
    expect(path).toBe(await resolveInsideRoot(root, MOVIE));
    expect(path.endsWith("Some Movie (2020).mp4")).toBe(true);
  });

  it("refuses a path that climbs out with ../", async () => {
    const candidate = join(root, "..", "outside", "secret.mp4");
    await expect(resolveInsideRoot(root, candidate)).rejects.toThrow(
      /outside the movie root/,
    );
    await expect(resolveInsideRoot(root, candidate)).rejects.toBeInstanceOf(
      PathSafetyError,
    );
  });

  it("refuses an absolute path outside the root", async () => {
    const candidate = join(outsideDir, "secret.mp4");
    await expect(resolveInsideRoot(root, candidate)).rejects.toThrow(
      /outside the movie root/,
    );
  });

  it("refuses a symlink that escapes the root", async () => {
    const link = join(root, "Movies", "escape.mp4");
    await symlink(join(outsideDir, "secret.mp4"), link);

    await expect(resolveInsideRoot(root, link)).rejects.toThrow(
      /points outside the movie root/,
    );
  });

  it("allows a symlink that stays inside the root", async () => {
    const link = join(root, "Movies", "link.mp4");
    await symlink(join(root, MOVIE), link);

    const path = await resolveInsideRoot(root, link);
    expect(path.endsWith("Some Movie (2020).mp4")).toBe(true);
  });

  it("refuses the root itself and a directory", async () => {
    await expect(resolveInsideRoot(root, root)).rejects.toThrow(
      /outside the movie root/,
    );
    await expect(resolveInsideRoot(root, join(root, "Movies"))).rejects.toThrow(
      /not a file/,
    );
  });

  it("reports a missing file as not found", async () => {
    await expect(
      resolveInsideRoot(root, join(root, "Movies", "nothing.mp4")),
    ).rejects.toThrow(/does not exist/);
  });

  it("refuses an empty path", async () => {
    await expect(resolveInsideRoot(root, "")).rejects.toThrow(/empty path/);
  });
});

describe("resolveMediaPath", () => {
  it("returns the file of a catalog id", async () => {
    const id = addMovie(join(root, MOVIE));
    const path = await resolveMediaPath({ db, movieRoot: root }, id);
    expect(path.endsWith("Some Movie (2020).mp4")).toBe(true);
  });

  it("refuses a catalog id that is not a number", async () => {
    await expect(resolveMediaPath({ db, movieRoot: root }, 0)).rejects.toThrow(
      /not a catalog id/,
    );
  });

  it("reports an unknown id as not found", async () => {
    await expect(resolveMediaPath({ db, movieRoot: root }, 4242)).rejects.toThrow(
      /no movie with id/,
    );
  });

  it("refuses a catalog row that points outside the root", async () => {
    const id = addMovie(join(outsideDir, "secret.mp4"));
    await expect(resolveMediaPath({ db, movieRoot: root }, id)).rejects.toThrow(
      /outside the movie root/,
    );
  });
});

describe("openMediaFile", () => {
  it("opens the file of a catalog id", async () => {
    const id = addMovie(join(root, MOVIE));
    const { handle, path } = await openMediaFile({ db, movieRoot: root }, id);
    try {
      const content = await handle.readFile("utf8");
      expect(content).toBe("a movie");
      expect(path.endsWith("Some Movie (2020).mp4")).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("refuses a catalog row whose symlink escapes the root", async () => {
    const link = join(root, "Movies", "escape.mp4");
    await symlink(join(outsideDir, "secret.mp4"), link);
    const id = addMovie(link);

    await expect(openMediaFile({ db, movieRoot: root }, id)).rejects.toThrow(
      /points outside the movie root/,
    );
  });
});

describe("isInside", () => {
  it("counts a path under the root as inside and the root itself as not", () => {
    expect(isInside("/library", "/library/Movies/a.mp4")).toBe(true);
    expect(isInside("/library", "/library")).toBe(false);
    expect(isInside("/library", "/library-other/a.mp4")).toBe(false);
    expect(isInside("/library", "/elsewhere/a.mp4")).toBe(false);
  });
});
