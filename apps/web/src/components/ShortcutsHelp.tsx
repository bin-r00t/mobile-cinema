/**
 * The keys and the gestures of the player, written down on one card.
 */

export interface ShortcutsHelpProps {
  /** True while the card is on the screen. */
  open: boolean;
  /** Closes the card. */
  onClose: () => void;
}

/** One row of the card: what to do on the left, what it does on the right. */
function Shortcut({ action, keys }: { action: string; keys: string }) {
  return (
    <div className="player-help-row">
      <dt>{action}</dt>
      <dd>{keys}</dd>
    </div>
  );
}

export function ShortcutsHelp({ open, onClose }: ShortcutsHelpProps) {
  if (!open) return null;

  return (
    <div className="player-help" role="dialog" aria-label="Shortcuts of the player">
      <div className="player-help-card">
        <h2 className="player-help-title">Shortcuts</h2>
        <button
          type="button"
          className="player-button player-help-close"
          onClick={onClose}
          aria-label="Close the shortcuts"
        >
          ✕
        </button>

        <dl className="player-help-list">
          <Shortcut action="Play or pause" keys="Space" />
          <Shortcut action="Seek 10 s" keys="← / →" />
          <Shortcut action="Volume" keys="↑ / ↓" />
          <Shortcut action="Mute" keys="M" />
          <Shortcut action="Fullscreen" keys="F" />
          <Shortcut action="Leave the theater" keys="Esc" />
          <Shortcut action="Seek by swiping" keys="Swipe ← / →" />
          <Shortcut action="Volume by swiping" keys="Swipe ↑ / ↓" />
        </dl>
      </div>
    </div>
  );
}
