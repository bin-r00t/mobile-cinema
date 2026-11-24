import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

interface Migration {
  id: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: "001_init",
    sql: `
      CREATE TABLE IF NOT EXISTS media_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        year INTEGER,
        description TEXT,
        poster_path TEXT,
        duration_ms INTEGER,
        width INTEGER,
        height INTEGER,
        video_codec TEXT,
        container TEXT,
        size_bytes INTEGER,
        mtime_ms INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subtitle_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        path TEXT NOT NULL UNIQUE,
        language TEXT,
        format TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        vtt_path TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scan_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        total_count INTEGER NOT NULL DEFAULT 0,
        added_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        removed_count INTEGER NOT NULL DEFAULT 0,
        error_summary TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS playback_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_item_id INTEGER NOT NULL UNIQUE REFERENCES media_items(id) ON DELETE CASCADE,
        position_ms INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_subtitle_tracks_media_item
        ON subtitle_tracks(media_item_id);
    `,
  },
];

export function migrate(dbPath: string): string[] {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(
      "CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );

    const applied = new Set(
      (
        sqlite
          .prepare("SELECT id FROM _migrations")
          .all() as { id: string }[]
      ).map((row) => row.id),
    );

    const appliedNow: string[] = [];
    const record = sqlite.prepare(
      "INSERT INTO _migrations (id, applied_at) VALUES (?, ?)",
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      sqlite.transaction(() => {
        sqlite.exec(migration.sql);
        record.run(migration.id, new Date().toISOString());
      })();
      appliedNow.push(migration.id);
    }
    return appliedNow;
  } finally {
    sqlite.close();
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const dbPath = process.env.DB_PATH;
  if (!dbPath) {
    console.error("DB_PATH is required");
    process.exit(1);
  }
  const applied = migrate(dbPath);
  if (applied.length === 0) {
    console.log(`${dbPath}: already up to date`);
  } else {
    console.log(`${dbPath}: applied ${applied.join(", ")}`);
  }
}
