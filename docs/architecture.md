# The architecture of mobile-cinema

A self-hosted movie library in two parts: an API that catalogs and streams
the movies of a drive, and a player in the browser. This document walks
through the parts, how a movie gets from the drive to the screen, and where
the data lives. The [README](../README.md) tells you how to run it.

## The workspace

An npm workspace with two apps and a shared configuration:

```
apps/server   the API: the catalog, the scan, the streams (Node, Fastify)
apps/web      the player: the library, the detail page, the theater (React, Vite)
deploy/       the nginx configuration that fronts the player in Docker
scripts/      make-sample-library.sh, a library with real media for trying it
```

The server reads the movies and never writes to them. Everything it
produces — the catalog and the converted files — goes to its own paths
(`DB_PATH`, `CACHE_DIR`), which is what makes the movie root mountable
read only.

## The server

A Fastify application (`apps/server/src/index.ts`) that loads its settings
from the environment (`src/config.ts`, a zod schema; `MOVIE_ROOT`,
`DB_PATH` and `CACHE_DIR` are required, everything else has a default) and
registers the routes of `src/routes/`:

| Route                          | What it does                                      |
| ------------------------------ | ------------------------------------------------- |
| `GET /api/health`              | liveness                                          |
| `GET /api/movies`              | the catalog, with `?q=`, sort keys and pagination |
| `GET /api/movies/:id`          | one movie: facts, playback modes, subtitle tracks |
| `GET /api/movies/:id/script`   | the transcript of a movie as JSON, `?lang=`       |
| `GET /api/posters/:id`         | the poster image                                  |
| `GET /api/subtitles/:id.vtt`   | a converted WebVTT subtitle                       |
| `GET /api/stream/:id`          | the file itself, with range requests              |
| `GET /api/hls/:id/master.m3u8` | the HLS playlist (transcoded on demand)           |
| `POST /api/scan`               | start a scan of the movie root                    |
| `GET /api/scan/status`         | the state of the current or last scan             |
| `GET /api/scan/runs`           | the recent scan runs                              |
| `POST /api/progress`           | store a playback position                         |
| `GET /api/progress/:movieId`   | the position of one movie                         |
| `GET /api/progress?limit=`     | the movies played last, most recent first         |

### The catalog

SQLite through Drizzle (`DB_PATH`). The heart of the schema is
`media_items`: one row per movie with the facts the scan found — title,
year, plot, duration, codecs, size, and the paths of the poster and of the
subtitle sidecars. `playback_progress` holds one row per played movie with
the position it was left at.

### The scan

`services/scanner/` turns a directory tree into catalog rows, one movie per
video file:

1. `walk.ts` walks `MOVIE_ROOT` and collects the video files.
2. `probe.ts` asks `ffprobe` about each one: duration, codecs, dimensions.
3. `sidecar.ts` reads the `.nfo` next to a video (a Kodi-style XML) for
   title, year and plot; without one, `title.ts` falls back to the file
   name.
4. `subtitles.ts` collects the `.srt` files that share the base name of the
   video; the language comes from the file name (`.en.srt`).

`services/scan/runner.ts` drives a run, keeps its state for
`/api/scan/status` and remembers recent runs. Scans are started by hand
(`POST /api/scan`) or by the watcher.

### The watcher

`services/watcher.ts` watches the movie root with chokidar and starts a
rescan when the files change. The rescan is debounced (two seconds of
quiet), so a bulk copy triggers one scan, not one per file. Mounts that do
not report file system events — most MTP mounts of a phone — cannot be
watched; with those, the scan is the manual endpoint.

### Playback: two modes

A movie can play progressively or as HLS; `GET /api/movies/:id` reports
which modes are available and the player picks.

- **Progressive** (`/api/stream/:id`) streams the file as it is, with range
  requests, when the browser can play the codec — the usual case for an
  H.264 MP4.
- **HLS** (`/api/hls/:id/master.m3u8`) transcodes on demand: the server
  runs `ffmpeg`, which cuts the movie into segments inside `CACHE_DIR` and
  writes a playlist. The playlist is reused across sessions, so the
  transcode cost is paid once per movie. This is the path for codecs the
  browser cannot play directly.

### The cache and the subtitles

`CACHE_DIR` holds everything the server derives: the converted subtitles
and the HLS segments and playlists. `services/subtitles/` converts the
SRT sidecars to WebVTT (`.vtt`) the first time they are asked for; the
route then serves the converted file. The path safety of
`pathSafety.ts` keeps request ids and file names from escaping the
directories they belong to.

## The web app

A React single-page application (Vite, `BrowserRouter`) with three pages:
the **library** (a grid of posters with search and sort), the **movie
detail** (facts, the script, the subtitle tracks) and the **theater**
(whole-screen playback).

The pieces around the player:

- `components/Player.tsx` plays either the HLS playlist (through hls.js) or
  the progressive stream, and saves the playback position to the server —
  the next opening of the movie picks up where it was left.
- `components/playerKeys.ts` and `components/playerGestures.ts` map the
  keyboard and the touch input to player actions (play, seek, volume,
  fullscreen); `Esc` leaves the theater, and the button in the controls
  lists the shortcuts.
- `components/SubtitleOverlay.tsx` renders the cues over the picture with
  size and time-offset settings (`SubtitleSettings.tsx`); the cues come
  from the WebVTT endpoint and are parsed in the browser.
- `pwa.ts` registers the service worker (`public/sw.js`) and offers the
  install button. The service worker keeps the app shell in a cache —
  navigations go to the network first with the cached shell as the
  fallback, the hashed build assets are cache-first, and `/api` is never
  cached — so the library opens without a network.
- `styles/` holds plain CSS: `global.css` names the layout tokens (space,
  type, the breakpoints), `desktop.css` lays the wide screens out, and
  `mobile.css` carries the safe areas and the touch targets of a phone.

In the development server the app calls `/api` through Vite's proxy
(`API_TARGET`, default `http://127.0.0.1:3002`); in Docker nginx does the
same job in production.

## The deployment

`docker-compose.yml` builds the two images. The `api` service gets the
movie root mounted read only at `/movies` and keeps its catalog and cache
on the `catalog` volume. The `web` service serves the built player with
nginx: nginx hands every `/api` request to the `api` service, so the
browser talks to one origin. `WEB_PORT` publishes the player (8080 by
default).

## The tests

Vitest everywhere: the routes and services of the server carry their
fixtures next to them (`*.test.ts`), the web app tests its parsers and
mappers (the subtitle parsing, the key and gesture maps, the API helpers).
`npm run test` in the root runs all of them.
