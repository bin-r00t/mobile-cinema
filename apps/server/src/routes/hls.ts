/**
 * The HLS playback API: the master playlist of a movie and the segments
 * it points at.
 *
 * A movie a browser cannot play itself is turned into HLS segments by the
 * transcode pipeline, and this route serves what the pipeline produced.
 *
 * The first request for a movie that has no cache yet starts the transcode
 * in the background and answers with `202` and a hint to come back later.
 * The requests that follow while the transcode runs get the same answer,
 * until the playlist is there — and then the route serves it with a `200`.
 *
 * A player should therefore fetch the master playlist itself, wait while
 * the answer is a `202`, and hand the URL to hls.js once the answer is a
 * `200`. hls.js on its own would read the `202` as a playlist and fail.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { FastifyInstance, FastifyReply } from "fastify";

import {
  HlsError,
  transcodeToHls,
  validHlsCache,
  type HlsCache,
  type TranscodeOptions,
} from "../services/hls/transcode.ts";
import { PathSafetyError, resolveInsideRoot } from "../services/pathSafety.ts";

/** The transcoder the route runs, unless another one is put in its place. */
export type Transcoder = (
  options: TranscodeOptions,
  mediaItemId: number,
) => Promise<HlsCache>;

export interface HlsRouteOptions extends TranscodeOptions {
  /** The transcoder to use. Defaults to the one of the pipeline. */
  transcoder?: Transcoder;
  /** How many seconds a client should wait before it asks again. */
  retryAfterSeconds?: number;
}

/** The content type of a playlist. */
const PLAYLIST_CONTENT_TYPE = "application/vnd.apple.mpegurl";

/** The content type of a transport stream segment. */
const SEGMENT_CONTENT_TYPE = "video/mp2t";

/** The content types the HLS files are served with, by extension. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".m3u8": PLAYLIST_CONTENT_TYPE,
  ".ts": SEGMENT_CONTENT_TYPE,
};

/** How long a client should wait before it asks again, in seconds. */
const DEFAULT_RETRY_AFTER_SECONDS = 3;

/**
 * A transcode that is under way.
 *
 * The job stays in the map while it runs and until the cache on disk is
 * there; a failure is kept as well, so the next request can tell the
 * client what went wrong instead of silently starting over.
 */
interface Job {
  cache?: HlsCache;
  error?: unknown;
}

/** What the route knows about the state of the cache of a movie. */
type CacheState =
  | { state: "ready"; cache: HlsCache }
  | { state: "running" }
  | { state: "failed"; error: unknown };

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/**
 * The message of a failure, whether it is one of ours or a surprise.
 */
