import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";

import type { FastifyInstance } from "fastify";

import type { Db } from "../db/client.ts";
import { PathSafetyError, resolveMediaPath } from "../services/pathSafety.ts";

export interface StreamRouteOptions {
  movieRoot: string;
  db: Db;
}

/** Containers a browser plays directly; anything else goes through HLS. */
const BROWSER_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

interface RangeBounds {
  start: number;
  end: number;
}

/**
 * Parses a `Range` header into byte offsets.
 *
 * Returns `null` when the header is absent or malformed — the request is
 * then served whole, as if no range had been asked for. Returns "not
 * satisfiable" when the range is well-formed but points past the end of
 * the file.
 */
function parseRange(
  header: string | undefined,
  size: number,
): RangeBounds | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    // A suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (suffix === 0) return "unsatisfiable";
    const start = Math.max(0, size - suffix);
    return size === 0 ? "unsatisfiable" : { start, end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export async function streamRoutes(
  app: FastifyInstance,
  opts: StreamRouteOptions,
): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/stream/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply
        .code(400)
        .send(errorBody("INVALID_ID", `${request.params.id} is not a catalog id`));
    }

    let path: string;
    try {
      path = await resolveMediaPath({ movieRoot: opts.movieRoot, db: opts.db }, id);
    } catch (error) {
      if (error instanceof PathSafetyError) {
        const status = error.code === "INVALID_ID" ? 400 : 404;
        return reply.code(status).send(errorBody(error.code, error.message));
      }
      throw error;
    }

    const contentType = BROWSER_TYPES[extname(path).toLowerCase()];
    if (!contentType) {
      return reply
        .code(415)
        .send(
          errorBody(
            "UNSUPPORTED_FORMAT",
            `${extname(path)} is not playable in a browser; this movie is served through HLS`,
          ),
        );
    }

    const { size } = await stat(path);
    const range = parseRange(request.headers.range, size);

    if (range === "unsatisfiable") {
      return reply
        .code(416)
        .header("content-range", `bytes */${size}`)
        .send(errorBody("RANGE_NOT_SATISFIABLE", "The requested range is outside the file"));
    }

    const headers: Record<string, string | number> = {
      "accept-ranges": "bytes",
      "content-type": contentType,
    };
    let status = 200;
    if (range === null) {
      headers["content-length"] = size;
    } else {
      status = 206;
      headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
      headers["content-length"] = range.end - range.start + 1;
    }

    if (request.method === "HEAD") {
      // A HEAD answer carries the headers of the GET, but no body —
      // hijack so Fastify does not replace the content length with zero.
      reply.hijack();
      reply.raw.writeHead(status, headers);
      reply.raw.end();
      return reply;
    }

    for (const [name, value] of Object.entries(headers)) {
      reply.header(name, String(value));
    }
    return reply
      .code(status)
      .send(
        range === null
          ? createReadStream(path)
          : createReadStream(path, { start: range.start, end: range.end }),
      );
  });
}
