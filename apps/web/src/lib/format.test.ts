import { describe, expect, it } from "vitest";

import { formatDuration, formatYear } from "./format";

describe("formatDuration", () => {
  it("shows hours and minutes", () => {
    expect(formatDuration(6_120_000)).toBe("1h 42m");
  });

  it("shows minutes only below an hour", () => {
    expect(formatDuration(2_520_000)).toBe("42m");
  });

  it("shows hours only on a full hour", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
  });

  it("has nothing to show for an unknown runtime", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(0)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
  });

  it("does not claim a runtime of zero minutes", () => {
    expect(formatDuration(20_000)).toBe("<1m");
  });
});

describe("formatYear", () => {
  it("shows the year", () => {
    expect(formatYear(1999)).toBe("1999");
  });

  it("has nothing to show for an unknown year", () => {
    expect(formatYear(null)).toBeNull();
    expect(formatYear(undefined)).toBeNull();
  });
});
