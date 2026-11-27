# Unfinished tasks — snapshot

Generated 2026-11-27 18:41 CST from the task-fetcher pool (`GET /api/tasks`).
85 tasks in the system: **78 completed, 6 available, 1 assigned, 0 failed.**
This file is a point-in-time snapshot; the pool (`tf.sh list`) is the live
truth.

## Urgent — review and merge tasks waiting in the pool

These two are fetched before anything else. While either is being worked on,
**no worker can fetch any task** (`409 MERGE_IN_PROGRESS`) — the pool pauses
until the pull request is merged and the review is delivered.

### #110 — Review and merge the desktop usage documentation (task #90)

- **Status** available · **Priority** urgent · **Holder** — · **Estimate** 15 min
- **What**: review and merge PR [#24](https://github.com/bin-r00t/mobile-cinema/pull/24)
  (branch `task/90-desktop-docs`, commit `624cfeb`, based on current main
  `47a5642`). It adds one 34-line "On a desktop" section to README.md between
  "The theater mode" and "The API" — desktop layout starts at 64rem
  (1024px), what the header, column cap, library, detail page and theater do
  there, mouse and keyboard behavior (shortcuts space/arrows/f/m/Esc from
  task #52), and how to open the app on a computer (quickstart or compose at
  port 8080). No code touched.
- **How to verify**: documentation review — read the section next to the code
  (`desktop.css`, the 64rem queries in `library.css`/`global.css`/`theater.css`,
  `--content-max` in global.css, the tiles `minmax(12rem, 1fr)`, the poster
  `minmax(240px, 320px)`, the panel `22rem`). Merge only when checks are green.

### #111 — Review and merge the watcher cache fix (task #91)

- **Status** available · **Priority** urgent · **Holder** — · **Estimate** ~25 min incl. verification
- **What**: review and merge PR [#25](https://github.com/bin-r00t/mobile-cinema/pull/25)
  (branch `task/91-watcher-ignore-cache`, commit `2888a60`, based on current
  main `47a5642`). `LibraryWatcher` gains `ignoredPaths`; `buildApp` hands it
  `CACHE_DIR` and the folder of the catalog, so a cache or catalog inside the
  movie root no longer starts the next scan (the server scanned forever and
  re-inserted subtitle tracks until `/api/subtitles/<id>.vtt` answered 404).
  An ignored path that would hold the movie root itself is dropped — ignoring
  it would blind the watcher for the whole library.
- **How to verify**: `npm test --workspace @mobile-cinema/server` (188 pass,
  4 new watcher tests), `npm run typecheck --workspace apps/server`,
  `npx eslint apps`. Already verified end to end with the sample library and
  `.cache`/`.catalog` inside the root: ids and subtitle URLs stable across a
  minute; touching a movie still triggers a real rescan. Two review notes:
  watcher rescans bypass `ScanRunner` so they never appear in
  `/api/scan/runs` (pre-existing); subtitle track ids are re-inserted on
  every scan by design. Merge with a merge commit when checks are green and
  remove the worktree `../mobile-cinema-task91` (its node_modules is
  disposable) after the merge lands.

## In progress

### #89 — Accept the desktop layout of the web app in a desktop browser

- **Status** assigned → **glm53-flash-010**, lease expires 10:58 UTC (soon) ·
  **Priority** normal · **Estimate** 30 min
- **What**: the whole desktop wave was merged branch by branch but never
  looked at as one app. Check library, movie page and theater at 1280x800,
  1440x900 and 1920x1080; check 390x844 and 600x900 still show the phone
  layout of main. Every finding is fixed on a branch of its own or written
  down with the width it was seen at; screenshots go into the task answer.
- **Depends on**: the desktop wave merged (#84, #83, #85, #86, #87, #88) and
  the sample library — both satisfied.

## Available — normal priority

### #94 — Let the server read its configuration from a .env file

- **Status** available · **Priority** normal · **Holder** — · **Estimate** 20 min
- **What**: today `npm run dev --workspace @mobile-cinema/server` fails with
  `Invalid configuration: MOVIE_ROOT: … undefined`; every command needs the
  env vars in front of it. The server should load a repo-root `.env` when it
  exists — `process.loadEnvFile`, **no new dependency** — while the shell
  environment still wins over the file. Plus `.env.example` pointing at the
  sample library of #83, and `.gitignore` keeping `.env` out.
- **Done when**: with `.env` present the server starts and `/api/health`
  shows the file's movieRoot; without it the server still refuses and names
  the missing variables; env beats file; tests, typecheck and lint pass.
- **Depends on**: nothing. #95 builds on it.

### #95 — Start the server and the web app with one command

- **Status** available · **Priority** normal · **Holder** — · **Estimate** 25 min
- **What**: the root `dev` script never reaches the web workspace (the
  server doesn't return), so the browser has nothing to open. Root
  `package.json` runs the workspaces in parallel; a new `scripts/dev.sh`
  builds the sample library when missing, starts server + web app, and
  prints both addresses (the web app takes the first free port from 5173,
  which is not always 5173) plus the scan command, and notes that the
  catalog and cache must live outside the library.
- **Done when**: one command starts both, prints the addresses and the scan
  command, builds the sample library when missing; web typecheck, build and
  lint pass.
- **Depends on**: #94 (the `.env` file) and #83 (sample library, already
  merged).

## Available — low priority

### #56 — End-to-end smoke test over a sample library

- **Status** available · **Priority** low · **Holder** — · **Estimate** 10 min
- **What**: `scripts/smoke.sh` builds a small sample library, boots the
  server against it and verifies scan, list, detail, range request, HLS
  playlist, subtitle endpoint and progress endpoint. Must pass from a clean
  checkout and fail loudly when an endpoint regresses. Touches
  `scripts/smoke.sh` and README.md.
- **Depends on**: #12, #15, #17, #19, #20, #26 — all long since completed.

### #79 — Build and smoke-test the Docker images of the deployment setup

- **Status** available · **Priority** low · **Holder** — · **Estimate** 15 min
- **What**: the deployment setup (PR #6) was merged without its images ever
  being built — no working docker daemon on the building or reviewing
  machine. On a machine **with** a working daemon: `docker compose build`,
  `MOVIE_ROOT=… docker compose up -d`, `/api/health` answers healthy, the
  player serves on :8080, and a range request through nginx
  (`curl -r 0-1023 /api/stream/<id>`) answers 206. One build-breaking defect
  was already found and fixed this way (commit `dd4d310`, the bad
  `apps/server` COPY). If something still fails, fix on a branch from latest
  main and open a PR. A verification task — merge nothing from it.
- **Depends on**: #55 (merged).
- **Note for this machine**: the local docker daemon is unusable — this task
  needs another machine to be done.

## Pool notes

- There is no delete endpoint; tasks leave the pool only by being completed,
  failed or released.
- `claim-next` returns the highest-priority available task, oldest first
  among equals — right now that is #110, then #111.
- Never review your own work; the two urgent reviews above must go to a
  worker who did not author the underlying branches.
