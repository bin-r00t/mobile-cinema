/**
 * Discovery of the subtitle files that belong to a movie.
 *
 * A release puts its subtitles next to the video, named after it and
 * sometimes tagged with a language: `Some.Movie.2020.en.srt`. This module
 * finds those files, works out which language each one holds and picks the
 * track the player should use by default.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { SubtitleParseError, toVtt, type SubtitleFormat } from "../subtitles/toVtt.ts";

/** The subtitle containers a scan understands. */
export const SUBTITLE_EXTENSIONS: ReadonlyMap<string, SubtitleFormat> = new Map<
  string,
  SubtitleFormat
>([
  [".srt", "srt"],
  [".ass", "ass"],
  [".ssa", "ass"],
  [".vtt", "vtt"],
]);

/**
 * The three-letter codes that are common in the wild, mapped to the
 * two-letter code the rest of the app speaks.
 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  eng: "en",
  fre: "fr",
  fra: "fr",
  ger: "de",
  deu: "de",
  spa: "es",
  ita: "it",
  jpn: "ja",
  kor: "ko",
  chi: "zh",
  zho: "zh",
  rus: "ru",
  por: "pt",
  dut: "nl",
  nld: "nl",
  swe: "sv",
  nor: "no",
  dan: "da",
  fin: "fi",
  pol: "pl",
  tur: "tr",
  ara: "ar",
  heb: "he",
  hin: "hi",
  vie: "vi",
  tha: "th",
  ind: "id",
  ces: "cs",
  cze: "cs",
  hun: "hu",
  ron: "ro",
  rum: "ro",
  ukr: "uk",
  gre: "el",
  ell: "el",
  cat: "ca",
  eus: "eu",
  glg: "gl",
  slv: "sl",
  srp: "sr",
  bul: "bg",
  mkd: "mk",
  ben: "bn",
  tam: "ta",
  tel: "te",
  mal: "ml",
  mar: "mr",
  guj: "gu",
  pan: "pa",
  urd: "ur",
  per: "fa",
  fas: "fa",
};

/** The tags that mark a track as forced or as a hearing-impaired variant. */
const FORCED_TAGS: ReadonlySet<string> = new Set([
  "forced",
  "sdh",
  "cc",
  "hi",
  "hearing-impaired",
]);

export interface SubtitleTrack {
  /** Absolute path of the subtitle file. */
  path: string;
  /** The container the subtitle is stored in. */
  format: SubtitleFormat;
  /** The language, as a lower-case code, or null when the name says nothing. */
  language: string | null;
  /** True for a track that is meant to be shown only when it is needed. */
  isForced: boolean;
}

/**
 * Turns a language code into the two-letter form the app stores, or null
 * when the text is not a language code at all.
 */
export function normalizeLanguage(code: string): string | null {
  const lower = code.trim().toLowerCase();
  if (lower.length === 0) return null;

  const alias = LANGUAGE_ALIASES[lower];
  if (alias) return alias;

  // A region is not part of the language: "pt-BR" is Portuguese.
  const base = lower.split(/[-_]/)[0] ?? "";
  if (base.length === 2 || base.length === 3) return base;

  return null;
}

/**
 * Reads the language and the forced flag out of the tags that follow the
 * name of the video, e.g. `["en"]` or `["zh", "forced"]`.
 */
export function parseSubtitleTags(tags: string[]): {
  language: string | null;
  isForced: boolean;
} {
  let language: string | null = null;
  let isForced = false;

  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (FORCED_TAGS.has(lower)) {
      isForced = true;
      continue;
    }
    const code = normalizeLanguage(lower);
    if (code) language = code;
  }

  // "hi" means hearing impaired only when no other language was named.
  if (language === null && tags.some((tag) => tag.toLowerCase() === "hi")) {
    isForced = true;
  }

  return { language, isForced };
}

/**
 * Lists the subtitle files that belong to the given video.
 *
 * A file belongs to the video when it sits in the same directory and its
 * name is the name of the video — with or without language tags — or the
 * name of the folder that holds it.
 */
