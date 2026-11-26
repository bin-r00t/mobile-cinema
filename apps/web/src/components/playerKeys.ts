/**
 * The keys of the player: which key asks the player for what while a movie
 * is on the screen.
 */

/** What the player does when a key asks it to. */
export type PlayerKeyAction =
  | { kind: "toggle-play" }
  | { kind: "seek"; seconds: number }
  | { kind: "volume"; delta: number }
  | { kind: "toggle-mute" }
  | { kind: "toggle-fullscreen" }
  | { kind: "exit" };

/** How far the left and right arrows jump through the movie, in seconds. */
export const SEEK_STEP_SECONDS = 10;

/** How much the up and down arrows turn the volume, between 0 and 1. */
export const VOLUME_STEP = 0.05;

/**
 * Reads what a key press asks the player for.
 *
 * A chord that the browser or the page itself owns (control, meta, alt) is
 * left alone, and a key the player knows nothing about answers null.
 */
export function playerKeyAction(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): PlayerKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  switch (event.key) {
    case " ":
      return { kind: "toggle-play" };
    case "ArrowLeft":
      return { kind: "seek", seconds: -SEEK_STEP_SECONDS };
    case "ArrowRight":
      return { kind: "seek", seconds: SEEK_STEP_SECONDS };
    case "ArrowUp":
      return { kind: "volume", delta: VOLUME_STEP };
    case "ArrowDown":
      return { kind: "volume", delta: -VOLUME_STEP };
    case "m":
    case "M":
      return { kind: "toggle-mute" };
    case "f":
    case "F":
      return { kind: "toggle-fullscreen" };
    case "Escape":
      return { kind: "exit" };
    default:
      return null;
  }
}
