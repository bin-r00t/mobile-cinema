# mobile-cinema

A self-hosted library for a phone drive: scan the movies on it, browse them
in the browser and watch them in a theater mode that fits a phone.

The library lives on a drive that is mounted on the machine that runs the
server — a phone plugged in over USB, or anything else the machine can
mount. The server reads the movies, keeps a catalog of them and streams
them to the browser of any device on the same network.

## Try it in five minutes

No phone and no Docker needed — a script builds a small library with three
movies that really play (it needs `ffmpeg` on the `PATH`):

```sh
npm install
./scripts/make-sample-library.sh /tmp/movies
mkdir -p /tmp/movies-catalog /tmp/movies-cache
MOVIE_ROOT=/tmp/movies DB_PATH=/tmp/movies-catalog/catalog.db \
  CACHE_DIR=/tmp/movies-cache npm run dev
```

The server scans nothing on its own, so ask it to:

```sh
curl -X POST http://127.0.0.1:3002/api/scan
```

Then open <http://localhost:5173> — three movies with posters, subtitles
and a theater mode that plays them. Stop the server with Ctrl-C when you
are done; nothing was written into the library.

## Running it

The whole thing is two containers: the API and the player. The player is
served by nginx, which hands everything under `/api` over to the API, so
the browser only ever talks to one address.

```sh
# Where the phone drive is mounted on this machine.
export MOVIE_ROOT=/mnt/phone/Movies
docker compose up --build
```

The player is then at <http://localhost:8080>, and the API at
<http://localhost:8080/api>.

`MOVIE_ROOT` is the only setting that has to be right: it is the directory
the server scans and streams from. Inside the container the movies are at
`/movies`, and the host directory is mounted there read only — the server
never writes to the movies, only to its own volume. When `MOVIE_ROOT` is
not set, compose falls back to `./movies`, which is handy for a try on a
machine without a phone attached.

### The phone drive

The drive has to be mounted on the host before the containers start: the
container sees the mount, not the phone.

- **A phone over USB with MTP** (`jmtpfs`, `mtpfs`, or the mount of your
  desktop) shows up somewhere under `/run/user/1000/gvfs` or `/media`. Set
  `MOVIE_ROOT` to the directory that holds the movies inside that mount.
  MTP is slow for many small files, so a library of a few hundred movies
  takes a while to scan the first time.
- **A phone over USB with MTP replaced by a file system** (`rclone mount`,
  `gphoto2`, or a plain network share) behaves like any other directory.

Mount it read only and give the path to the movies:

```sh
# An example with a network share that holds the movies.
export MOVIE_ROOT=/mnt/nas/movies
docker compose up --build
```

A mount that does not report file system events (most MTP mounts do not)
cannot be watched: the server only notices a change when it scans. Start a
scan by hand after plugging the phone in:

```sh
curl -X POST http://localhost:8080/api/scan
```

### How the scan works

One movie is one video file. The scan walks `MOVIE_ROOT`, asks `ffprobe`
about every video it finds (duration, codecs, dimensions) and looks for
the sidecar files that share its base name:

- `Movie.nfo` — a Kodi-style XML with the title, the year and the plot.
  Without one, the title is the file name.
- `Movie.jpg` — the poster.
- `Movie.en.srt`, `Movie.de.srt` … — the subtitles, one per language; they
  are converted to WebVTT in the cache the first time a browser asks for
  them.

The facts go into the catalog (a SQLite file), a movie per video. The
movie never moves and nothing is written next to it: the catalog and the
converted subtitles live in `DB_PATH` and `CACHE_DIR`, outside the
library. A scan can run while the server is up; its progress is at
`GET /api/scan/status` and the recent runs at `GET /api/scan/runs`. The
[architecture document](docs/architecture.md) has the details.

### Configuration

Every setting of the API is an environment variable of the `api` service in
`docker-compose.yml`:

