import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { serverErrorHandler } from "./app.ts";

/** A log that keeps every line, so a test can look into it. */
function captureLog(): { lines: string[]; stream: NodeJS.WritableStream } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  }) as NodeJS.WritableStream;
  return { lines, stream };
}

describe("the error handler of the server", () => {
  it("answers an unexpected error without its message and logs the detail", async () => {
    const { lines, stream } = captureLog();
    const app = Fastify({ logger: { level: "error", stream } });
    app.setErrorHandler(serverErrorHandler);
    app.get("/api/boom", async () => {
      throw new Error("failed to read /srv/movies/the-secret-file.mkv");
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/boom" });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    // Nothing of the machine and nothing of the error goes out.
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("/srv");
    expect(body.error.message).not.toContain("failed to read");

    // The detail of the failure is in the log of the operator.
    const logged = lines.join("\n");
    expect(logged).toContain("/srv/movies/the-secret-file.mkv");
    expect(logged).toContain("failed to read");

    await app.close();
  });

  it("keeps the status of an error the framework made, with a fixed message", async () => {
    const app = Fastify({ logger: { level: "silent" } });
    app.setErrorHandler(serverErrorHandler);
    app.post("/api/echo", async (request) => request.body);
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/echo",
      payload: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; message: string } };
    // The code of the refusal survives, the message of the parser does not.
    expect(body.error.code).toContain("FST_ERR");
    expect(body.error.message).toBe("The request could not be answered.");
    expect(body.error.message).not.toContain("{not json");

    await app.close();
  });
});
