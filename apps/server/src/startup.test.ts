import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";

/** The server directory: the package that holds `src/index.ts`. */
const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let workDir = "";

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Asks the operating system for a port nobody is listening on. */
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

/**
 * The server must start the way `npm run dev` starts it: plain node, with
 * the TypeScript files as they are. Node can only strip the types away, so
 * the sources must not use a construct that needs a compiler.
 */
it("the server starts under plain node", async () => {
  workDir = await mkdtemp(join(tmpdir(), "mobile-cinema-startup-"));
  const movieRoot = join(workDir, "movies");
  await mkdir(movieRoot, { recursive: true });
  const port = await freePort();

  const child = spawn(process.execPath, ["src/index.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      MOVIE_ROOT: movieRoot,
      DB_PATH: join(workDir, "catalog.sqlite"),
      CACHE_DIR: join(workDir, "cache"),
      LOG_LEVEL: "silent",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  try {
    let answered = false;
    for (let attempt = 0; attempt < 200 && !answered; attempt++) {
      if (child.exitCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        answered = res.status === 200;
      } catch {
        // The server is not listening yet.
      }
      if (!answered) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
    }

    expect(child.exitCode, `the server died:\n${stderr}`).toBeNull();
    expect(stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(answered, `the server did not answer:\n${stderr}`).toBe(true);
  } finally {
    child.kill("SIGTERM");
  }
}, 30000);
