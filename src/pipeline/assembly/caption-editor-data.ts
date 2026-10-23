import type { SupabaseClient } from '@supabase/supabase-js';
import { readTimeline } from '../utils/timeline';
import { loadCaptionWords } from './caption-sources';
import { baseCaptionWords, editMatches, isEmptyEdit, normalizeCaptionEdit, type CaptionEdit, type CaptionEdits } from './caption-edits';

export interface CaptionEditorBeat {
  index: number;
  text: string;
  /** The caption words, as the render will see them (the edit's positions refer to these). */
  words: string[];
  /** Timed from the narrator's voice, or spread evenly (not voiced, or voiced before the text changed). */
  timed: boolean;
  edit: CaptionEdit | null;
  /** An edit made for words the beat no longer has (re-voiced or rewritten): not applied. */
  stale: boolean;
}

/** Every beat's caption words and edit, for the caption editor. */
export async function captionEditorBeats(supabase: SupabaseClient, videoId: string): Promise<CaptionEditorBeat[]> {
  const { data: video } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  if (!video) throw new Error('Video not found');
  const sj = (video.script_json ?? {}) as { beats?: Array<{ text?: string }>; caption_edits?: CaptionEdits };
  const beats = (sj.beats ?? []).map((b, index) => ({ index, text: String(b.text ?? '') }));
  // The voice files the render will use: from the last render's timeline, or (not rendered yet)
  // the latest voicing of each beat, so the editor sees the same timed words as the render
  const timeline = readTimeline(video.script_json);
  const audio = new Map<number, string | null>((timeline?.beats ?? []).map((b) => [b.index, b.audioPath]));
  if (audio.size < beats.length) {
    const { data: jobs } = await supabase.from('yt_jobs').select('id, created_at').eq('video_id', videoId).order('created_at', { ascending: false });
    for (const job of jobs ?? []) {
      const { data: units } = await supabase
        .from('yt_job_units')
        .select('unit_index, output_path')
        .eq('job_id', job.id)
        .eq('stage', 'tts')
        .eq('status', 'done');
      for (const u of units ?? []) if (!audio.has(u.unit_index) && u.output_path) audio.set(u.unit_index, u.output_path);
      if (audio.size >= beats.length) break;
    }
  }
  const timings = await loadCaptionWords(beats.map((b) => ({ ...b, audioPath: audio.get(b.index) ?? null })));
  return beats.map((b) => {
    const words = baseCaptionWords(b.text, timings[b.index], 1);
    const edit = sj.caption_edits?.[b.index] ?? null;
    return {
      index: b.index,
      text: b.text,
      words: words.map((w) => w.word),
      timed: Boolean(timings[b.index]?.length),
      edit,
      stale: Boolean(edit) && !editMatches(edit!, words),
    };
  });
}

/** Saves (or with null, removes) one beat's caption edit. The edit must match the beat's words now. */
export async function saveCaptionEdit(supabase: SupabaseClient, videoId: string, beatIndex: number, raw: unknown): Promise<CaptionEditorBeat> {
  const beats = await captionEditorBeats(supabase, videoId);
  const beat = beats[beatIndex];
  if (!beat) throw new Error(`Beat ${beatIndex + 1} does not exist`);
  const edit = raw === null ? null : normalizeCaptionEdit(raw);
  if (raw !== null && !edit) throw new Error('Invalid caption edit');
  if (edit && (edit.basis.length !== beat.words.length || edit.basis.some((w, i) => w !== beat.words[i]))) {
    throw new Error("This beat's words changed (re-voiced or edited); reload the caption editor");
  }
  const { data: video } = await supabase.from('videos').select('script_json').eq('id', videoId).maybeSingle();
  const sj = (video?.script_json ?? {}) as Record<string, unknown> & { caption_edits?: CaptionEdits };
  const edits: CaptionEdits = { ...(sj.caption_edits ?? {}) };
  if (!edit || isEmptyEdit(edit)) delete edits[beatIndex];
  else edits[beatIndex] = edit;
  await supabase.from('videos').update({ script_json: { ...sj, caption_edits: edits } }).eq('id', videoId);
  return { ...beat, edit: edits[beatIndex] ?? null, stale: false };
}
