import type { ResearchDossier } from './types';

/** The dossier section of the script-writing prompt. */
export function formatDossierForPrompt(dossier: ResearchDossier): string {
  return `RESEARCH DOSSIER (verified facts for this video):
${dossier.facts.map((f) => `${f.id}: ${f.claim}`).join('\n')}

Research rules:
- Every specific number, date, statistic, quote, or headline in the narration must come from a fact above. If the story needs a specific the dossier doesn't have, keep that line general instead of inventing it.
- Use the facts that serve the story; you don't need all of them. Don't distort a fact (e.g. a figure for one day must not become a figure for a week).
- In each beat, set "fact_ids" to the ids of the facts it uses ([] when the beat has no specifics).
- "newspaper" beats may only cite headlines that appear in the dossier.`;
}
