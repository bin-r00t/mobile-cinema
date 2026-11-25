import { describe, expect, it } from "vitest";

import { hlsPlaylistUrl, selectPlaybackSource } from "./playback";

describe("hlsPlaylistUrl", () => {
  it("points at the master playlist of the movie", () => {
    expect(hlsPlaylistUrl(7)).toBe("/api/hls/7/master.m3u8");
  });
});

describe("selectPlaybackSource", () => {
  it("takes the progressive stream when there is one", () => {
    expect(
      selectPlaybackSource({
        id: 3,
        streamUrl: "/api/stream/3",
        hlsUrl: "/api/hls/3/master.m3u8",
      }),
    ).toEqual({ kind: "progressive", url: "/api/stream/3" });
  });

  it("falls back to the playlist when the movie has no progressive stream", () => {
    expect(
      selectPlaybackSource({
        id: 4,
        streamUrl: null,
        hlsUrl: "/api/hls/4/master.m3u8",
      }),
    ).toEqual({ kind: "hls", url: "/api/hls/4/master.m3u8" });
  });

  it("builds the playlist path when the server has not written it yet", () => {
    expect(selectPlaybackSource({ id: 5, streamUrl: null, hlsUrl: null })).toEqual({
      kind: "hls",
      url: "/api/hls/5/master.m3u8",
    });
  });
});
