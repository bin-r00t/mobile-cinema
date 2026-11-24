import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.ts";
import { healthRoutes } from "./routes/health.ts";

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
  });

  await app.register(healthRoutes, { movieRoot: config.MOVIE_ROOT });

  return app;
}
