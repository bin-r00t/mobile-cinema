import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.ts";
import { createDb } from "./db/client.ts";
import { migrate } from "./db/migrate.ts";
import { healthRoutes } from "./routes/health.ts";
import { scanRoutes } from "./routes/scan.ts";
import { ScanRunner } from "./services/scan/runner.ts";
import { scanLibrary } from "./services/scanner/index.ts";
import { LibraryWatcher } from "./services/watcher.ts";

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
  });

  await app.register(healthRoutes, { movieRoot: config.MOVIE_ROOT });

  // The catalog the scans keep in step with the files on disk.
  migrate(config.DB_PATH);
  const db = createDb(config.DB_PATH);

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
