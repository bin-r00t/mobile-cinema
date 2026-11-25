/**
 * The choice of a playback source for a movie.
 *
 * The server answers a movie with the modes it can serve, but a browser
 * only plays some of them: the HLS playlist needs a player that speaks
 * HLS, and the progressive file needs a container the browser knows. The
 * shell of the theater page therefore asks this module which source to
 * try first, and falls back to the next one when the browser refuses it.
 */

/** One movie, as far as the playback is concerned. */
export interface PlaybackMovie {
  /** The id of the movie in the catalog. */
  id: number;
  /** The path of the progressive stream, or null when there is none. */
  streamUrl: string | null;
  /** The path of the HLS playlist, or null when there is none yet. */
  hlsUrl: string | null;
}

/** The source the player should try. */
export interface PlaybackSource {
  /** Which kind of source it is. */
  kind: "progressive" | "hls";
  /** The URL of the source. */
  url: string;
}

/**
 * The path of the master playlist of a movie.
 *
 * The playlist is only written into the cache once the transcode is done,
 * so the path is the same before and after: the server answers "not ready
 * yet" until it is.
 */
export function hlsPlaylistUrl(movieId: number): string {
  return `/api/hls/${movieId}/master.m3u8`;
}

/**
 * The source to try first.
 *
 * The progressive file comes first: a browser can play it without any
 * help, and it needs no transcode to be ready. A movie that has no
 * progressive stream at all is served through HLS.
 */
export function selectPlaybackSource(movie: PlaybackMovie): PlaybackSource | null {
  if (movie.streamUrl) {
    return { kind: "progressive", url: movie.streamUrl };
  }
  return { kind: "hls", url: movie.hlsUrl ?? hlsPlaylistUrl(movie.id) };
}
