# mobile-cinema

A self-hosted library for a phone drive: scan the movies on it, browse them
in the browser and watch them in a theater mode that fits a phone.

The library lives on a drive that is mounted on the machine that runs the
server — a phone plugged in over USB, or anything else the machine can
mount. The server reads the movies, keeps a catalog of them and streams
them to the browser of any device on the same network.

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

### Configuration

Every setting of the API is an environment variable of the `api` service in
`docker-compose.yml`:

| Variable      | Meaning                                            | Default          |
| ------------- | -------------------------------------------------- | ---------------- |
| `HOST`        | The address the server listens on                   | `0.0.0.0`        |
| `PORT`        | The port the server listens on                      | `3002`           |
| `MOVIE_ROOT`  | The directory that holds the movies                 | `/movies`        |
| `DB_PATH`     | The catalog (a SQLite file)                         | `/data/catalog.sqlite` |
| `CACHE_DIR`   | The converted subtitles and the HLS playlists       | `/data/cache`    |
| `FFPROBE_PATH`| The ffprobe the scan asks about a movie             | `/usr/bin/ffprobe` |
| `FFMPEG_PATH` | The ffmpeg the HLS transcode runs                   | `/usr/bin/ffmpeg` |
| `LOG_LEVEL`   | `fatal`, `error`, `warn`, `info`, `debug`, `trace`  | `info`           |

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

## The API

| Method | Path                                | What it does                              |
| ------ | ----------------------------------- | ----------------------------------------- |
| `GET`  | `/api/health`                       | The state of the server                   |
| `GET`  | `/api/movies`                       | The catalog, searchable and sortable      |
| `GET`  | `/api/movies/:id`                   | The detail of a movie                     |
| `GET`  | `/api/movies/:id/script`            | The script of a movie, `?lang=`           |
| `GET`  | `/api/posters/:id`                  | The poster of a movie                     |
| `GET`  | `/api/subtitles/:id.vtt`            | The WebVTT of a subtitle                  |
| `GET`  | `/api/stream/:id`                   | The movie, with the range requests        |
| `GET`  | `/api/hls/:id/master.m3u8`          | The HLS playlist of a movie               |
| `POST` | `/api/scan`                         | Start a scan of the library               |
| `GET`  | `/api/scan`                         | The state of the running scan             |

## Layout

- `apps/server` — the API: the catalog, the scan, the streams.
- `apps/web` — the player: the library, the detail page and the theater.
- `deploy/nginx.conf` — the configuration of the web server in front of
  the player.
