import { describe, expect, it } from "vitest";

import { playerKeyAction, SEEK_STEP_SECONDS, VOLUME_STEP } from "./playerKeys";

describe("playerKeyAction", () => {
  it("plays or pauses on the space bar", () => {
    expect(playerKeyAction({ key: " " })).toEqual({ kind: "toggle-play" });
  });

  it("seeks back and forth on the arrow keys", () => {
    expect(playerKeyAction({ key: "ArrowLeft" })).toEqual({
      kind: "seek",
      seconds: -SEEK_STEP_SECONDS,
    });
    expect(playerKeyAction({ key: "ArrowRight" })).toEqual({
      kind: "seek",
      seconds: SEEK_STEP_SECONDS,
    });
  });

  it("turns the volume up and down on the arrow keys", () => {
    expect(playerKeyAction({ key: "ArrowUp" })).toEqual({
      kind: "volume",
      delta: VOLUME_STEP,
    });
    expect(playerKeyAction({ key: "ArrowDown" })).toEqual({
      kind: "volume",
      delta: -VOLUME_STEP,
    });
  });

  it("mutes on the m key, whatever its case", () => {
    expect(playerKeyAction({ key: "m" })).toEqual({ kind: "toggle-mute" });
    expect(playerKeyAction({ key: "M" })).toEqual({ kind: "toggle-mute" });
  });

  it("goes fullscreen on the f key, whatever its case", () => {
    expect(playerKeyAction({ key: "f" })).toEqual({ kind: "toggle-fullscreen" });
    expect(playerKeyAction({ key: "F" })).toEqual({ kind: "toggle-fullscreen" });
  });

  it("leaves the theater on the escape key", () => {
    expect(playerKeyAction({ key: "Escape" })).toEqual({ kind: "exit" });
  });

  it("answers null for a key the player does not know", () => {
    expect(playerKeyAction({ key: "a" })).toBeNull();
    expect(playerKeyAction({ key: "Enter" })).toBeNull();
  });

  it("leaves the chords of the browser and the page alone", () => {
    expect(playerKeyAction({ key: "f", ctrlKey: true })).toBeNull();
    expect(playerKeyAction({ key: "ArrowLeft", metaKey: true })).toBeNull();
    expect(playerKeyAction({ key: "m", altKey: true })).toBeNull();
  });
});
