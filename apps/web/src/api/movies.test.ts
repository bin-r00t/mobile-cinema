import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, buildMoviesQuery, listMovies } from "./movies";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildMoviesQuery", () => {
  it("leaves out empty values so the server applies its defaults", () => {
    expect(buildMoviesQuery({})).toBe("");
    expect(buildMoviesQuery({ q: "   " })).toBe("");
  });

  it("encodes the search and the sort", () => {
    expect(buildMoviesQuery({ q: "the matrix", sort: "year", order: "desc" })).toBe(
      "?q=the+matrix&sort=year&order=desc",
    );
  });

  it("encodes the page", () => {
    expect(buildMoviesQuery({ limit: 24, offset: 48 })).toBe("?limit=24&offset=48");
  });
});

describe("listMovies", () => {
  it("asks the api and returns the list", async () => {
    const body = { items: [], total: 0, limit: 24, offset: 0 };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listMovies({ limit: 24 })).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/movies?limit=24", expect.any(Object));
  });

  it("turns an error body into an ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "VALIDATION_ERROR", message: "bad sort" },
            }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );

    await expect(listMovies({ sort: "nope" as never })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(listMovies({ sort: "nope" as never })).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    });
  });

  it("reports a body that is not json as a plain http error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
    );

    await expect(listMovies()).rejects.toMatchObject({
      status: 500,
      code: "HTTP_ERROR",
    });
  });
});
