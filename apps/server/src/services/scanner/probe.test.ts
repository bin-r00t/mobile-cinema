import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { probeMediaFile } from "./probe.ts";

const execFileAsync = promisify(execFile);

async function binaryExists(name: string): Promise<boolean> {
  try {
    await execFileAsync(name, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

const hasFfmpeg = await binaryExists("ffmpeg");
const hasFfprobe = await binaryExists("ffprobe");

let dir: string;
let realVideo: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mc-probe-test-"));
  if (hasFfmpeg) {
    realVideo = join(dir, "real.mp4");
    await execFileAsync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=1:size=320x240:rate=10",
      "-c:v",
      "mpeg4",
      "-metadata",
      "title=Probe Test Movie",
      "-metadata",
      "comment=A generated file.",
      realVideo,
    ]);
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

it.skipIf(!hasFfmpeg || !hasFfprobe)(
  "returns duration, resolution, codec, container and tags for a real file",
  async () => {
    const result = await probeMediaFile(realVideo);
    expect(result.warnings).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(900);
    expect(result.durationMs).toBeLessThanOrEqual(1100);
    expect(result.width).toBe(320);
    expect(result.height).toBe(240);
    expect(result.videoCodec).toBe("mpeg4");
    expect(result.container).toContain("mp4");
    expect(result.tagTitle).toBe("Probe Test Movie");
    expect(result.tagPlot).toBe("A generated file.");
  },
);

it("degrades gracefully when ffprobe is missing", async () => {
  const result = await probeMediaFile("/anywhere/movie.mkv", {
    ffprobePath: join(tmpdir(), "no-such-ffprobe"),
  });
  expect(result).toMatchObject({
    durationMs: null,
    width: null,
    height: null,
    videoCodec: null,
    container: null,
    tagTitle: null,
    tagPlot: null,
  });
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toMatch(/ffprobe not found/);
});

it.skipIf(!hasFfprobe)(
  "degrades gracefully for an unreadable file",
  async () => {
    const bogus = join(dir, "not-a-video.mkv");
    await writeFile(bogus, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const result = await probeMediaFile(bogus);
    expect(result.durationMs).toBeNull();
    expect(result.width).toBeNull();
    expect(result.videoCodec).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/ffprobe failed/);
  },
);
