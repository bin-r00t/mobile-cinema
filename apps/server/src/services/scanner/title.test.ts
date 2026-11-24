import { describe, expect, it } from "vitest";
import { parseTitle } from "./title.ts";

describe("parseTitle", () => {
  it("cleans a release-style filename", () => {
    const parsed = parseTitle("Some.Movie.2020.1080p.BluRay.x264-GROUP.mkv");
    expect(parsed.title).toBe("Some Movie");
    expect(parsed.year).toBe(2020);
    expect(parsed.raw).toBe("Some.Movie.2020.1080p.BluRay.x264-GROUP");
  });

  it("keeps the title of a simple name", () => {
    const parsed = parseTitle("Old.Film.2019.mp4");
    expect(parsed.title).toBe("Old Film");
    expect(parsed.year).toBe(2019);
  });

  it("drops bracketed noise but keeps meaningful markers", () => {
    const parsed = parseTitle("The Long Walk (2018) [1080p] [BluRay].mkv");
    expect(parsed.title).toBe("The Long Walk");
    expect(parsed.year).toBe(2018);
  });

  it("keeps a director's cut marker", () => {
    const parsed = parseTitle("Some.Movie.2020.Directors.Cut.1080p.mkv");
    expect(parsed.title).toBe("Some Movie Directors Cut");
    expect(parsed.year).toBe(2020);
  });

  it("reports no year when the name has none", () => {
    const parsed = parseTitle("A Film With No Year.mkv");
    expect(parsed.title).toBe("A Film With No Year");
    expect(parsed.year).toBeNull();
  });

  it("handles underscores and spaces", () => {
    const parsed = parseTitle("Some_Movie_2020_720p_HDTV.mp4");
    expect(parsed.title).toBe("Some Movie");
    expect(parsed.year).toBe(2020);
  });

  it("never throws on odd input", () => {
    for (const name of ["", ".mkv", "2020.mkv", "....mkv"]) {
      expect(() => parseTitle(name)).not.toThrow();
      expect(typeof parseTitle(name).title).toBe("string");
    }
  });
});
