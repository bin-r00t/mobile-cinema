import type { FastifyInstance } from "fastify";

import type { ScanRunner } from "../services/scan/runner.ts";

export interface ScanRouteOptions {
  runner: ScanRunner;
}

export async function scanRoutes(
  app: FastifyInstance,
  opts: ScanRouteOptions,
): Promise<void> {
  /** Starts a scan, or reports the one that is already going. */
  app.post("/api/scan", async (_request, reply) => {
    const { run, alreadyRunning } = opts.runner.start();
    reply.code(alreadyRunning ? 200 : 202);
    return { runId: run.id, alreadyRunning };
  });

  /**
   * The run that is in flight, with its progress, or the run that finished
   * last when the runner is idle.
   */
  app.get("/api/scan/status", async () => {
    const active = opts.runner.activeRun();
    if (active) return { state: "running" as const, run: active };
    return { state: "idle" as const, run: opts.runner.lastRun() };
  });

  /** The most recent runs, with counts and an error summary. */
  app.get("/api/scan/runs", async () => ({ runs: opts.runner.recentRuns() }));
}
