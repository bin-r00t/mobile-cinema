import Fastify from "fastify";
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { Config } from "./config.ts";
import { createDb } from "./db/client.ts";
import { migrate } from "./db/migrate.ts";
import { healthRoutes } from "./routes/health.ts";
import { hlsRoutes } from "./routes/hls.ts";
import { moviesRoutes } from "./routes/movies.ts";
import { progressRoutes } from "./routes/progress.ts";
import { scanRoutes } from "./routes/scan.ts";
import { streamRoutes } from "./routes/stream.ts";
import { subtitleRoutes } from "./routes/subtitles.ts";
import { ScanRunner } from "./services/scan/runner.ts";
import { scanLibrary } from "./services/scanner/index.ts";
import { LibraryWatcher } from "./services/watcher.ts";

/**
 * Answers every error a route did not answer itself.
 *
 * The routes of the library send their refusals by hand, so the errors
 * that arrive here are the ones nobody anticipated — and the message of
 * such an error can carry a path of the machine (a file system error
 * names the file it failed on), which has no business in an answer.
 *
 * The status is kept for the errors that carry one (a malformed body, an
 * unknown route) and a 500 goes out for the rest, with a fixed message;
 * the error itself goes to the log, where the stack and the path belong
 * to the operator.
 */
export function serverErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): unknown {
  const status = error.statusCode ?? 500;
  if (status < 500) {
    return reply.status(status).send({
      error: {
        code: typeof error.code === "string" ? error.code : "REQUEST_ERROR",
        message: "The request could not be answered.",
      },
    });
  }
  request.log.error({ err: error }, "the server failed to answer the request");
  return reply.status(500).send({
    error: {
      code: "INTERNAL_ERROR",
      message: "The server failed to answer the request.",
    },
  });
}

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
  });

  app.setErrorHandler(serverErrorHandler);

  await app.register(healthRoutes, { movieRoot: config.MOVIE_ROOT });

  // The catalog the scans keep in step with the files on disk.
  migrate(config.DB_PATH);
  const db = createDb(config.DB_PATH);
  // The library the player browses: the list, the detail and the posters.
  await app.register(moviesRoutes, {
    db,
    movieRoot: config.MOVIE_ROOT,
    cacheDir: config.CACHE_DIR,
  });

  // Progressive streaming for the containers a browser plays directly.
  await app.register(streamRoutes, { movieRoot: config.MOVIE_ROOT, db });

  // HLS for the containers it cannot: the playlist and its segments, and
  // a 202 with a hint to come back while the transcode is still running.
  await app.register(hlsRoutes, {
    db,
    movieRoot: config.MOVIE_ROOT,
    cacheDir: config.CACHE_DIR,
    ffmpegPath: config.FFMPEG_PATH,
  });

  // The subtitles: the WebVTT the player plays and the script it shows.
  await app.register(subtitleRoutes, {
    db,
    movieRoot: config.MOVIE_ROOT,
    cacheDir: config.CACHE_DIR,
  });

  // The playback progress: where the player left every movie off, so it
  // can be picked up again from there.
  await app.register(progressRoutes, { db });

  // The scan API: a scan on demand, the progress of the run that is going
  // and the runs it left behind.
  const runner = new ScanRunner({
    db,
    movieRoot: config.MOVIE_ROOT,
    cacheDir: config.CACHE_DIR,
    ffprobePath: config.FFPROBE_PATH,
  });
  await app.register(scanRoutes, { runner });

  // The library changes on disk without asking the server first: the
  // watcher rescans it a quiet moment after anything is added, changed
  // or removed. It lives and dies with the app.
  const watcher = new LibraryWatcher({
    movieRoot: config.MOVIE_ROOT,
    rescan: () =>
      scanLibrary({
        db,
        movieRoot: config.MOVIE_ROOT,
        cacheDir: config.CACHE_DIR,
        ffprobePath: config.FFPROBE_PATH,
      }).then(() => undefined),
  });
  await watcher.start();
  app.addHook("onClose", async () => {
    await watcher.stop();
  });

  return app;
}
