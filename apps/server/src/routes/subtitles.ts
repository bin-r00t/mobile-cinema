/**
 * The subtitles of a movie: the WebVTT the player plays, and the script it
 * shows in a tab.
 *
 * The player hands the WebVTT to the browser, so it has to be a file the
 * browser accepts — every subtitle is converted before it is served, even
 * the ones the scan already converted. The script is the same subtitle
 * without its timings, which is what a reader wants to read.
 *
 * Both routes answer in the language that is asked for. A movie that has
 * no subtitle in that language falls back to the track the player would
 * use by default, so the answer is never empty while the movie has
 * subtitles at all.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { asc, eq } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { mediaItems, subtitleTracks } from "../db/schema.ts";
import { normalizeLanguage } from "../services/scanner/subtitles.ts";
import {
  loadTrackVtt,
  SubtitleUnavailableError,
  vttToText,
  type SubtitleTrackRow,
  type SubtitleUnavailableCode,
} from "../services/subtitles/reader.ts";

export interface SubtitleRouteOptions {
  /** The catalog the movies and their subtitles come from. */
  db: Db;
  /** The directory that holds the movies. */
  movieRoot: string;
  /** The directory that holds the converted subtitles. */
  cacheDir: string;
}

/** The content type a WebVTT file is served with. */
const VTT_CONTENT_TYPE = "text/vtt; charset=utf-8";

function error(code: string, message: string) {
  return { error: { code, message } };
}

/**
 * The message of a refusal of the reader.
 *
 * The refusal of the reader carries the path of the subtitle file, and a
 * path is the layout of the machine: it never goes into an answer. The
 * detail stays in the log of the server.
 */
const SUBTITLE_MESSAGES: Readonly<Record<SubtitleUnavailableCode, string>> = {
  SUBTITLE_NOT_FOUND: "The subtitle is gone.",
  SUBTITLE_BROKEN: "The subtitle holds nothing that can be played.",
};

/**
 * The answer of a subtitle that cannot be served.
 *
 * The refusal is written down in the log of the server, with the id of the
 * track, the id of the movie and the file it was about, and the client is
 * answered with a message that says nothing about the machine.
 */
function unavailableAnswer(
  app: FastifyInstance,
  reply: FastifyReply,
  failure: SubtitleUnavailableError,
  track: SubtitleTrackRow,
  mediaItemId: number,
): unknown {
  app.log.warn(
    { err: failure, trackId: track.id, mediaItemId, path: track.path },
    "a subtitle could not be served",
  );
  return reply.status(404).send(error(failure.code, SUBTITLE_MESSAGES[failure.code]));
}

/**
 * The track of a movie that holds a given language.
 *
 * The languages are compared in their normalized form, so "eng", "en" and
 * "EN" all mean the same track. A track that names no language at all
 * never matches a request.
 */
function findByLanguage(
  tracks: readonly SubtitleTrackRow[],
  language: string,
): SubtitleTrackRow | undefined {
  const wanted = normalizeLanguage(language);
  if (wanted === null) return undefined;

  return tracks.find((track) => {
    if (track.language === null) return false;
    return normalizeLanguage(track.language) === wanted;
  });
}

/**
 * The track the player uses by default: the one the scan marked as primary,
 * and the first one when nothing was marked.
 */
function findPrimary(
  tracks: readonly SubtitleTrackRow[],
): SubtitleTrackRow | undefined {
  return tracks.find((track) => track.isPrimary) ?? tracks[0];
}

export async function subtitleRoutes(
  app: FastifyInstance,
  opts: SubtitleRouteOptions,
): Promise<void> {
  const { db, movieRoot, cacheDir } = opts;

  /**
   * The WebVTT of a subtitle track. The player puts this URL in the
   * `src` of a `<track>` element.
   */
  app.get<{ Params: { id: string } }>(
    "/api/subtitles/:id.vtt",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply
          .status(400)
          .send(error("INVALID_ID", `${request.params.id} is not a subtitle id`));
      }

      const track = db
        .select()
        .from(subtitleTracks)
        .where(eq(subtitleTracks.id, id))
        .get();

      if (!track) {
        return reply
          .status(404)
          .send(
            error("SUBTITLE_NOT_FOUND", `The catalog has no subtitle with id ${id}`),
          );
      }

      let vtt: string;
      try {
        vtt = await loadTrackVtt(track, { movieRoot, cacheDir });
      } catch (err) {
        if (err instanceof SubtitleUnavailableError) {
          return unavailableAnswer(app, reply, err, track, track.mediaItemId);
        }
        throw err;
      }

      return reply
        .header("content-type", VTT_CONTENT_TYPE)
        .header("cache-control", "public, max-age=3600")
        .send(vtt);
    },
  );

  /**
   * The script of a movie: the text of its subtitle, without the timings.
   *
   * The `lang` parameter picks the language; when the movie has no
   * subtitle in that language the default track is used instead.
   */
  app.get<{ Params: { id: string }; Querystring: { lang?: string } }>(
    "/api/movies/:id/script",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply
          .status(400)
          .send(error("INVALID_ID", `${request.params.id} is not a movie id`));
      }

      const movie = db
        .select({ id: mediaItems.id, title: mediaItems.title })
        .from(mediaItems)
        .where(eq(mediaItems.id, id))
        .get();

      if (!movie) {
        return reply
          .status(404)
          .send(error("MOVIE_NOT_FOUND", `The catalog has no movie with id ${id}`));
      }

      const tracks = db
        .select()
        .from(subtitleTracks)
        .where(eq(subtitleTracks.mediaItemId, id))
        .orderBy(asc(subtitleTracks.id))
        .all();

      if (tracks.length === 0) {
        return reply
          .status(404)
          .send(error("NO_SUBTITLES", `The movie ${id} has no subtitles`));
      }

      const requested = request.query.lang?.trim();
      const wanted = requested ? findByLanguage(tracks, requested) : undefined;
      const track = wanted ?? findPrimary(tracks)!;

      let vtt: string;
      try {
        vtt = await loadTrackVtt(track, { movieRoot, cacheDir });
      } catch (err) {
        if (err instanceof SubtitleUnavailableError) {
          return unavailableAnswer(app, reply, err, track, id);
        }
        throw err;
      }

      return reply.send({
        movieId: movie.id,
        trackId: track.id,
        language: track.language,
        isPrimary: track.isPrimary,
        // True when the language that was asked for was not there and the
        // default track was used instead.
        fallback: requested !== undefined && wanted === undefined,
        text: vttToText(vtt),
      });
    },
  );
}
