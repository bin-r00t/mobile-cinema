/**
 * Shared test setup for the server workspace.
 *
 * Keeps every test run on predictable defaults: a temp directory for the
 * catalog and cache, and a movie root that points nowhere until a test
 * creates a fixture.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = await mkdtemp(join(tmpdir(), "mobile-cinema-test-"));

process.env.NODE_ENV = "test";
process.env.MOVIE_ROOT = join(scratch, "movies");
process.env.DB_PATH = join(scratch, "catalog.sqlite");
process.env.CACHE_DIR = join(scratch, "cache");
process.env.LOG_LEVEL = "silent";
