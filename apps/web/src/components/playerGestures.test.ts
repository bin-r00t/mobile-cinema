import { describe, expect, it } from "vitest";

import {
  clamp,
  gestureIntent,
  SWIPE_SEEK_SPAN_SECONDS,
  SWIPE_THRESHOLD_PX,
  seekSeconds,
  volumeDelta,
} from "./playerGestures";

describe("gestureIntent", () => {
  it("decides nothing while the finger has barely moved", () => {
    expect(gestureIntent(3, 4)).toBeNull();
    expect(gestureIntent(SWIPE_THRESHOLD_PX - 1, 0)).toBeNull();
  });

  it("decides to seek when the swipe goes along the screen", () => {
    expect(gestureIntent(60, 5)).toBe("seek");
    expect(gestureIntent(-60, 5)).toBe("seek");
  });

  it("decides to turn the volume when the swipe goes up or down", () => {
    expect(gestureIntent(5, 60)).toBe("volume");
    expect(gestureIntent(5, -60)).toBe("volume");
  });

  it("lets the further axis win a diagonal swipe", () => {
    expect(gestureIntent(80, 60)).toBe("seek");
    expect(gestureIntent(60, 80)).toBe("volume");
  });
});

describe("seekSeconds", () => {
  it("seeks half of the span across half of the screen", () => {
    expect(seekSeconds(400, 800)).toBeCloseTo(SWIPE_SEEK_SPAN_SECONDS / 2, 6);
  });

  it("seeks back when the swipe goes left", () => {
    expect(seekSeconds(-200, 800)).toBeLessThan(0);
  });

  it("answers zero when the width of the screen is not known yet", () => {
    expect(seekSeconds(100, 0)).toBe(0);
  });
});

describe("volumeDelta", () => {
  it("gives sound when the swipe goes up", () => {
    expect(volumeDelta(-160, 800)).toBeCloseTo(0.2, 6);
  });

  it("takes sound away when the swipe goes down", () => {
    expect(volumeDelta(400, 800)).toBeCloseTo(-0.5, 6);
  });

  it("answers zero when the height of the screen is not known yet", () => {
    expect(volumeDelta(100, 0)).toBe(0);
  });
});

describe("clamp", () => {
  it("keeps a value that is already inside", () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it("pulls a value back under the ceiling", () => {
    expect(clamp(1.4, 0, 1)).toBe(1);
  });

  it("pushes a value up to the floor", () => {
    expect(clamp(-3, 0, 1)).toBe(0);
  });
});