function failureMessage(error: unknown): string {
  if (error instanceof HlsError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Sends a file of the cache.
 *
 * The playlist is sent with `no-cache`: it appears when the transcode is
 * done and changes when the movie on disk changes. A segment never changes
 * once it is written, so it is kept for a while.
 */
async function sendFile(
  reply: FastifyReply,
  path: string,
  contentType: string,
  cacheControl: string,
): Promise<unknown> {
  const { size } = await stat(path);

  const headers: Record<string, string> = {
    "content-type": contentType,
    "content-length": String(size),
    "cache-control": cacheControl,
  };

  if (reply.request.method === "HEAD") {
    // A HEAD answer carries the headers of the GET, but no body.
    reply.hijack();
    reply.raw.writeHead(200, headers);
    reply.raw.end();
    return reply;
  }

  for (const [name, value] of Object.entries(headers)) {
    reply.header(name, value);
  }
  return reply.code(200).send(createReadStream(path));
}

export async function hlsRoutes(
  app: FastifyInstance,
  opts: HlsRouteOptions,
): Promise<void> {
  const { cacheDir } = opts;
  const transcoder = opts.transcoder ?? transcodeToHls;
  const retryAfterSeconds = opts.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;

  const jobs = new Map<number, Job>();

  /**
   * Starts the transcode of a movie, or joins the one that is already
   * running. The transcode runs in the background: the request that starts
   * it answers right away.
   */
  function startJob(mediaItemId: number): void {
    const existing = jobs.get(mediaItemId);
    if (existing) return;

    const job: Job = {};
    jobs.set(mediaItemId, job);

    transcoder(opts, mediaItemId).then(
      (cache) => {
        job.cache = cache;
      },
      (error) => {
        job.error = error;
      },
    );
  }

  /**
   * The state of the cache of a movie.
   *
   * The cache on disk is the truth: a movie whose file has changed has no
   * valid cache any more, and the playlist has to be built again.
   */
  async function cacheState(mediaItemId: number): Promise<CacheState> {
    const valid = await validHlsCache(opts, mediaItemId);
    if (valid) return { state: "ready", cache: valid };

    const job = jobs.get(mediaItemId);
    if (job?.error !== undefined) {
      // The failure is reported once; the next request tries again.
      jobs.delete(mediaItemId);
      return { state: "failed", error: job.error };
    }
    if (job?.cache) {
      // The transcode is done, but the cache on disk is not valid any
      // more: the movie changed while it was being transcoded. It has to
      // be built again.
      jobs.delete(mediaItemId);
      startJob(mediaItemId);
      return { state: "running" };
    }
    if (job) return { state: "running" };

    startJob(mediaItemId);
    return { state: "running" };
  }

  /**
   * The answer of a request that comes too early: the transcode is still
   * running, so the client is asked to come back.
   */
  function notReady(reply: FastifyReply, mediaItemId: number): unknown {
    return reply
      .code(202)
      .header("retry-after", String(retryAfterSeconds))
      .send({
        status: "transcoding",
        mediaItemId,
        retryAfterMs: retryAfterSeconds * 1000,
        message:
          "The movie is being transcoded into HLS segments; ask again in a moment.",
      });
  }

  /**
   * The answer of a transcode that did not work out.
   */
  function transcodeFailed(reply: FastifyReply, error: unknown): unknown {
    return reply
      .code(500)
      .header("retry-after", String(retryAfterSeconds))
      .send(
        errorBody(
          "TRANSCODE_FAILED",
          `The movie could not be transcoded: ${failureMessage(error)}`,
        ),
      );
  }

  app.get<{ Params: { id: string } }>("/api/hls/:id/master.m3u8", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply
        .code(400)
        .send(errorBody("INVALID_ID", `${request.params.id} is not a movie id`));
    }

    let state: CacheState;
    try {
      state = await cacheState(id);
    } catch (error) {
      if (error instanceof PathSafetyError) {
        const status = error.code === "INVALID_ID" ? 400 : 404;
        return reply.code(status).send(errorBody(error.code, error.message));
      }
      throw error;
    }

    if (state.state === "running") return notReady(reply, id);
    if (state.state === "failed") return transcodeFailed(reply, state.error);

    return sendFile(
      reply,
      state.cache.masterPath,
      PLAYLIST_CONTENT_TYPE,
      "no-cache",
    );
  });

  /**
   * The playlist of a rendition and the segments it points at.
   *
   * The file is looked up inside the cache directory of the movie, and the
   * path safety module refuses anything that climbs out of it.
   */
  app.get<{ Params: { id: string; rendition: string; file: string } }>(
    "/api/hls/:id/:rendition/:file",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply
          .code(400)
          .send(errorBody("INVALID_ID", `${request.params.id} is not a movie id`));
      }

      const { rendition, file } = request.params;
      const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
      const contentType = CONTENT_TYPES[extension];
      if (!contentType) {
        return reply
          .code(404)
          .send(errorBody("NOT_FOUND", `${file} is not an HLS file`));
      }

      // The cache of this movie: nothing outside it is ever served.
      const cacheRoot = join(cacheDir, "hls", String(id));

      let path: string;
      try {
        path = await resolveInsideRoot(cacheRoot, join(rendition, file));
      } catch (error) {
        if (!(error instanceof PathSafetyError)) throw error;
        if (error.code === "OUTSIDE_ROOT") {
          return reply
            .code(404)
            .send(errorBody("NOT_FOUND", "There is no such HLS file"));
        }

        // The file is not there: either the transcode has not run yet, or
        // it failed. Either way the client is asked to come back.
        let state: CacheState;
        try {
          state = await cacheState(id);
        } catch (err) {
          if (err instanceof PathSafetyError) {
            const status = err.code === "INVALID_ID" ? 400 : 404;
            return reply.code(status).send(errorBody(err.code, err.message));
          }
          throw err;
        }

        if (state.state === "failed") return transcodeFailed(reply, state.error);
        if (state.state === "ready") {
          // The cache is there, but not this file: the playlist points at
          // something that was never written.
          return reply
            .code(404)
            .send(errorBody("NOT_FOUND", "There is no such HLS file"));
        }
        return notReady(reply, id);
      }

      const cacheControl =
        contentType === SEGMENT_CONTENT_TYPE ? "public, max-age=3600" : "no-cache";
      return sendFile(reply, path, contentType, cacheControl);
    },
  );
}
