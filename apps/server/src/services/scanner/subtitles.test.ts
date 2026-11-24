import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureLibrary } from "../../test/fixtures.ts";
import { parseWebVtt } from "../../test/vtt.ts";
import {
  convertTrackToVtt,
  discoverSubtitles,
  findPrimarySubtitle,
  normalizeLanguage,
  parseSubtitleTags,
  selectPrimaryTrack,
  type SubtitleTrack,
} from "./subtitles.ts";

const temporaries: string[] = [];

async function makeLibrary(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mobile-cinema-subs-"));
  temporaries.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return root;
}

afterEach(async () => {
  for (const directory of temporaries.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("discoverSubtitles", () => {
  it("finds the subtitle of a video and reads its language", async () => {
    const library = await createFixtureLibrary();
    try {
      const tracks = await discoverSubtitles(library.files.video);
      expect(tracks).toHaveLength(1);
      expect(tracks[0]?.path).toBe(library.files.srt);
      expect(tracks[0]?.language).toBe("en");
      expect(tracks[0]?.format).toBe("srt");
      expect(tracks[0]?.isForced).toBe(false);
    } finally {
      await library.cleanup();
    }
  });

  it("finds a subtitle without a language", async () => {
    const library = await createFixtureLibrary();
    try {
      const tracks = await discoverSubtitles(library.files.nestedVideo);
      expect(tracks).toHaveLength(1);
      expect(tracks[0]?.path).toBe(library.files.ass);
      expect(tracks[0]?.language).toBeNull();
      expect(tracks[0]?.format).toBe("ass");
    } finally {
      await library.cleanup();
    }
  });

  it("ignores the files that do not belong to the video", async () => {
    const library = await createFixtureLibrary();
    try {
      const tracks = await discoverSubtitles(library.files.video);
      const paths = tracks.map((track) => track.path);
      expect(paths).not.toContain(library.files.poster);
      expect(paths).not.toContain(library.files.nfo);
      expect(paths).not.toContain(library.files.nestedVideo);
    } finally {
      await library.cleanup();
    }
  });

  it("finds every subtitle of a video", async () => {
    const root = await makeLibrary({
      "Film.en.srt": "1\n00:00:01,000 --> 00:00:02,000\nHi\n",
      "Film.fr.srt": "1\n00:00:01,000 --> 00:00:02,000\nSalut\n",
      "Film.forced.srt": "1\n00:00:01,000 --> 00:00:02,000\nForced\n",
      "Film.mkv": "",
      "Other.en.srt": "1\n00:00:01,000 --> 00:00:02,000\nOther\n",
    });

    const tracks = await discoverSubtitles(join(root, "Film.mkv"));
    expect(tracks).toHaveLength(3);
    expect(tracks.filter((track) => track.language === "en")).toHaveLength(1);
    expect(tracks.filter((track) => track.language === "fr")).toHaveLength(1);
    expect(tracks.find((track) => track.language === null)?.isForced).toBe(true);
  });

  it("finds a subtitle that is named after the folder of the video", async () => {
    const root = await makeLibrary({
      "Movie (1999)/Movie (1999).mp4": "",
      "Movie (1999)/Movie (1999).srt": "1\n00:00:01,000 --> 00:00:02,000\nHi\n",
    });

    const tracks = await discoverSubtitles(
      join(root, "Movie (1999)", "Movie (1999).mp4"),
    );
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.language).toBeNull();
  });

  it("survives a directory it cannot read", async () => {
    const tracks = await discoverSubtitles("/definitely/not/here/Movie.mkv");
    expect(tracks).toEqual([]);
  });

  it("ignores a subtitle that is a symbolic link", async () => {
    const root = await makeLibrary({
      "Film.mkv": "",
      "elsewhere.srt": "1\n00:00:01,000 --> 00:00:02,000\nHi\n",
    });
    await symlink(join(root, "elsewhere.srt"), join(root, "Film.en.srt"));

    const tracks = await discoverSubtitles(join(root, "Film.mkv"));
    expect(tracks).toEqual([]);
  });
});

describe("selectPrimaryTrack", () => {
  const track = (
    name: string,
    language: string | null,
    isForced = false,
    format: SubtitleTrack["format"] = "srt",
  ): SubtitleTrack => ({
    path: `/library/${name}`,
    language,
    isForced,
    format,
  });

  it("prefers the preferred language", () => {
    const primary = selectPrimaryTrack([
      track("Film.fr.srt", "fr"),
      track("Film.en.srt", "en"),
    ]);
    expect(primary?.language).toBe("en");
  });

  it("prefers a track that names its language over one that does not", () => {
    const primary = selectPrimaryTrack([
      track("Film.srt", null),
      track("Film.de.srt", "de"),
    ]);
    expect(primary?.language).toBe("de");
  });

  it("prefers an ordinary track over a forced one", () => {
    const primary = selectPrimaryTrack([
      track("Film.en.forced.srt", "en", true),
      track("Film.en.srt", "en"),
    ]);
    expect(primary?.isForced).toBe(false);
  });

  it("prefers a subtitle that is already WebVTT", () => {
    const primary = selectPrimaryTrack([
      track("Film.en.ass", "en", false, "ass"),
      track("Film.en.vtt", "en", false, "vtt"),
    ]);
    expect(primary?.format).toBe("vtt");
  });

  it("has no primary track when there is no track at all", () => {
    expect(selectPrimaryTrack([])).toBeNull();
  });

  it("honours a different list of preferred languages", () => {
    const primary = selectPrimaryTrack(
      [track("Film.en.srt", "en"), track("Film.fr.srt", "fr")],
      { preferredLanguages: ["fr"] },
    );
    expect(primary?.language).toBe("fr");
  });
});

describe("findPrimarySubtitle", () => {
  it("finds the subtitle the player should use", async () => {
    const root = await makeLibrary({
      "Film.fr.srt": "1\n00:00:01,000 --> 00:00:02,000\nSalut\n",
      "Film.en.srt": "1\n00:00:01,000 --> 00:00:02,000\nHi\n",
      "Film.mkv": "",
    });

    const primary = await findPrimarySubtitle(join(root, "Film.mkv"));
    expect(primary?.language).toBe("en");
  });
});

describe("parseSubtitleTags", () => {
  it("reads a language code", () => {
    expect(parseSubtitleTags(["en"])).toEqual({ language: "en", isForced: false });
  });

  it("reads a three-letter language code", () => {
    expect(parseSubtitleTags(["eng"])).toEqual({ language: "en", isForced: false });
  });

  it("reads a language with a region", () => {
    expect(parseSubtitleTags(["pt-BR"])).toEqual({
      language: "pt",
      isForced: false,
    });
  });

  it("reads the forced marker", () => {
    expect(parseSubtitleTags(["forced"])).toEqual({
      language: null,
      isForced: true,
    });
    expect(parseSubtitleTags(["en", "sdh"])).toEqual({
      language: "en",
      isForced: true,
    });
  });
});

describe("normalizeLanguage", () => {
  it("maps the codes that are common in the wild", () => {
    expect(normalizeLanguage("eng")).toBe("en");
    expect(normalizeLanguage("chi")).toBe("zh");
  });

  it("refuses what is not a language code", () => {
    expect(normalizeLanguage("1080p")).toBeNull();
    expect(normalizeLanguage("")).toBeNull();
  });
});

describe("convertTrackToVtt", () => {
  it("writes a WebVTT file a browser can read", async () => {
    const library = await createFixtureLibrary();
    try {
      const [track] = await discoverSubtitles(library.files.video);
      if (!track) throw new Error("the fixture subtitle was not found");

      const outputDir = await makeLibrary({});
      const target = await convertTrackToVtt(track, outputDir);
      expect(target).not.toBeNull();
      if (!target) throw new Error("the subtitle was not converted");

      const content = await readFile(target, "utf8");
      const { cues, errors } = parseWebVtt(content);
      expect(errors).toEqual([]);
      expect(cues).toHaveLength(2);
      expect(cues[0]?.text).toBe("First line of the script.");
    } finally {
      await library.cleanup();
    }
  });

  it("gives up on a damaged subtitle instead of breaking the scan", async () => {
    const root = await makeLibrary({
      "Film.en.srt": "this is not a subtitle\n",
      "Film.mkv": "",
    });

    const [track] = await discoverSubtitles(join(root, "Film.mkv"));
    if (!track) throw new Error("the subtitle was not found");
    const target = await convertTrackToVtt(track, await makeLibrary({}));
    expect(target).toBeNull();
  });

  it("refuses to read a subtitle that is a symbolic link", async () => {
    const root = await makeLibrary({
      "elsewhere.srt": "1\n00:00:01,000 --> 00:00:02,000\nHi\n",
    });
    const link = join(root, "Film.en.srt");
    await symlink(join(root, "elsewhere.srt"), link);

    const target = await convertTrackToVtt(
      { path: link, format: "srt", language: "en", isForced: false },
      await makeLibrary({}),
    );
    expect(target).toBeNull();
  });
});
