/**
 * The scan runner: it walks the movie library, works out what each file
 * is and remembers the outcome of recent runs.
 *
 * Only one run is ever in flight. `start()` hands back the run that is
 * already going when one is — two overlapping scans would walk the same
 * files twice and disagree about what the library holds.
 */
import { randomUUID } from "node:crypto";

import { parseTitle } from "../scanner/title.ts";
import { walkMediaFiles } from "../scanner/walk.ts";

export type ScanRunStatus = "running" | "completed" | "failed";

export interface ScanProgress {
  /** Files discovered in this run. */
  total: number;
  /** Files processed so far. */
  processed: number;
}

export interface ScanErrorSummary {
  /** How many files failed while the run was working. */
  count: number;
  /** Up to five failure messages, for a human to skim. */
  sample: string[];
}

export interface ScanRun {
  id: string;
  status: ScanRunStatus;
  startedAt: string;
  finishedAt: string | null;
  progress: ScanProgress;
  counts: { videos: number };
  errors: ScanErrorSummary;
}

export interface StartResult {
  run: ScanRun;
  /** True when a run was already in flight and is handed back instead. */
  alreadyRunning: boolean;
}

/** How many finished runs the history keeps. */
const MAX_RUNS_IN_HISTORY = 20;
/** How many error messages a run keeps for skimming. */
const MAX_ERRORS_SAMPLED = 5;

export class ScanRunner {
  private readonly runs: ScanRun[] = [];

  constructor(private readonly movieRoot: string) {}

  /** Starts a run, or hands back the one that is already going. */
  start(): StartResult {
    const active = this.activeRun();
    if (active) return { run: active, alreadyRunning: true };

    const run: ScanRun = {
      id: randomUUID(),
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      progress: { total: 0, processed: 0 },
      counts: { videos: 0 },
      errors: { count: 0, sample: [] },
    };
    this.runs.unshift(run);
    if (this.runs.length > MAX_RUNS_IN_HISTORY) this.runs.length = MAX_RUNS_IN_HISTORY;

    void this.execute(run);
    return { run, alreadyRunning: false };
  }

  /** The run that is in flight, or null when the runner is idle. */
  activeRun(): ScanRun | null {
    return this.runs.find((run) => run.status === "running") ?? null;
  }

  /** The most recent runs, newest first. */
  recentRuns(): ScanRun[] {
    return this.runs;
  }

  private async execute(run: ScanRun): Promise<void> {
    try {
      const files = await walkMediaFiles(this.movieRoot);
      run.progress.total = files.length;

      for (const file of files) {
        try {
          parseTitle(file.path);
          run.counts.videos += 1;
        } catch (error) {
          this.recordError(run, error);
        }
        run.progress.processed += 1;
        // Let the event loop breathe so a status request that arrives
        // mid-run sees the run while it is still going.
        await new Promise((resolve) => setImmediate(resolve));
      }

      run.status = "completed";
    } catch (error) {
      run.status = "failed";
      this.recordError(run, error);
    } finally {
      run.finishedAt = new Date().toISOString();
    }
  }

  private recordError(run: ScanRun, error: unknown): void {
    run.errors.count += 1;
    if (run.errors.sample.length < MAX_ERRORS_SAMPLED) {
      const message = error instanceof Error ? error.message : String(error);
      run.errors.sample.push(message);
    }
  }
}
