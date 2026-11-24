import { afterAll, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import type { Config } from "./config.ts";

const config: Config = {
  HOST: "127.0.0.1",
  PORT: 0,
  MOVIE_ROOT: "/tmp/mobile-cinema-test-movies",
  DB_PATH: "/tmp/mobile-cinema-test.db",
  CACHE_DIR: "/tmp/mobile-cinema-test-cache",
  LOG_LEVEL: "silent",
};

const app = await buildApp(config);
afterAll(() => app.close());

it("GET /api/health returns ok and the configured movie root", async () => {
  const res = await app.inject({ method: "GET", url: "/api/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    status: "ok",
    movieRoot: "/tmp/mobile-cinema-test-movies",
  });
});

it("GET /api/movies answers with the movies of the catalog", async () => {
  const res = await app.inject({ method: "GET", url: "/api/movies" });
  expect(res.statusCode).toBe(200);
  expect(Array.isArray(res.json().items)).toBe(true);
  expect(typeof res.json().total).toBe("number");
});
