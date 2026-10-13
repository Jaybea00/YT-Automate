export interface ResearchSource {
  /** Short id cited by facts, e.g. "S1". */
  id: string;
  title: string;
  url: string;
}

export interface ResearchFact {
  /** Short id cited by script beats, e.g. "F7". */
  id: string;
  claim: string;
  sourceIds: string[];
}

export interface ResearchDossier {
  topic: string;
  /** Where the sources came from. */
  provider: 'wikipedia' | 'google_search';
  createdAt: string;
  sources: ResearchSource[];
  facts: ResearchFact[];
}
