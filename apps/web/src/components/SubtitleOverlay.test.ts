import { describe, expect, it } from "vitest";

import { findActiveCue, parseTimestamp, parseVttCues } from "./SubtitleOverlay";

describe("parseTimestamp", () => {
  it("reads a timestamp with hours", () => {
    expect(parseTimestamp("00:01:23.456")).toBeCloseTo(83.456, 3);
  });

  it("reads a timestamp without hours", () => {
    expect(parseTimestamp("01:02.5")).toBeCloseTo(62.5, 3);
  });

  it("accepts a comma in place of the dot", () => {
    expect(parseTimestamp("00:00:04,250")).toBeCloseTo(4.25, 3);
  });

  it("refuses what is not a timestamp", () => {
    expect(parseTimestamp("WEBVTT")).toBeNull();
    expect(parseTimestamp("1:23")).toBeNull();
  });
});

describe("parseVttCues", () => {
  it("reads the cues of a file", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:01.000 --> 00:03.000",
      "Hello there.",
      "",
      "00:04.000 --> 00:06.000",
      "General Kenobi!",
      "",
    ].join("\n");
    expect(parseVttCues(vtt)).toEqual([
      { start: 1, end: 3, text: "Hello there." },
      { start: 4, end: 6, text: "General Kenobi!" },
    ]);
  });

  it("keeps the two lines of a cue", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:01.000 --> 00:03.000",
      "First line",
      "Second line",
      "",
    ].join("\n");
    expect(parseVttCues(vtt)[0]?.text).toBe("First line\nSecond line");
  });

  it("drops the identifier of a cue, notes and styling", () => {
    const vtt = [
      "WEBVTT",
      "",
      "NOTE this is a note",
      "",
      "intro",
      "00:01.000 --> 00:03.000",
      "Only the text survives.",
      "",
      "STYLE",
      "::cue { color: red }",
      "",
    ].join("\n");
    expect(parseVttCues(vtt)).toEqual([
      { start: 1, end: 3, text: "Only the text survives." },
    ]);
  });

  it("strips the tags of the text", () => {
    const vtt = ["WEBVTT", "", "00:01.000 --> 00:03.000", "<i>Hello</i> you.", ""].join(
      "\n",
    );
    expect(parseVttCues(vtt)[0]?.text).toBe("Hello you.");
  });

  it("ignores the settings behind the timing", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:01.000 --> 00:03.000 align:start line:0",
      "Positioned.",
      "",
    ].join("\n");
    expect(parseVttCues(vtt)).toEqual([{ start: 1, end: 3, text: "Positioned." }]);
  });

  it("leaves a cue without text out", () => {
    const vtt = ["WEBVTT", "", "00:01.000 --> 00:03.000", "", ""].join("\n");
    expect(parseVttCues(vtt)).toEqual([]);
  });
});

describe("findActiveCue", () => {
  const cues = parseVttCues(
    [
      "WEBVTT",
      "",
      "00:10.000 --> 00:20.000",
      "Middle.",
      "",
      "00:30.000 --> 00:40.000",
      "Late.",
      "",
    ].join("\n"),
  );

  it("finds the cue that is spoken", () => {
    expect(findActiveCue(cues, 15)?.text).toBe("Middle.");
    expect(findActiveCue(cues, 10)?.text).toBe("Middle.");
  });

  it("finds nothing between two cues and after the last one", () => {
    expect(findActiveCue(cues, 25)).toBeNull();
    expect(findActiveCue(cues, 40)).toBeNull();
  });
});
