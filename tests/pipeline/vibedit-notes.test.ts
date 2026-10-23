import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addReviewNote, deleteReviewNote, listReviewNotes, updateReviewNote } from '../../src/pipeline/vibedit/review-notes.ts';
import { createMockSupabase } from '../helpers/mock-supabase.ts';

describe('Vibedit review notes', () => {
  it('pins notes in video order, ticks them off, rewords and deletes them, keeping the script', async () => {
    const { supabase, db } = createMockSupabase({ videos: [{ id: 'v-notes', script_json: { beats: [{ text: 'One.' }] } }] });
    await addReviewNote(supabase, 'v-notes', { atSec: 83.27, beat: 5, text: '  map too fast  ' });
    const notes = await addReviewNote(supabase, 'v-notes', { atSec: 12, beat: 1, text: 'wrong flag' });
    assert.deepEqual(notes.map((n) => [n.atSec, n.beat, n.text]), [[12, 1, 'wrong flag'], [83.3, 5, 'map too fast']]);
    assert.deepEqual(db.videos[0].script_json.beats, [{ text: 'One.' }]);

    const [first] = notes;
    await updateReviewNote(supabase, 'v-notes', first.id, { resolved: true, text: 'wrong flag (Italy)' });
    let now = await listReviewNotes(supabase, 'v-notes');
    assert.deepEqual([now[0].resolved, now[0].text], [true, 'wrong flag (Italy)']);

    now = await deleteReviewNote(supabase, 'v-notes', first.id);
    assert.equal(now.length, 1);

    await assert.rejects(addReviewNote(supabase, 'v-notes', { atSec: 1, beat: 0, text: '   ' }), /Write the note/);
    await assert.rejects(addReviewNote(supabase, 'v-notes', { atSec: -1, beat: 0, text: 'x' }), /Invalid moment/);
    await assert.rejects(updateReviewNote(supabase, 'v-notes', 'nope', { resolved: true }), /gone/);
  });
});
