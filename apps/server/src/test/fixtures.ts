import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A handful of bytes is enough: the fixtures stand in for real media files. */
const FAKE_VIDEO = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

export interface FixtureFiles {
  /** Absolute path of the video file. */
  video: string;
  /** Absolute path of the NFO sidecar, when the fixture has one. */
  nfo?: string;
  /** Absolute path of the English subtitle, when the fixture has one. */
  srt?: string;
  /** Absolute path of the ASS subtitle, when the fixture has one. */
  ass?: string;
  /** Absolute path of the poster image, when the fixture has one. */
  poster?: string;
}

export interface FixtureLibrary {
  /** Root of the fake library — the equivalent of MOVIE_ROOT. */
  root: string;
  /** Directory that holds the movies. */
  moviesDir: string;
  /** Directories that a scanner must skip. */
  ignoredDirs: string[];
  files: FixtureFiles;
  /** Removes the whole temporary tree. */
  cleanup(): Promise<void>;
}

export interface FixtureOptions {
  /** Where to create the tree. Defaults to a fresh directory in the OS temp dir. */
  root?: string;
}

/**
 * Builds a small, deliberately awkward media library:
 *
 * - a release-style filename with noise tags,
 * - a movie in a folder named after itself,
 * - sidecars (NFO, subtitles, poster) sitting next to the video,
 * - two directories a scanner must ignore.
 */
export async function createFixtureLibrary(
  options: FixtureOptions = {},
): Promise<FixtureLibrary> {
  const root =
    options.root ?? (await mkdtemp(join(tmpdir(), "mobile-cinema-fixture-")));
  const moviesDir = join(root, "Movies");
  await mkdir(moviesDir, { recursive: true });

  const videoName = "Some.Movie.2020.1080p.BluRay.x264";
  const video = join(moviesDir, `${videoName}.mkv`);
  const nfo = join(moviesDir, `${videoName}.nfo`);
  const srt = join(moviesDir, `${videoName}.en.srt`);
  const poster = join(moviesDir, `${videoName}.jpg`);

  const nestedDir = join(moviesDir, "Old Film (2019)");
  const nestedVideo = join(nestedDir, "Old.Film.2019.mp4");
  const nestedAss = join(nestedDir, "Old.Film.2019.ass");

  const ignoredDirs = [join(moviesDir, "@eaDir"), join(moviesDir, ".thumbnails")];

  await writeFile(video, FAKE_VIDEO);
  await writeFile(
    nfo,
    [
      "<movie>",
      "  <title>Some Movie</title>",
      "  <year>2020</year>",
      "  <plot>A fixture movie about fixtures.</plot>",
      "  <runtime>95 minutes</runtime>",
      "</movie>",
      "",
    ].join("\n"),
  );
  await writeFile(
    srt,
    [
      "1",
      "00:00:01,000 --> 00:00:03,000",
      "First line of the script.",
      "",
      "2",
      "00:00:04,000 --> 00:00:06,500",
      "Second line of the script.",
      "",
    ].join("\n"),
  );
  await writeFile(poster, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

  await mkdir(nestedDir, { recursive: true });
  await writeFile(nestedVideo, FAKE_VIDEO);
  await writeFile(
    nestedAss,
    "[Script Info]\nTitle: Old Film\n\n[V4+ Styles]\n\n[Events]\n",
  );

  await writeFile(join(moviesDir, "readme.txt"), "A library of fixtures.\n");

  for (const dir of ignoredDirs) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "ignored.jpg"), Buffer.from([0xff, 0xd8]));
  }

  return {
    root,
    moviesDir,
    ignoredDirs,
    files: { video, nfo, srt, poster, ass: nestedAss },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
