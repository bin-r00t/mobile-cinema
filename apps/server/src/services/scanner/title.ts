import { basename, extname } from "node:path";

/**
 * Words that describe a release rather than the film: resolutions, sources,
 * codecs, audio formats, and the usual scene tags.
 */
const NOISE_WORDS: ReadonlySet<string> = new Set([
  "1080p",
  "1080i",
  "720p",
  "480p",
  "4k",
  "8k",
  "uhd",
  "hd",
  "sd",
  "hdr",
  "hdr10",
  "dv",
  "dolbyvision",
  "bluray",
  "blu-ray",
  "brrip",
  "bdrip",
  "remux",
  "webrip",
  "web-dl",
  "webdl",
  "web",
  "hdtv",
  "pdtv",
  "dvdrip",
  "dvd",
  "dvdscr",
  "cam",
  "hdcam",
  "ts",
  "tc",
  "r5",
  "hc",
  "korsub",
  "extended",
  "unrated",
  "uncut",
  "remastered",
  "proper",
  "repack",
  "internal",
  "limited",
  "complete",
  "collection",
  "duology",
  "trilogy",
  "quadrilogy",
  "x264",
  "x265",
  "h264",
  "h265",
  "hevc",
  "avc",
  "av1",
  "xvid",
  "divx",
  "aac",
  "aac2",
  "ac3",
  "eac3",
  "ddp",
  "ddp5",
  "ddp51",
  "dd5",
  "dts",
  "dtshd",
  "truehd",
  "atmos",
  "flac",
  "mp3",
  "opus",
  "2ch",
  "5ch",
  "6ch",
  "10bit",
  "8bit",
  "hdr10plus",
  "srt",
  "sub",
  "subs",
  "dubbed",
  "multi",
  "dual",
  "imax",
  "remaster",
]);

/**
 * Matches a 4-digit year that plausibly belongs to a release. The separators
 * around it may be dots, underscores or spaces, so no word boundaries.
 */
const YEAR_PATTERN = /(?<![0-9])(19\d{2}|20\d{2})(?![0-9])/;

export interface ParsedTitle {
  /** Cleaned-up title, e.g. "Some Movie". */
  title: string;
  /** Release year found in the filename, or null. */
  year: number | null;
  /** The filename without its extension, exactly as it was on disk. */
  raw: string;
}

/**
 * Parses a filename into a title and a year.
 *
 * "Some.Movie.2020.1080p.BluRay.x264-GROUP" becomes
 * { title: "Some Movie", year: 2020 }.
 */
export function parseTitle(filename: string): ParsedTitle {
  const raw = basename(filename, extname(filename));

  let working = raw;

  const yearMatch = working.match(YEAR_PATTERN);
  const year = yearMatch ? Number(yearMatch[1]) : null;

  // Drop bracketed groups that only carry noise, keep the meaningful ones.
  working = working.replace(/[\[{]([^\]}]*)[\]}]/g, (whole, inner: string) => {
    const words = inner
      .split(/[\s._]+/)
      .filter(Boolean)
      .map((word) => word.toLowerCase());
    const isNoise =
      words.length > 0 && words.every((word) => NOISE_WORDS.has(word));
    return isNoise ? " " : whole;
  });

  working = working.replace(/[\]()]/g, " ");
  working = working.replace(/\.(srt|ass|vtt|nfo|sub|idx)$/i, " ");

  // The release group is the last dot- or dash-separated token, e.g. "-GROUP".
  working = working.replace(/[-.][A-Za-z0-9]+$/, "");

  const parts = working
    .split(/[._\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !NOISE_WORDS.has(part.toLowerCase()))
    .filter((part) => !YEAR_PATTERN.test(part));

  const title = parts.join(" ").replace(/\s{2,}/g, " ").trim();

  return {
    title: title.length > 0 ? title : raw,
    year,
    raw,
  };
}