export async function discoverSubtitles(videoPath: string): Promise<SubtitleTrack[]> {
  const directory = dirname(videoPath);
  const videoBase = basename(videoPath, extname(videoPath));
  const folderName = basename(directory);

  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // The directory is unreadable or gone; there are no subtitles to find.
    return [];
  }

  const tracks: SubtitleTrack[] = [];

  for (const entry of entries) {
    // Only a plain file is a subtitle. A symbolic link could point at
    // anything outside the library, and its content would end up in the
    // file the player reads.
    if (!entry.isFile()) continue;

    const extension = extname(entry.name).toLowerCase();
    const format = SUBTITLE_EXTENSIONS.get(extension);
    if (!format) continue;

    const stem = basename(entry.name, extname(entry.name));
    let tags: string[];

    if (stem === videoBase || stem === folderName) {
      tags = [];
    } else if (stem.startsWith(`${videoBase}.`)) {
      tags = stem
        .slice(videoBase.length + 1)
        .split(".")
        .filter(Boolean);
    } else {
      continue;
    }

    const { language, isForced } = parseSubtitleTags(tags);
    tracks.push({
      path: join(directory, entry.name),
      format,
      language,
      isForced,
    });
  }

  tracks.sort((a, b) => a.path.localeCompare(b.path));
  return tracks;
}

export interface PrimarySelectionOptions {
  /** The languages that are preferred, best first. Defaults to English. */
  preferredLanguages?: readonly string[];
}

const DEFAULT_PREFERRED_LANGUAGES: readonly string[] = ["en"];

/**
 * Picks the track the player should use by default.
 *
 * A preferred language wins over any other, a track that names its language
 * wins over one that does not, a forced track is only used when nothing
 * else is there, and a file that is already WebVTT wins over one that has
 * to be converted.
 */
export function selectPrimaryTrack(
  tracks: readonly SubtitleTrack[],
  options: PrimarySelectionOptions = {},
): SubtitleTrack | null {
  if (tracks.length === 0) return null;

  const preferred = options.preferredLanguages ?? DEFAULT_PREFERRED_LANGUAGES;

  const rank = (track: SubtitleTrack): number[] => {
    const languageIndex =
      track.language === null
        ? -1
        : preferred.findIndex(
            (code) => code.toLowerCase() === track.language?.toLowerCase(),
          );

    return [
      languageIndex >= 0 ? languageIndex : preferred.length,
      track.language === null ? 1 : 0,
      track.isForced ? 1 : 0,
      track.format === "vtt" ? 0 : track.format === "srt" ? 1 : 2,
    ];
  };

  const compare = (a: SubtitleTrack, b: SubtitleTrack): number => {
    const left = rank(a);
    const right = rank(b);
    for (let i = 0; i < left.length; i++) {
      const difference = left[i]! - right[i]!;
      if (difference !== 0) return difference;
    }
    // The shortest name is the least decorated one, and it breaks ties
    // in a way that does not depend on the order of the file system.
    return a.path.length - b.path.length || a.path.localeCompare(b.path);
  };

  return [...tracks].sort(compare)[0] ?? null;
}

/**
 * Finds the subtitle of a video and the track the player should use.
 */
export async function findPrimarySubtitle(
  videoPath: string,
  options: PrimarySelectionOptions = {},
): Promise<SubtitleTrack | null> {
  const tracks = await discoverSubtitles(videoPath);
  return selectPrimaryTrack(tracks, options);
}

/**
 * Converts a subtitle file into WebVTT and writes it into `outputDir`.
 *
 * Returns the path of the written file, or null when the subtitle is
 * damaged — a broken subtitle must not break the scan.
 */
export async function convertTrackToVtt(
  track: SubtitleTrack,
  outputDir: string,
): Promise<string | null> {
  let content: string;
  try {
    // O_NOFOLLOW keeps a symbolic link from being read, even if it is put
    // in place of the subtitle between the scan and the conversion.
    const handle = await open(track.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      content = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  let vtt: string;
  try {
    vtt = toVtt(content, track.format);
  } catch (error) {
    if (error instanceof SubtitleParseError) return null;
    throw error;
  }

  await mkdir(outputDir, { recursive: true });

  // The name carries a hash of the original path so that two movies with
  // the same subtitle name do not overwrite each other.
  const stem = basename(track.path, extname(track.path));
  const hash = createHash("sha1").update(track.path).digest("hex").slice(0, 8);
  const target = join(outputDir, `${stem}.${hash}.vtt`);

  await writeFile(target, vtt, "utf8");
  return target;
}
