import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import { createDb, type Db } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { mediaItems } from "../db/schema.ts";
import { createFixtureLibrary, type FixtureLibrary } from "../test/fixtures.ts";
import { streamRoutes } from "./stream.ts";

let workDir: string;
let db: Db;
let library: FixtureLibrary;
let app: FastifyInstance;
let mp4Id: number;
let mkvId: number;
let webmId: number;
let mp4Bytes: Buffer;
let webmBytes: Buffer;

async function addMediaItem(path: string, title: string): Promise<number> {
  const row = db.insert(mediaItems).values({ path, title }).returning({ id: mediaItems.id }).get();
  return row.id;
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mc-stream-test-"));
  const dbPath = join(workDir, "catalog.sqlite");
  migrate(dbPath);
  db = createDb(dbPath);
  library = await createFixtureLibrary();

  const webmPath = join(library.moviesDir, "Web.Movie.2021.webm");
  webmBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
  await writeFile(webmPath, webmBytes);
  mp4Bytes = await readFile(library.files.nestedVideo);

  mp4Id = await addMediaItem(library.files.nestedVideo, "Old Film");
  mkvId = await addMediaItem(library.files.video, "Some Movie");
  webmId = await addMediaItem(webmPath, "Web Movie");

  app = Fastify({ logger: false });
  await app.register(streamRoutes, { movieRoot: library.moviesDir, db });
});

afterEach(async () => {
  await app.close();
  await library.cleanup();
  await rm(workDir, { recursive: true, force: true });
});

describe("GET /api/stream/:id", () => {
  it("serves the whole file with a 200 and advertises range support", async () => {
    const res = await app.inject({ method: "GET", url: `/api/stream/${mp4Id}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-length"]).toBe(String(mp4Bytes.length));
    expect(res.rawPayload.equals(mp4Bytes)).toBe(true);
  });

  it("serves webm with its own content type", async () => {
    const res = await app.inject({ method: "GET", url: `/api/stream/${webmId}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("video/webm");
    expect(res.rawPayload.equals(webmBytes)).toBe(true);
  });

  it("answers a bounded range with a 206 and the right slice", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/stream/${mp4Id}`,
      headers: { range: "bytes=2-5" },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 2-5/${mp4Bytes.length}`);
    expect(res.headers["content-length"]).toBe("4");
    expect(res.rawPayload.equals(mp4Bytes.subarray(2, 6))).toBe(true);
  });

  it("answers an open-ended range up to the end of the file", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/stream/${mp4Id}`,
      headers: { range: "bytes=4-" },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(
      `bytes 4-${mp4Bytes.length - 1}/${mp4Bytes.length}`,
    );
    expect(res.rawPayload.equals(mp4Bytes.subarray(4))).toBe(true);
  });

  it("answers a suffix range with the last bytes", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/stream/${mp4Id}`,
      headers: { range: "bytes=-3" },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(
      `bytes ${mp4Bytes.length - 3}-${mp4Bytes.length - 1}/${mp4Bytes.length}`,
    );
    expect(res.rawPayload.equals(mp4Bytes.subarray(-3))).toBe(true);
  });

  it("clamps a range whose end runs past the file", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/stream/${mp4Id}`,
      headers: { range: "bytes=6-9999" },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(
      `bytes 6-${mp4Bytes.length - 1}/${mp4Bytes.length}`,
    );
    expect(res.rawPayload.equals(mp4Bytes.subarray(6))).toBe(true);
  });

  it("answers an unsatisfiable range with a 416", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/stream/${mp4Id}`,
      headers: { range: "bytes=9999-" },
    });

    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${mp4Bytes.length}`);
    expect(res.json().error.code).toBe("RANGE_NOT_SATISFIABLE");
  });

  it("answers HEAD with the headers of a full response and no body", async () => {
    const res = await app.inject({ method: "HEAD", url: `/api/stream/${mp4Id}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-length"]).toBe(String(mp4Bytes.length));
    expect(res.rawPayload.length).toBe(0);
  });

  it("answers HEAD with a range request in kind", async () => {
    const res = await app.inject({
      method: "HEAD",
      url: `/api/stream/${mp4Id}`,
      headers: { range: "bytes=2-5" },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 2-5/${mp4Bytes.length}`);
    expect(res.rawPayload.length).toBe(0);
  });

  it("refuses a container a browser cannot play", async () => {
    const res = await app.inject({ method: "GET", url: `/api/stream/${mkvId}` });

    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("UNSUPPORTED_FORMAT");
  });

  it("answers an unknown id with a 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stream/999" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("answers a non-numeric id with a 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stream/nope" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ID");
  });

  it("serves a file whole when the range header is malformed", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/stream/${mp4Id}`,
      headers: { range: "bananas" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(mp4Bytes)).toBe(true);
  });
});
