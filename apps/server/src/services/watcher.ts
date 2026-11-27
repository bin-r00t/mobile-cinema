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
import { resolve, sep } from "node:path";

import { watch, type FSWatcher } from "chokidar";

export interface LibraryWatcherOptions {
  /** The directory that holds the movies — the equivalent of MOVIE_ROOT. */
  movieRoot: string;
  /**
   * Paths whose own changes never start a rescan: the directories the
   * server writes into — its cache and the folder of its catalog. They
   * may sit inside the movie root, and when they do, every scan writes
   * files there that would otherwise start the next scan.
   */
  ignoredPaths?: string[];
  /** Called once the changes have settled. May return a promise. */
  rescan: () => void | Promise<void>;
  /** Quiet period before a rescan runs. Defaults to 2 seconds. */
  debounceMs?: number;
}

/** The default quiet period: long enough for a bulk copy to settle. */
const DEFAULT_DEBOUNCE_MS = 2000;

/** True when `candidate` is `dir` itself or a file somewhere below it. */
function isInside(candidate: string, dir: string): boolean {
  return candidate === dir || candidate.startsWith(dir + sep);
}

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

    const movieRoot = resolve(this.options.movieRoot);
    // An ignored path that holds the movie root — the root itself, or a
    // directory above it — cannot be ignored: every path the watcher
    // would ever see lies inside it, so ignoring it would silence the
    // watcher for the whole library. Such a path is left out and the
    // root stays watched.
    const ignoredPaths = (this.options.ignoredPaths ?? [])
      .map((candidate) => resolve(candidate))
      .filter((candidate) => !isInside(movieRoot, candidate));

    const watcher = watch(movieRoot, {
      // The initial listing is not a change: it fires one event per file
      // that has always been there and would rescan right after boot.
      ignoreInitial: true,
      // The files the server writes into its own directories are not
      // changes of the library: the scan that writes them must not
      // start the next one.
      ignored: (path) => ignoredPaths.some((dir) => isInside(resolve(path), dir)),
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
