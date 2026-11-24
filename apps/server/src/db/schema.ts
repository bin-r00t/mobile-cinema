import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const mediaItems = sqliteTable("media_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  path: text("path").notNull().unique(),
  title: text("title").notNull(),
  year: integer("year"),
  description: text("description"),
  posterPath: text("poster_path"),
  durationMs: integer("duration_ms"),
  width: integer("width"),
  height: integer("height"),
  videoCodec: text("video_codec"),
  container: text("container"),
  sizeBytes: integer("size_bytes"),
  mtimeMs: integer("mtime_ms"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const subtitleTracks = sqliteTable("subtitle_tracks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mediaItemId: integer("media_item_id")
    .notNull()
    .references(() => mediaItems.id, { onDelete: "cascade" }),
  path: text("path").notNull().unique(),
  language: text("language"),
  format: text("format").notNull(),
  isPrimary: integer("is_primary", { mode: "boolean" })
    .notNull()
    .default(false),
  vttPath: text("vtt_path"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const scanRuns = sqliteTable("scan_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  status: text("status").notNull(),
  totalCount: integer("total_count").notNull().default(0),
  addedCount: integer("added_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  removedCount: integer("removed_count").notNull().default(0),
  errorSummary: text("error_summary"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const playbackProgress = sqliteTable("playback_progress", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mediaItemId: integer("media_item_id")
    .notNull()
    .unique()
    .references(() => mediaItems.id, { onDelete: "cascade" }),
  positionMs: integer("position_ms").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
