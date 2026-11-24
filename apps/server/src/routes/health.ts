import type { FastifyInstance } from "fastify";

export interface HealthRouteOptions {
  movieRoot: string;
}

export async function healthRoutes(
  app: FastifyInstance,
  opts: HealthRouteOptions,
): Promise<void> {
  app.get("/api/health", async () => ({
    status: "ok",
    movieRoot: opts.movieRoot,
  }));
}
