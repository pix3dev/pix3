/**
 * Who answers an `ask_user` question when nobody is at the keyboard (autopilot plan §4).
 *
 * Pure and cheap by design: the two steps implemented here cost zero model hops, and the two that
 * cost something are deliberately NOT here. Step 3 (the advisor) is one stateless model call the
 * caller makes and hands back in {@link AutopilotRouterInput.advisorChoice}; step 4 (the agent
 * answers its own question and carries on) is not an answer at all — it is the absence of one, and
 * it is what this function returning `null` means to `AgentChatService`.
 *
 * There is deliberately no "just take the first option" fallback: the order of options is whatever
 * the model happened to write them in, so picking by position is guessing while looking decisive.
 */

import {
  sameQuestion,
  type DecisionEntry,
  type DecisionSource,
} from '@/services/flow/decision-log';

export interface AutopilotRouterInput {
  /** The fork, as the agent put it. */
  readonly question: string;
  /** The options the agent offered. Empty means it wants prose — nothing here can supply that. */
  readonly options: readonly string[];
  /** Everything already settled, read from `design/decisions.md`. */
  readonly decisions: readonly DecisionEntry[];
  /** The project's own words: `design/brief.md` and `design/recipe.md`, concatenated. */
  readonly briefText: string;
  /**
   * An advisor's pick, when the caller consulted one (plan §4 step 3, phase C). Honoured only when
   * it names one of {@link options} — an advisor that answers in prose has not answered the fork.
   */
  readonly advisorChoice?: string | null;
}

export interface AutopilotAnswer {
  /** The option to answer with, verbatim as the agent offered it. */
  readonly choice: string;
  /** Provenance, for the line this answer will add to `design/decisions.md`. */
  readonly source: DecisionSource;
  /**
   * Which step produced it. `decision-log` means the fork was already settled and the answer is a
   * replay, so the caller must NOT rewrite the log line — doing so would drop the reason recorded
   * with the original and restamp somebody else's decision with today's date.
   */
  readonly via: 'decision-log' | 'brief' | 'advisor';
}

/**
 * Words too common to be evidence that an option matches the brief.
 *
 * Both languages, because a Flow brief is written in whatever the user typed in, and an option like
 * "по счёту" against a Russian brief would otherwise match on "по" alone.
 */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'for',
  'with',
  'from',
  'is',
  'it',
  'be',
  'as',
  'no',
  'yes',
  'и',
  'или',
  'в',
  'во',
  'на',
  'по',
  'с',
  'со',
  'из',
  'к',
  'у',
  'за',
  'для',
  'не',
  'да',
  'нет',
]);

/** Lowercase word tokens, punctuation and markdown dropped. */
const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);

/** The tokens of an option that could carry meaning — short and common ones cannot. */
const significantTokens = (text: string): string[] =>
  tokenize(text).filter(token => token.length >= 3 && !STOP_WORDS.has(token));

/** Shortest stem two tokens may share before one is read as an inflection of the other. */
const MIN_STEM = 4;

/**
 * Does the brief say this word?
 *
 * A whole-token hit first, then one token being a prefix of the other with at least
 * {@link MIN_STEM} characters in common. The second rule exists because a Flow brief is prose in
 * the user's own language and Russian inflects: the brief says "счёт" and the option reads
 * "по счёту". It is deliberately not substring matching — "timer" and "timescale" share four
 * characters but neither starts with the other, so a `timescale` tunable cannot settle a fork
 * about a timer.
 */
const briefSays = (token: string, briefTokens: ReadonlySet<string>): boolean => {
  if (briefTokens.has(token)) {
    return true;
  }
  for (const candidate of briefTokens) {
    if (
      Math.min(candidate.length, token.length) >= MIN_STEM &&
      (candidate.startsWith(token) || token.startsWith(candidate))
    ) {
      return true;
    }
  }
  return false;
};

/** How much of an option the brief already says, as a fraction of its significant words. */
const briefSupport = (option: string, briefTokens: ReadonlySet<string>): number => {
  const tokens = significantTokens(option);
  if (tokens.length === 0) {
    return 0;
  }
  const matched = tokens.filter(token => briefSays(token, briefTokens)).length;
  return matched / tokens.length;
};

/** An option has to be at least half-spelled-out in the brief before it counts as the brief's answer. */
const MIN_SUPPORT = 0.5;

/**
 * Answer the fork, or admit that nothing here can (plan §4 steps 1–3).
 *
 * Ambiguity returns `null` on purpose. Two options the brief mentions equally are exactly the case
 * the `ask_user` contract exists for — "guessing wrong means rebuilding" — and an answer picked
 * between them would be recorded in the decision log as if it had been reasoned.
 */
export const routeQuestion = (input: AutopilotRouterInput): AutopilotAnswer | null => {
  // 1. Already settled. After a compaction the model re-asks what the user answered an hour ago;
  //    replaying the logged choice is the cheapest and the most trustworthy answer there is.
  const settled = input.decisions.find(entry => sameQuestion(entry.question, input.question));
  if (settled && settled.choice) {
    return { choice: settled.choice, source: settled.source ?? 'user', via: 'decision-log' };
  }

  if (input.options.length === 0) {
    return null;
  }

  // 3. An advisor's pick, when the caller made that call. Ranked here (not after step 2) only
  //    because it is the more expensive evidence: a model that read the brief beats token overlap.
  if (input.advisorChoice) {
    const named = input.options.find(
      option => option.trim().toLowerCase() === input.advisorChoice?.trim().toLowerCase()
    );
    if (named) {
      return { choice: named, source: 'auto-advisor', via: 'advisor' };
    }
  }

  // 2. The brief/recipe already says it. The user wrote those words; repeating them back is not a
  //    guess, it is reading.
  const briefTokens = new Set(tokenize(input.briefText));
  if (briefTokens.size === 0) {
    return null;
  }
  const scored = input.options
    .map(option => ({ option, support: briefSupport(option, briefTokens) }))
    .filter(entry => entry.support >= MIN_SUPPORT)
    .sort((a, b) => b.support - a.support);
  if (scored.length === 0 || (scored.length > 1 && scored[0].support === scored[1].support)) {
    return null;
  }
  return { choice: scored[0].option, source: 'auto-brief', via: 'brief' };
};
