import type { ScriptBeat } from './generate-script';

/** Fact-check issue types and helpers, safe to use in the browser. */

export const FACT_CHECK_KINDS = ['contradicts', 'distorted', 'unsupported', 'living_person'] as const;
export type FactCheckKind = (typeof FACT_CHECK_KINDS)[number];

export const FACT_CHECK_LABEL: Record<FactCheckKind, string> = {
  contradicts: 'Contradicts the sources',
  distorted: 'Detail differs from the source',
  unsupported: 'No source for this',
  living_person: 'Living person',
};

export interface FactCheckIssue {
  id: string;
  beat_index: number;
  kind: FactCheckKind;
  /** The words in the beat the issue is about. */
  claim: string;
  problem: string;
  /** The whole beat, rewritten to fix the issue. */
  suggested_text?: string;
  /** For living_person issues: who. */
  person?: string;
  /** The beat's text when checked; an edited beat's issue may no longer apply. */
  checked_text: string;
  dismissed?: boolean;
}

export interface FactCheckReport {
  checkedAt: string;
  model?: string;
  beatsChecked: number;
  /** False when the script had no research, so only general knowledge and living people were checked. */
  hadResearch: boolean;
  issues: FactCheckIssue[];
}

/** Issues still worth showing: not dismissed, and the beat hasn't been edited since. */
export function openIssues<T extends { beat_index: number; checked_text: string; dismissed?: boolean } = FactCheckIssue>(
  report: { issues: T[] } | undefined | null,
  beats: Pick<ScriptBeat, 'index' | 'text'>[],
): T[] {
  if (!report) return [];
  const text = new Map(beats.map((b) => [b.index, b.text]));
  return report.issues.filter((i) => !i.dismissed && text.get(i.beat_index) === i.checked_text);
}
