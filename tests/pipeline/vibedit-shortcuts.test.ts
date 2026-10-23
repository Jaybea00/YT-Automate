import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SHORTCUTS, shortcutFor } from '../../src/app/videos/[id]/vibedit/shortcuts.ts';

describe('Vibedit keyboard shortcuts', () => {
  it('maps keys to actions', () => {
    assert.equal(shortcutFor({ key: ' ' }), 'toggle_play');
    assert.equal(shortcutFor({ key: 'K' }), 'toggle_play');
    assert.equal(shortcutFor({ key: 'ArrowRight' }), 'next_beat');
    assert.equal(shortcutFor({ key: 'j' }), 'back_5');
    assert.equal(shortcutFor({ key: '.' }), 'frame_forward');
    assert.equal(shortcutFor({ key: 'm' }), 'toggle_mode');
    assert.equal(shortcutFor({ key: 'x' }), null);
  });

  it('stays out of the way while typing or with modifier keys', () => {
    assert.equal(shortcutFor({ key: ' ', target: { tagName: 'INPUT' } }), null);
    assert.equal(shortcutFor({ key: 'k', target: { tagName: 'textarea' } }), null);
    assert.equal(shortcutFor({ key: 'm', target: { tagName: 'DIV', isContentEditable: true } }), null);
    assert.equal(shortcutFor({ key: 'l', ctrlKey: true }), null, 'Ctrl+L stays the browser address bar');
    assert.equal(shortcutFor({ key: 'ArrowLeft', target: { tagName: 'BUTTON' } }), 'prev_beat');
  });

  it('lists every key it handles in the help', () => {
    assert.equal(SHORTCUTS.length, 7);
  });
});
