/**
 * The movie list of the library, as the server delivers it.
 *
 * The server owns the searching and the sorting (see apps/server/src/routes/
 * movies.ts); the browser only asks for a page of the list and renders what
 * comes back. Every call goes to a relative "/api" URL, so the same code
 * works behind the vite proxy in development and behind the reverse proxy in
 * a deployment.
 */

/** One movie of the list. */
export interface MovieListItem {
  id: number;
  title: string;
  year: number | null;
  description: string | null;
  durationMs: number | null;
  posterUrl: string | null;
  addedAt: string;
}

/** A page of the list, plus the total the server knows about. */
export interface MovieList {
  items: MovieListItem[];
  total: number;
  limit: number;
  offset: number;
}

/** The fields the list can be sorted by. */
export type SortKey = "title" | "year" | "added";

/** The direction of the sort. */
export type SortOrder = "asc" | "desc";

export interface ListMoviesParams {
  /** Free text that is matched against the title. */
  q?: string;
  sort?: SortKey;
  order?: SortOrder;
  limit?: number;
  offset?: number;
  /** Aborts the request when the search changes again. */
  signal?: AbortSignal;
}

/** An error the API reported, with the code it came with. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * The shape of the error body the server sends. The message is optional:
 * a proxy or a crash can answer with something else entirely.
 */
function isErrorBody(
  value: unknown,
): value is { error: { code: string; message: string } } {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === "string" && typeof message === "string";
}

/**
 * Reads the error body of a failed response. A body that is not JSON does not
 * hide the failure: the status is turned into a message of its own.
 */
async function readError(response: Response): Promise<ApiError> {
  try {
    const body: unknown = await response.json();
    if (isErrorBody(body)) {
      return new ApiError(response.status, body.error.code, body.error.message);
    }
  } catch {
    // Not JSON — fall through to the status message below.
  }
  return new ApiError(
    response.status,
    "HTTP_ERROR",
    `The server answered ${response.status}`,
  );
}

/**
 * Builds the query string of a list request. Empty values are left out, so
 * the server applies its own defaults.
 */
export function buildMoviesQuery(params: ListMoviesParams): string {
  const query = new URLSearchParams();
  const q = params.q?.trim();
  if (q) query.set("q", q);
  if (params.sort) query.set("sort", params.sort);
  if (params.order) query.set("order", params.order);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.offset !== undefined) query.set("offset", String(params.offset));
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

/**
 * Fetches a page of the movie list.
 *
 * A request that was aborted is not an error the caller has to handle — it
 * only means the search changed while the request was on its way — so the
 * abort error is passed on untouched and the caller can ignore it.
 */
export async function listMovies(params: ListMoviesParams = {}): Promise<MovieList> {
  const response = await fetch(`/api/movies${buildMoviesQuery(params)}`, {
    signal: params.signal,
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as MovieList;
}
