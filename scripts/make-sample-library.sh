#!/usr/bin/env bash
#
# Builds a small sample library that a browser can really play.
#
# The fixtures of the server write a few bytes in place of a video, so
# nothing can be played and no layout can be looked at with real posters
# and real durations. This script builds a library of three movies with
# real media: an H.264 video with a sound track, a poster, a subtitle and
# an NFO sidecar for each of them.
#
# Everything is written inside the target directory, and the script can be
# run again over a directory that already holds a library.

set -euo pipefail

# --- the arguments -----------------------------------------------------------

usage() {
  cat <<'USAGE'
Usage: make-sample-library.sh [DIRECTORY]

Builds a sample library of three movies with real media in DIRECTORY
(default: ./sample-library). The directory is created when it does not
exist, and the three movies of an existing library in it are replaced.

Requirements: ffmpeg (with libx264 and aac) and ffprobe on the PATH.

After the library is built, start the server against it. The catalog and
the cache have to live outside the library: the server watches the movie
root, and every file it writes into the cache starts another scan.

  LIB="<DIRECTORY>"
  mkdir -p "$LIB-catalog" "$LIB-cache"
  MOVIE_ROOT="$LIB" \
  DB_PATH="$LIB-catalog/catalog.db" \
  CACHE_DIR="$LIB-cache" \
    npm run dev --workspace @mobile-cinema/server

The server does not scan the library on its own, so ask it to:

  curl -X POST http://127.0.0.1:3002/api/scan

Then open the library in the web app:

  npm run dev --workspace @mobile-cinema/web

The movies are at http://127.0.0.1:5173/ and the API answers at
http://127.0.0.1:3002/api/movies.
USAGE
}

TARGET="./sample-library"

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      if [ "$#" -gt 0 ]; then TARGET="$1"; fi
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      TARGET="$1"
      shift
      ;;
  esac
done

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required to build the sample library." >&2
  exit 1
fi

# The three movies of the library are built again on every run, so a target
# that is empty is refused rather than filled with folders of nothing.
case "$TARGET" in
  "" | "/")
    echo "Refusing to build the library in '$TARGET'." >&2
    exit 2
    ;;
esac

# --- the movies --------------------------------------------------------------
#
# Every movie is a directory of its own, with the video and its sidecars
# next to each other: the scanner looks for a sibling .nfo, a sibling
# poster and a sibling subtitle whose name is the name of the video
# followed by the language.

# The name of the directory, the title, the year, the plot, the genre,
# the rating, the container, the size and the length of the video.
MOVIES=(
  "The Quiet Harbour|The Quiet Harbour|2019|A harbour keeper watches the last cargo ships of a dying port town.|Drama|7.4|mkv|1280x720|6"
  "Night Bus to Vienna|Night Bus to Vienna|2021|The last bus of the night takes a shortcut that nobody remembers taking.|Thriller|6.9|mp4|1280x720|6"
  "Salt and Paper|Salt and Paper|2017|A food writer walks the length of a salt mine with a camera and a notebook.|Documentary|8.1|mkv|1920x1080|6"
)

# The tone of the sound track of each movie, in hertz.
TONES=(220 330 440)

build_movie() {
  local record="$1"
  local tone="$2"

  local directory title year plot genre rating container size duration
  IFS="|" read -r directory title year plot genre rating container size duration <<<"$record"

  local folder="$TARGET/$directory"
  # The folder of the movie is emptied first, so a run over an existing
  # library replaces the movie instead of leaving the old files behind.
  rm -rf "$folder"
  mkdir -p "$folder"

  local base="$folder/$directory"
  local video="$base.$container"

  echo "  $title ($year)"

  # The video: a test pattern with a tone, encoded as H.264 with AAC.
  # Six seconds is enough to play and small enough to keep the library light.
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=${size}:rate=24:duration=${duration}" \
    -f lavfi -i "sine=frequency=${tone}:sample_rate=44100:duration=${duration}" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -r 24 \
    -c:a aac -b:a 96k -ac 2 \
    -shortest \
    "$video"

  # The poster: a frame of the video, cropped to the 2/3 of a poster.
  ffmpeg -hide_banner -loglevel error -y \
    -i "$video" -frames:v 1 \
    -vf "scale=600:900:force_original_aspect_ratio=increase,crop=600:900" \
    -q:v 3 \
    "${base}.jpg"

  # The sidecar: the title, the plot and the rest of the metadata.
  cat >"${base}.nfo" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>${title}</title>
  <plot>${plot}</plot>
  <year>${year}</year>
  <runtime>1</runtime>
  <genre>${genre}</genre>
  <rating>${rating}</rating>
</movie>
EOF

  # The subtitle: two cues that fit inside the length of the video.
  cat >"${base}.en.srt" <<EOF
1
00:00:00,500 --> 00:00:02,500
${title} — the first line of the sample subtitle.

2
00:00:03,000 --> 00:00:05,500
${title} — the second line of the sample subtitle.
EOF
}

echo "Building the sample library in $TARGET"

for index in "${!MOVIES[@]}"; do
  build_movie "${MOVIES[$index]}" "${TONES[$index]}"
done

# The catalog and the cache of the server live outside the library: the
# server watches the movie root, and the files it writes into the cache
# would start another scan, and then another one, for ever. The script
# itself writes nothing outside the library, so the two directories are
# created by the command below.

echo
echo "The sample library is ready in $TARGET."
echo
echo "Start the server against it:"
echo
echo "  LIB=\"$TARGET\""
echo "  mkdir -p \"\$LIB-catalog\" \"\$LIB-cache\""
echo "  MOVIE_ROOT=\"\$LIB\" \\"
echo "  DB_PATH=\"\$LIB-catalog/catalog.db\" \\"
echo "  CACHE_DIR=\"\$LIB-cache\" \\"
echo "    npm run dev --workspace @mobile-cinema/server"
echo
echo "Then ask the server to scan it:"
echo
echo "  curl -X POST http://127.0.0.1:3002/api/scan"
echo
echo "And open the library in the web app:"
echo
echo "  npm run dev --workspace @mobile-cinema/web"
