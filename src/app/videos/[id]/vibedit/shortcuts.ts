import { useCallback, useEffect, useRef } from 'react';

/** Vibedit's keyboard shortcuts, for the help overlay and the key handler. */
export const SHORTCUTS: Array<{ keys: string; does: string }> = [
  { keys: 'Space / K', does: 'Play or pause' },
  { keys: '← / →', does: 'Previous / next beat' },
  { keys: 'Home / End', does: 'First / last beat' },
  { keys: 'J / L', does: 'Back / forward 5 seconds' },
  { keys: ', / .', does: 'One frame back / forward (pauses)' },
  { keys: 'M', does: 'Switch between the master video and the beat on its own' },
  { keys: '?', does: 'Show or hide these shortcuts' },
];

export type ShortcutAction =
  | 'toggle_play'
  | 'prev_beat'
  | 'next_beat'
  | 'first_beat'
  | 'last_beat'
  | 'back_5'
  | 'forward_5'
  | 'frame_back'
  | 'frame_forward'
  | 'toggle_mode'
  | 'help';

/** The action for a key press, or null (typing in a field, or a key with Ctrl/Alt/Cmd, does nothing). */
export function shortcutFor(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; target?: unknown }): ShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(String(t.tagName).toUpperCase()))) return null;
  switch (e.key) {
    case ' ':
    case 'k':
    case 'K':
      return 'toggle_play';
    case 'ArrowLeft':
      return 'prev_beat';
    case 'ArrowRight':
      return 'next_beat';
    case 'Home':
      return 'first_beat';
    case 'End':
      return 'last_beat';
    case 'j':
    case 'J':
      return 'back_5';
    case 'l':
    case 'L':
      return 'forward_5';
    case ',':
      return 'frame_back';
    case '.':
      return 'frame_forward';
    case 'm':
    case 'M':
      return 'toggle_mode';
    case '?':
      return 'help';
    default:
      return null;
  }
}

const FRAME_SEC = 1 / 30;

/**
 * Wires the shortcuts to the page. The handlers are read through a ref, so the listener is added
 * once and always sees the page's latest state.
 */
export function useVibeditShortcuts(handlers: {
  video: () => HTMLVideoElement | null;
  beatCount: number;
  activeBeat: number;
  jumpToBeat: (index: number) => void;
  toggleMode: () => void;
  toggleHelp: () => void;
}) {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e);
      if (!action) return;
      const h = latest.current;
      const v = h.video();
      const seek = (by: number) => {
        if (v) v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + by));
      };
      e.preventDefault();
      switch (action) {
        case 'toggle_play':
          if (v?.paused) v.play().catch(() => {});
          else v?.pause();
          break;
        case 'prev_beat':
          h.jumpToBeat(Math.max(0, h.activeBeat - 1));
          break;
        case 'next_beat':
          h.jumpToBeat(Math.min(h.beatCount - 1, h.activeBeat + 1));
          break;
        case 'first_beat':
          h.jumpToBeat(0);
          break;
        case 'last_beat':
          h.jumpToBeat(Math.max(0, h.beatCount - 1));
          break;
        case 'back_5':
          seek(-5);
          break;
        case 'forward_5':
          seek(5);
          break;
        case 'frame_back':
        case 'frame_forward':
          v?.pause();
          seek(action === 'frame_back' ? -FRAME_SEC : FRAME_SEC);
          break;
        case 'toggle_mode':
          h.toggleMode();
          break;
        case 'help':
          h.toggleHelp();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** A callback whose identity never changes but always runs the latest version (for effects). */
export function useStableCallback(fn: () => void): () => void {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  return useCallback(() => latest.current(), []);
}
