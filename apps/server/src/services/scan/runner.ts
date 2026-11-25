/**
 * The scan runner: it scans the movie library on demand, keeps the catalog
 * in step with the files on disk and remembers the outcome of recent runs.
 *
 * Only one run is ever in flight. `start()` hands back the run that is
 * already going when one is — two overlapping scans would walk the same
 * files twice and disagree about what the library holds.
 *
 * The runs live in the `scan_runs` table, so the history survives a restart
 * of the server.
 */
import { desc } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { scanRuns } from "../../db/schema.ts";
import { scanLibrary } from "../scanner/index.ts";

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

export interface ScanRunnerOptions {
  /** The catalog the scan writes into. */
  db: Db;
  /** The directory that holds the movies — the equivalent of MOVIE_ROOT. */
  movieRoot: string;
  /** Where the converted subtitles are cached. */
  cacheDir?: string;
  /** The ffprobe binary to run. Defaults to "ffprobe" from PATH. */
  ffprobePath?: string;
}

/** How many finished runs the history keeps. */
const MAX_RUNS_IN_HISTORY = 20;
/** How many error messages a run keeps for skimming. */
const MAX_ERRORS_SAMPLED = 5;

export class ScanRunner {
  private readonly db: Db;
  private readonly movieRoot: string;
  private readonly cacheDir: string | undefined;
  private readonly ffprobePath: string | undefined;
  /** The run that is going right now, if there is one. */
  private active: ScanRun | null = null;

  constructor(options: ScanRunnerOptions) {
    this.db = options.db;
    this.movieRoot = options.movieRoot;
    this.cacheDir = options.cacheDir;
    this.ffprobePath = options.ffprobePath;
  }

  /**
   * Starts a run, or hands back the one that is already going.
   *
   * The row in `scan_runs` is written before the scan begins, so the run is
   * in the history even if the server dies in the middle of it.
   */
  start(): StartResult {
    const running = this.activeRun();
    if (running) return { run: running, alreadyRunning: true };

    const startedAt = new Date();
    const rows = this.db
      .insert(scanRuns)
      .values({ startedAt, status: "running" })
      .returning({ id: scanRuns.id })
      .all();
    const row = rows[0]!;

    const run: ScanRun = {
      id: String(row.id),
      status: "running",
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      progress: { total: 0, processed: 0 },
      counts: { videos: 0 },
      errors: { count: 0, sample: [] },
    };
    this.active = run;

    void this.execute(run);
    return { run, alreadyRunning: false };
  }

  /** The run that is in flight, or null when the runner is idle. */
  activeRun(): ScanRun | null {
    return this.active;
  }

  /** The most recent runs, newest first. */
  recentRuns(limit: number = MAX_RUNS_IN_HISTORY): ScanRun[] {
    const rows = this.db
      .select()
      .from(scanRuns)
      .orderBy(desc(scanRuns.id))
      .limit(limit)
      .all();

    return rows.map((row) => {
      const run = this.toRun(row);
      // The run that is going right now knows more than its row does.
      if (this.active && this.active.id === run.id) {
        return {
          ...run,
          status: this.active.status,
          progress: this.active.progress,
          finishedAt: this.active.finishedAt,
        };
      }
      return run;
    });
  }

  /** The run that finished last, or null when there is none. */
  lastRun(): ScanRun | null {
    return this.recentRuns(1)[0] ?? null;
  }

  private async execute(run: ScanRun): Promise<void> {
    try {
      const summary = await scanLibrary({
        db: this.db,
        movieRoot: this.movieRoot,
        cacheDir: this.cacheDir,
        ffprobePath: this.ffprobePath,
        runId: Number(run.id),
        onProgress: (progress) => {
          run.progress = progress;
        },
      });
      run.status = "completed";
      run.counts = { videos: summary.totalCount };
      run.errors = {
        count: summary.errors.length,
        sample: summary.errors.slice(0, MAX_ERRORS_SAMPLED),
      };
    } catch (error) {
      run.status = "failed";
      this.recordError(run, error);
    } finally {
      run.finishedAt = new Date().toISOString();
      this.active = null;
    }
  }

  /** Turns a row of `scan_runs` into the run the API hands out. */
  private toRun(row: typeof scanRuns.$inferSelect): ScanRun {
    const lines = (row.errorSummary ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return {
      id: String(row.id),
      status: row.status as ScanRunStatus,
      startedAt: new Date(row.startedAt).toISOString(),
      finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
      progress: { total: row.totalCount, processed: row.totalCount },
      counts: { videos: row.totalCount },
      errors: {
        count: lines.length,
        sample: lines.slice(0, MAX_ERRORS_SAMPLED),
      },
    };
  }

  private recordError(run: ScanRun, error: unknown): void {
    run.errors.count += 1;
    if (run.errors.sample.length < MAX_ERRORS_SAMPLED) {
      const message = error instanceof Error ? error.message : String(error);
      run.errors.sample.push(message);
    }
  }
}
