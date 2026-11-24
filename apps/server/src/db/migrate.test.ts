import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "./migrate.ts";

const dir = mkdtempSync(join(tmpdir(), "mc-migrate-test-"));
const dbPath = join(dir, "test.db");
const db = new Database(dbPath);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const EXPECTED_TABLES = [
  "_migrations",
  "media_items",
  "subtitle_tracks",
  "scan_runs",
  "playback_progress",
];

function tableNames(): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

it("first migrate run creates all four tables", () => {
  const applied = migrate(dbPath);
  expect(applied).toEqual(["001_init"]);
  for (const table of EXPECTED_TABLES) {
    expect(tableNames(), `missing table ${table}`).toContain(table);
  }
});

it("second migrate run is idempotent", () => {
  const applied = migrate(dbPath);
  expect(applied).toEqual([]);
  expect(tableNames().sort()).toEqual(EXPECTED_TABLES.toSorted());
});

it("foreign keys are enforced", () => {
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO subtitle_tracks (media_item_id, path, format) VALUES (999, 'x.srt', 'srt')",
      )
      .run(),
  );
});
