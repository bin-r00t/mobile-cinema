import { describe, expect, it } from "vitest";

import { parseWebVtt } from "../../test/vtt.ts";
import { SubtitleParseError, parseTimestamp, toVtt } from "./toVtt.ts";

const SRT = [
  "1",
  "00:00:01,000 --> 00:00:03,000",
  "First line of the script.",
  "",
  "2",
  "00:00:04,000 --> 00:00:06,500",
  "Second line of the script.",
  "",
].join("\n");

const ASS = [
  "[Script Info]",
  "Title: Old Film",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\an8}Hello,\\Nworld!",
  "Dialogue: 0,0:00:04.00,0:00:06.25,Default,,0,0,0,,Second line, with a comma.",
  "",
].join("\n");

describe("toVtt", () => {
  it("turns an SRT file into a WebVTT file", () => {
    const vtt = toVtt(SRT, "srt");
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:03.000");
    expect(vtt).toContain("First line of the script.");
  });

  it("turns an ASS file into a WebVTT file", () => {
    const vtt = toVtt(ASS, "ass");
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:03.500");
    expect(vtt).toContain("00:00:04.000 --> 00:00:06.250");
  });

  it("keeps a WebVTT file as it is", () => {
    const vtt = toVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n", "vtt");
    expect(vtt).toBe("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n");
  });

  it("refuses a file without a WebVTT signature", () => {
    expect(() => toVtt("00:00:01.000 --> 00:00:02.000\nHi\n", "vtt")).toThrow(
      SubtitleParseError,
    );
  });

  it("skips a broken cue instead of losing the whole file", () => {
    const damaged = [
      "1",
      "not a timestamp --> neither is this",
      "This cue is lost.",
      "",
      "2",
      "00:00:04,000 --> 00:00:06,500",
      "This cue survives.",
      "",
    ].join("\n");

    const vtt = toVtt(damaged, "srt");
    expect(vtt).not.toContain("This cue is lost.");
    expect(vtt).toContain("This cue survives.");
  });

  it("refuses a file that holds no cue at all", () => {
    expect(() => toVtt("nothing to see here\n", "srt")).toThrow(SubtitleParseError);
  });

  it("strips the style markers of an ASS file", () => {
    const vtt = toVtt(ASS, "ass");
    expect(vtt).not.toContain("{\\an8}");
    expect(vtt).toContain("Hello,\nworld!");
  });

  it("keeps the commas in the text of an ASS cue", () => {
    const vtt = toVtt(ASS, "ass");
    expect(vtt).toContain("Second line, with a comma.");
  });
});

describe("the converted file in a browser cue parser", () => {
  it("is read by a parser that follows the WebVTT specification", () => {
    const { cues, errors } = parseWebVtt(toVtt(SRT, "srt"));

    expect(errors).toEqual([]);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({
      startMs: 1000,
      endMs: 3000,
      text: "First line of the script.",
    });
    expect(cues[1]).toMatchObject({
      startMs: 4000,
      endMs: 6500,
      text: "Second line of the script.",
    });
  });

  it("is read by a parser that follows the WebVTT specification after an ASS conversion", () => {
    const { cues, errors } = parseWebVtt(toVtt(ASS, "ass"));

    expect(errors).toEqual([]);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.text).toBe("Hello,\nworld!");
    expect(cues[1]?.text).toBe("Second line, with a comma.");
  });

  it("is read by a parser that follows the WebVTT specification after a broken cue was skipped", () => {
    const damaged = [
      "1",
      "00:00:01,000 --> 00:00:03,000",
      "First line.",
      "",
      "broken",
      "",
    ].join("\n");

    const { cues, errors } = parseWebVtt(toVtt(damaged, "srt"));
    expect(cues).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});

describe("parseTimestamp", () => {
  it("reads the millisecond form of SRT", () => {
    expect(parseTimestamp("00:00:01,250")).toBe(1250);
    expect(parseTimestamp("01:02:03,004")).toBe(3723004);
  });

  it("reads the centisecond form of ASS", () => {
    expect(parseTimestamp("0:00:01.50")).toBe(1500);
  });

  it("refuses what is not a timestamp", () => {
    expect(parseTimestamp("later")).toBeNull();
    expect(parseTimestamp("00:99:01,000")).toBeNull();
  });
});
