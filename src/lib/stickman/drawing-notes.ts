import { z } from 'zod';
import type { LLMProvider, ProviderCallContext } from '@/pipeline/providers/types';
import type { ResearchFact } from '@/lib/research/types';
import type { ScriptBeat } from '@/lib/script/generate-script';
import { drawingCode } from './drawing-codes';

/**
 * Labels and speech bubbles for stickman drawings. The AI reads the drawing brief and picks the few
 * places a name label with an arrow ("Royal Game of Ur") or a speech bubble (a character's quoted
 * words) helps; each is then checked: a label names something the narration or research names, a
 * bubble repeats the narration's own words. Shot boundaries and codes never change, so this runs
 * on a finished brief (and on videos whose drawings are already in).
 */

export const MAX_LABEL_WORDS = 5;
export const MAX_BUBBLE_WORDS = 12;
/** Labels stay occasional: at least this many drawings apart. */
export const MIN_DRAWINGS_BETWEEN_LABELS = 3;
/** Drawings sent to the model per call. */
const DRAWINGS_PER_CALL = 60;

const NotesSchema = z.object({
  notes: z.array(
    z.object({
      code: z.string(),
      label: z.object({ text: z.string(), target: z.string() }).nullable().optional(),
      bubble: z.object({ text: z.string(), speaker: z.string() }).nullable().optional(),
    }),
  ),
});

const SYSTEM = `You add labels and speech bubbles to the drawings of a stickman YouTube video. You see each drawing's code, the narration it plays under, and what the drawing shows.

- label = {text, target}: a short name label with an arrow, for a person, place, object or thing the narration names that viewers benefit from identifying (an artefact, a place, a historical figure, a tool). text: at most ${MAX_LABEL_WORDS} words, using the narration's own name for it (a date or number only if the narration or a research fact states it). target: what the arrow points at, described as it would look in the drawing ("the wooden board game", "the old man with the flute"). Never label the obvious (a fire, "you", a crowd). At most one label in every 4 drawings.
- bubble = {text, speaker}: a speech bubble, ONLY when the narration quotes a character's spoken words in that drawing. text: those words copied exactly from the narration, at most ${MAX_BUBBLE_WORDS} words. speaker: who says it, described as they look in the drawing.
- Most drawings get neither. Return only the drawings that get a label or a bubble.`;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * Keeps a label only if its words are named in the narration or research (whole words), and a
 * bubble only if it repeats words of the drawing's own narration. Returns the cleaned note.
 */
export function checkNote(
  note: { label?: { text: string; target: string } | null; bubble?: { text: string; speaker: string } | null },
  covers: string,
  ground: string,
): { label?: { text: string; target: string }; bubble?: { text: string; speaker: string } } {
  const out: { label?: { text: string; target: string }; bubble?: { text: string; speaker: string } } = {};
  const groundNorm = ` ${norm(ground)} `;
  const label = note.label;
  if (label?.text.trim() && label.target.trim() && wordCount(label.text) <= MAX_LABEL_WORDS && groundNorm.includes(` ${norm(label.text)} `)) {
    out.label = { text: label.text.trim(), target: label.target.trim() };
  }
  const bubble = note.bubble;
  const said = bubble?.text.trim().replace(/^["“'‘]+|["”'’]+$/g, '') ?? '';
  if (bubble && said && bubble.speaker.trim() && wordCount(said) <= MAX_BUBBLE_WORDS && ` ${norm(covers)} `.includes(` ${norm(said)} `)) {
    out.bubble = { text: said, speaker: bubble.speaker.trim() };
  }
  return out;
}

/** Drops labels closer than MIN_DRAWINGS_BETWEEN_LABELS drawings to the previous one. */
export function spaceLabels(beats: ScriptBeat[]): ScriptBeat[] {
  let since = Number.POSITIVE_INFINITY;
  return beats.map((beat) => ({
    ...beat,
    shots: beat.shots?.map((shot) => {
      if (shot.visual_type !== 'drawing' || !shot.drawing) return shot;
      if (shot.drawing.label && since < MIN_DRAWINGS_BETWEEN_LABELS) {
        since++;
        const { label: _dropped, ...drawing } = shot.drawing;
        void _dropped;
        return { ...shot, drawing };
      }
      since = shot.drawing.label ? 0 : since + 1;
      return shot;
    }),
  }));
}

/**
 * Adds labels and bubbles to a drawn plan (replacing any earlier ones). Never throws: if the model
 * can't be reached, the plan comes back without them.
 */
export async function planDrawingNotes(llm: LLMProvider, ctx: ProviderCallContext, beats: ScriptBeat[], facts: ResearchFact[] = []): Promise<ScriptBeat[]> {
  const drawings = beats.flatMap((b) =>
    (b.shots ?? []).flatMap((s, i) => (s.visual_type === 'drawing' && s.drawing ? [{ code: drawingCode(b.index, i), beat: b, shot: s, i }] : [])),
  );
  if (drawings.length === 0) return beats;
  const found = new Map<string, z.infer<typeof NotesSchema>['notes'][number]>();
  for (let start = 0; start < drawings.length; start += DRAWINGS_PER_CALL) {
    const batch = drawings.slice(start, start + DRAWINGS_PER_CALL);
    try {
      const { data } = await llm.generateJson(
        {
          system: SYSTEM,
          prompt: `${facts.length ? `RESEARCH FACTS:\n${facts.map((f) => `${f.id}: ${f.claim}`).join('\n')}\n\n` : ''}DRAWINGS:\n${batch
            .map((d) => `${d.code} | narration: "${d.shot.covers}" | drawing: ${d.shot.drawing!.scene}`)
            .join('\n')}\n\nReturn {"notes": [{"code", "label", "bubble"}]} for the drawings that get one.`,
          schema: NotesSchema,
        },
        ctx,
      );
      for (const n of data.notes) found.set(n.code.trim().toUpperCase(), n);
    } catch (err) {
      console.warn(`[DrawingNotes] Labels and bubbles unavailable for drawings from ${batch[0].code}: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    }
  }
  const factText = facts.map((f) => f.claim).join(' ');
  const noted = beats.map((beat) => ({
    ...beat,
    shots: beat.shots?.map((shot, i) => {
      if (shot.visual_type !== 'drawing' || !shot.drawing) return shot;
      const { label: _l, bubble: _b, ...drawing } = shot.drawing;
      void _l;
      void _b;
      const raw = found.get(drawingCode(beat.index, i));
      const note = raw ? checkNote(raw, shot.covers, `${beat.text} ${factText}`) : {};
      return { ...shot, drawing: { ...drawing, ...note } };
    }),
  }));
  return spaceLabels(noted);
}
