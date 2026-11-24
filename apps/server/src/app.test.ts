import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";

const config: Config = {
  HOST: "127.0.0.1",
  PORT: 0,
  MOVIE_ROOT: "/tmp/mobile-cinema-test-movies",
  DB_PATH: "/tmp/mobile-cinema-test.db",
  CACHE_DIR: "/tmp/mobile-cinema-test-cache",
  LOG_LEVEL: "silent",
};

const app = await buildApp(config);
after(() => app.close());

test("GET /api/health returns ok and the configured movie root", async () => {
  const res = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    status: "ok",
    movieRoot: "/tmp/mobile-cinema-test-movies",
  });
});
