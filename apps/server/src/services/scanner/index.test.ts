import { rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createDb, type Db } from "../../db/client.ts";
import { migrate } from "../../db/migrate.ts";
import { mediaItems, scanRuns, subtitleTracks } from "../../db/schema.ts";
import { createFixtureLibrary, type FixtureLibrary } from "../../test/fixtures.ts";
import { scanLibrary } from "./index.ts";

/** The fixtures are not real movies, so a missing ffprobe keeps the test honest. */
const NO_FFPROBE = "/definitely/not/here/ffprobe";

let workDir: string;
let db: Db;
let library: FixtureLibrary;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mc-scan-test-"));
  const dbPath = join(workDir, "catalog.sqlite");
  migrate(dbPath);
  db = createDb(dbPath);
  library = await createFixtureLibrary();
});

afterEach(async () => {
  await library.cleanup();
  await rm(workDir, { recursive: true, force: true });
});

function rows() {
  return db.select().from(mediaItems).all();
}

describe("scanLibrary", () => {
  it("inserts one row per movie of the library", async () => {
    const summary = await scanLibrary({
      db,
      movieRoot: library.moviesDir,
      ffprobePath: NO_FFPROBE,
    });

    expect(summary.status).toBe("completed");
    expect(summary.totalCount).toBe(2);
    expect(summary.addedCount).toBe(2);
    expect(summary.updatedCount).toBe(0);
    expect(summary.removedCount).toBe(0);

    const paths = rows()
      .map((row) => row.path)
      .toSorted();
    expect(paths).toEqual([library.files.video, library.files.nestedVideo].toSorted());
  });

  it("takes the title and the year from the sidecars", async () => {
    await scanLibrary({
      db,
      movieRoot: library.moviesDir,
      ffprobePath: NO_FFPROBE,
    });

    const movie = rows().find((row) => row.path === library.files.video);
    expect(movie?.title).toBe("Some Movie");
    expect(movie?.year).toBe(2020);
    expect(movie?.description).toBe("A fixture movie about fixtures.");
    expect(movie?.posterPath).toBe(library.files.poster);

    // The nested movie has no sidecar, so its name is the fallback.
    const nested = rows().find((row) => row.path === library.files.nestedVideo);
    expect(nested?.title).toBe("Old Film");
    expect(nested?.year).toBe(2019);
  });

  it("updates the rows of a second scan instead of duplicating them", async () => {
    await scanLibrary({ db, movieRoot: library.moviesDir, ffprobePath: NO_FFPROBE });

    const second = await scanLibrary({
      db,
      movieRoot: library.moviesDir,
      ffprobePath: NO_FFPROBE,
    });

    expect(second.addedCount).toBe(0);
    expect(second.updatedCount).toBe(2);
    expect(second.removedCount).toBe(0);
    expect(rows()).toHaveLength(2);

    const movie = rows().find((row) => row.path === library.files.video);
    await writeFile(library.files.nfo!, "<movie><title>Some Movie</title></movie>\n");
    const third = await scanLibrary({
      db,
      movieRoot: library.moviesDir,
      ffprobePath: NO_FFPROBE,
    });
    expect(third.updatedCount).toBe(2);
    const updated = rows().find((row) => row.path === library.files.video);
    expect(updated?.id).toBe(movie?.id);
    expect(updated?.title).toBe("Some Movie");
  });

  it("drops the movies whose file has disappeared", async () => {
    await scanLibrary({ db, movieRoot: library.moviesDir, ffprobePath: NO_FFPROBE });
    expect(rows()).toHaveLength(2);

    await rm(library.files.nestedVideo);

    const summary = await scanLibrary({
      db,
      movieRoot: library.moviesDir,
      ffprobePath: NO_FFPROBE,
    });

    expect(summary.removedCount).toBe(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.path).toBe(library.files.video);
  });

  it("records a scan run with its counts", async () => {
    const summary = await scanLibrary({
      db,
      movieRoot: library.moviesDir,
      ffprobePath: NO_FFPROBE,
    });

    const run = db.select().from(scanRuns).all().at(-1);
    expect(run?.id).toBe(summary.runId);
    expect(run?.status).toBe("completed");
    expect(run?.totalCount).toBe(2);
    expect(run?.addedCount).toBe(2);
    expect(run?.updatedCount).toBe(0);
    expect(run?.removedCount).toBe(0);
    expect(run?.finishedAt).not.toBeNull();
  });

  it("stores the subtitle tracks of every movie", async () => {
    const summary = await scanLibrary({
      db,
      movieRoot: library.moviesDir,
      cacheDir: join(workDir, "cache"),
      ffprobePath: NO_FFPROBE,
    });

    const movie = rows().find((row) => row.path === library.files.video);
    const tracks = db
      .select()
      .from(subtitleTracks)
      .where(eq(subtitleTracks.mediaItemId, movie!.id))
      .all();

    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.path).toBe(library.files.srt);
    expect(tracks[0]?.language).toBe("en");
    expect(tracks[0]?.isPrimary).toBe(true);
    expect(tracks[0]?.vttPath).toContain("cache");
    expect(summary.errors).toEqual([]);
  });

  it("keeps scanning when a movie cannot be probed", async () => {
    const summary = await scanLibrary({
      db,
      movieRoot: library.moviesDir,
      ffprobePath: NO_FFPROBE,
    });

    expect(summary.addedCount).toBe(2);
    expect(summary.items.every((item) => item.warnings.length > 0)).toBe(true);
  });

  it("scans an empty root without touching the catalog of another root", async () => {
    await scanLibrary({ db, movieRoot: library.moviesDir, ffprobePath: NO_FFPROBE });

    const elsewhere = join(workDir, "elsewhere");
    const summary = await scanLibrary({
      db,
      movieRoot: elsewhere,
      ffprobePath: NO_FFPROBE,
    });

    expect(summary.totalCount).toBe(0);
    expect(summary.removedCount).toBe(0);
    expect(rows()).toHaveLength(2);
  });
});
