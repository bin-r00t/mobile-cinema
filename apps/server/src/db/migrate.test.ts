import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import Database from "better-sqlite3";
import { migrate } from "./migrate.js";

const dir = mkdtempSync(join(tmpdir(), "mc-migrate-test-"));
const dbPath = join(dir, "test.db");
const db = new Database(dbPath);

after(() => {
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

test("first migrate run creates all four tables", () => {
  const applied = migrate(dbPath);
  assert.deepEqual(applied, ["001_init"]);
  for (const table of EXPECTED_TABLES) {
    assert.ok(tableNames().includes(table), `missing table ${table}`);
  }
});

test("second migrate run is idempotent", () => {
  const applied = migrate(dbPath);
  assert.deepEqual(applied, []);
  assert.deepEqual(tableNames().sort(), EXPECTED_TABLES.toSorted());
});

test("foreign keys are enforced", () => {
  assert.throws(() =>
    db
      .prepare("INSERT INTO subtitle_tracks (media_item_id, path, format) VALUES (999, 'x.srt', 'srt')")
      .run(),
  );
});
