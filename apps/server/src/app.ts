import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.ts";
import { healthRoutes } from "./routes/health.ts";
import { scanRoutes } from "./routes/scan.ts";
import { ScanRunner } from "./services/scan/runner.ts";

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
  });

  await app.register(healthRoutes, { movieRoot: config.MOVIE_ROOT });
  await app.register(scanRoutes, { runner: new ScanRunner(config.MOVIE_ROOT) });

  return app;
}
