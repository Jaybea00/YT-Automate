import type { RecipeId } from './types';

/**
 * Clip recipes: the kinds of moment the hunter looks for. Each has what chat tends to type and what
 * the streamer tends to say when it happens. They only point the hunter at stretches worth a look;
 * the judge (judge.ts) decides what each stretch really is.
 */
export interface Recipe {
  id: RecipeId;
  label: string;
  emoji: string;
  chat: RegExp;
  speech: RegExp;
}

export const RECIPES: Recipe[] = [
  {
    id: 'funny',
    label: 'Funny',
    emoji: '😂',
    chat: /\b(lul|lol+|lmao+|lmfao|kekw|omegalul|icant|xd+|ha(ha)+|dead|crying)\b|💀|😂|🤣|😭/i,
    speech: /\b(ha(ha)+|i can'?t|bro what|i'?m dead|crying)\b/i,
  },
  {
    id: 'chase',
    label: 'Chase',
    emoji: '🚓',
    chat: /\b(cops?|police|chase|wanted|stars?|run+|drive|getaway)\b|🚓|🚨/i,
    speech: /\b(cops?|police|chase|stars?|run|go go|drive|lose them|getaway)\b/i,
  },
  {
    id: 'crash',
    label: 'Crash / chaos',
    emoji: '💥',
    chat: /\b(crash(ed)?|rip|oof|wreck(ed)?|bruh|flip(ped)?|boom|explo(de|sion))\b|💥/i,
    speech: /\b(crash|oh no+|no+o+|wreck|flip|explo(de|sion)|boom)\b/i,
  },
  {
    id: 'clutch',
    label: 'Clutch / win',
    emoji: '🔥',
    chat: /\b(pog(gers|champ)?|w+|clutch|insane|goat(ed)?|let'?s go+|cracked|clean)\b|🔥|🐐/i,
    speech: /\b(let'?s go+|yes+|clutch|insane|no way|we did it|easy)\b/i,
  },
  {
    id: 'rage',
    label: 'Rage / fail',
    emoji: '😤',
    chat: /\b(l+|ff|copium|tilted|mad|rage|unlucky|fail)\b|😤|🤬/i,
    speech: /\b(fuck|shit|are you serious|what the hell|come on|why+|i hate)\b/i,
  },
  {
    id: 'glitch',
    label: 'Glitch',
    emoji: '👾',
    chat: /\?{2,}|\b(glitch(ed)?|bug(ged)?|wtf|huh|how)\b/i,
    speech: /\b(glitch|bug|what is happening|how did|that'?s not supposed)\b/i,
  },
];

/** "Clip it!" in chat: a strong sign of a moment, whatever kind it is. */
export const CLIP_CALL = /\bclip(ped| it| that|\b)/i;

export const recipeById = (id: string) => RECIPES.find((r) => r.id === id);

export const RECIPE_IDS: RecipeId[] = [...RECIPES.map((r) => r.id), 'other'];

/** Which recipe the words fit best (chat counts for more than speech); 'other' when none. */
export function guessRecipe(chat: string[], speech: string[]): RecipeId {
  let best: RecipeId = 'other';
  let bestHits = 0;
  for (const r of RECIPES) {
    const hits = chat.filter((m) => r.chat.test(m)).length * 2 + speech.filter((s) => r.speech.test(s)).length;
    if (hits > bestHits) {
      best = r.id;
      bestHits = hits;
    }
  }
  return best;
}

/** How many messages look like a reaction of any kind (for scoring a stretch). */
export function reactionHits(chat: string[]): number {
  return chat.filter((m) => CLIP_CALL.test(m) || RECIPES.some((r) => r.chat.test(m))).length;
}