| Variable       | Meaning                                                      | Default                   |
| -------------- | ------------------------------------------------------------ | ------------------------- |
| `HOST`         | The address the server listens on                            | `127.0.0.1`¹              |
| `PORT`         | The port the server listens on                               | `3002`                    |
| `MOVIE_ROOT`   | The directory that holds the movies                          | `/movies`¹                |
| `DB_PATH`      | The catalog (a SQLite file)                                  | `/data/catalog.sqlite`¹   |
| `CACHE_DIR`    | The converted subtitles and the HLS playlists                | `/data/cache`¹            |
| `FFPROBE_PATH` | The ffprobe the scan asks about a movie                      | `ffprobe` from the `PATH` |
| `FFMPEG_PATH`  | The ffmpeg the HLS transcode runs                            | `ffmpeg` from the `PATH`  |
| `LOG_LEVEL`    | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` | `info`                    |

¹ Inside the container the defaults come from `docker-compose.yml`: the
api listens on `0.0.0.0`, the movies are at `/movies` (mounted read only
from `MOVIE_ROOT` of the host, `./movies` as the fallback), and the
catalog and the cache live on the `catalog` volume at `/data`. The API
itself has no default for those three: without Docker you set them, as the
quickstart above does.

The catalog and the cache live on the `catalog` volume, so they survive a
restart of the containers. The port of the player is set with `WEB_PORT`,
which defaults to `8080`.

### Without Docker

The server is Node and the player is a Vite app, so the workspace runs as
it is:

```sh
npm install
MOVIE_ROOT=/mnt/phone/Movies DB_PATH=./catalog.sqlite CACHE_DIR=./cache \
  npm run dev
```

`npm run dev` starts the API on port 3002 and the player on port 5173; the
player calls the API through the proxy of the development server.

## The theater mode

`Play` in the detail page takes the whole screen: the theater is a fixed
page over the window, with the poster of the movie blurred behind the
player and the facts at its side. The keyboard plays, seeks and mutes —
space, the left and right arrows for ten seconds at a time, the up and
down arrows for the volume, `f` for the fullscreen, `m` for the mute — and
`Esc` leaves the theater. On a screen of a phone, a swipe across the
picture seeks and a swipe up or down moves the volume. The button in the
controls lists the shortcuts.

The player picks the best mode the movie allows: the file is streamed
directly when the browser can decode it, and anything else is transcoded
to HLS on demand — the segments land in the cache, so a movie is
transcoded once. The subtitles of the movie float over the picture, with a
picker, a size and a time offset in the settings; the script tab of the
detail page shows the whole transcript.

The position of a movie is kept on the server, so the detail page offers
to pick a movie up where it was left. The app itself is installable (the
button in the header, when the browser offers it) and keeps its shell
cached: without a network the library still opens, only the data of the
server is missing.

## The API

| Method | Path                       | What it does                              |
| ------ | -------------------------- | ----------------------------------------- |
| `GET`  | `/api/health`              | The state of the server                   |
| `GET`  | `/api/movies`              | The catalog, searchable and sortable      |
| `GET`  | `/api/movies/:id`          | The detail of a movie                     |
| `GET`  | `/api/movies/:id/script`   | The script of a movie, `?lang=`           |
| `GET`  | `/api/posters/:id`         | The poster of a movie                     |
| `GET`  | `/api/subtitles/:id.vtt`   | The WebVTT of a subtitle                  |
| `GET`  | `/api/stream/:id`          | The movie, with the range requests        |
| `GET`  | `/api/hls/:id/master.m3u8` | The HLS playlist of a movie               |
| `POST` | `/api/scan`                | Start a scan of the library               |
| `GET`  | `/api/scan/status`         | The state of the current or last scan     |
| `GET`  | `/api/scan/runs`           | The recent scan runs                      |
| `POST` | `/api/progress`            | Keep the position a movie was left at     |
| `GET`  | `/api/progress/:movieId`   | The position of one movie                 |
| `GET`  | `/api/progress?limit=`     | The movies played last, most recent first |

## Layout

- `apps/server` — the API: the catalog, the scan, the streams.
- `apps/web` — the player: the library, the detail page and the theater.
- `deploy/nginx.conf` — the configuration of the web server in front of
  the player.
- `scripts/make-sample-library.sh` — a library with three movies that
  really play, for trying the app without a phone.
- `docs/architecture.md` — how the pieces fit together, from the scan to
  the segments of the transcode.
