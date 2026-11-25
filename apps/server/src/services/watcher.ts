/**
 * Watches the movie root and triggers a debounced rescan whenever the
 * library changes on disk.
 *
 * A copy that drops a movie into the drive does not press any button, so
 * the catalog would drift from the files on disk. The watcher closes that
 * gap: any add, change or removal under the root starts a rescan — but
 * only after the changes have settled, so a bulk copy triggers one scan
 * instead of one per file.
 */
import { watch, type FSWatcher } from "chokidar";

export interface LibraryWatcherOptions {
  /** The directory that holds the movies — the equivalent of MOVIE_ROOT. */
  movieRoot: string;
  /** Called once the changes have settled. May return a promise. */
  rescan: () => void | Promise<void>;
  /** Quiet period before a rescan runs. Defaults to 2 seconds. */
  debounceMs?: number;
}

/** The default quiet period: long enough for a bulk copy to settle. */
const DEFAULT_DEBOUNCE_MS = 2000;

export class LibraryWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private rescanInFlight: Promise<void> = Promise.resolve();
  private readonly options: LibraryWatcherOptions;

  // The options are a plain field, not a parameter property: node runs this
  // file as it is, and it cannot strip a parameter property away.
  constructor(options: LibraryWatcherOptions) {
    this.options = options;
  }

  /** Starts watching. Does nothing when the watcher is already running. */
  async start(): Promise<void> {
    if (this.watcher) return;

    const watcher = watch(this.options.movieRoot, {
      // The initial listing is not a change: it fires one event per file
      // that has always been there and would rescan right after boot.
      ignoreInitial: true,
    });
    watcher.on("all", () => this.scheduleRescan());
    await new Promise<void>((resolve, reject) => {
      watcher.once("ready", () => resolve());
      watcher.once("error", (error) => reject(error));
    });
    this.watcher = watcher;
  }

  /** Stops watching; a rescan that is running is left to finish. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) await watcher.close();
    await this.rescanInFlight;
  }

  /** Restarts the quiet period; the rescan runs when it elapses. */
  private scheduleRescan(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.rescanInFlight = this.rescanInFlight.then(() =>
        Promise.resolve(this.options.rescan()).catch(() => {
          // A failed rescan must not kill the watcher; the next change
          // schedules the next attempt.
        }),
      );
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }
}
