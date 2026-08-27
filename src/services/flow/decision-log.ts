/**
 * `design/decisions.md` — the format, in one place.
 *
 * The file is the Flow's memory of settled forks: it is re-read at the start of every compacted
 * conversation and handed to the planner at the idea → prototype transition, so a decision must
 * cost about thirty tokens, not a paragraph. Hence the single line:
 *
 * ```
 * - **Portrait or landscape?** → Portrait. Matches the ad slot. _(rejected: landscape)_ — 2026-08-27
 * ```
 *
 * Four callers share this module, which is the reason it exists: the `record_decision` tool writes
 * the line, `AgentChatService` writes one for every `ask_user` answer, the idea-stage document
 * renders the log, and `PrototypeBootstrapService` reads it into the planner prompt. A format that
 * lived in any one of them would drift out of the other three.
 */

/** The one file. Every writer and reader in the Flow points here. */
export const DECISIONS_PATH = 'design/decisions.md';

/** Heading the file is created with when a decision arrives before the scaffold does. */
const DECISIONS_HEADING = '# Decisions';

/** A settled fork, parsed out of the log or on its way into it. */
export interface DecisionEntry {
  /** The fork, as it was put to the user. */
  readonly question: string;
  /** What was settled on. */
  readonly choice: string;
  /** Why, in one line. Empty when nobody said. */
  readonly reason: string;
  /** The options that lost, if they were named. */
  readonly rejected: readonly string[];
  /** `YYYY-MM-DD`, or empty for an entry written before the log carried dates. */
  readonly date: string;
}

/**
 * Markdown that must not survive into a decision line.
 *
 * The question is wrapped in `**…**`, so a stray `*` inside it would close the span early and the
 * line would stop parsing as a decision — including on the read side, which is how a mangled entry
 * would silently vanish from the planner prompt instead of failing loudly.
 */
const collapse = (text: string): string => text.replace(/\s+/g, ' ').replace(/[*_`]/g, '').trim();

/**
 * End a fragment with exactly one sentence stop, so `choice` and `reason` read as one sentence.
 *
 * `…` counts as a stop it already has: a caller handing in a deliberately truncated phrase would
 * otherwise get `stations….`, which is what the first condensed moodboard caption wrote live.
 */
const endWithStop = (text: string): string => (/[.!?…]$/.test(text) ? text : `${text}.`);

/**
 * Today as `YYYY-MM-DD`, in the USER's timezone. Split out so tests can hand in a fixed day.
 *
 * Not `toISOString()`, which is UTC: a decision settled at half past midnight east of Greenwich
 * would be filed as yesterday, in a log the user reads as a diary of their own session. Caught
 * live — the first entry written from this machine was stamped a day behind the wall clock.
 */
export const todayStamp = (now: Date = new Date()): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;

/**
 * Render one decision as the log's canonical line.
 *
 * Everything past the choice is optional and omitted when absent — an entry auto-recorded from an
 * `ask_user` answer is just `- **question** → choice — date`, and that is a complete decision.
 */
export const formatDecisionLine = (
  entry: Omit<DecisionEntry, 'date' | 'rejected'> & {
    readonly rejected?: readonly string[];
    readonly date?: string;
  }
): string => {
  const question = collapse(entry.question);
  const choice = collapse(entry.choice);
  const reason = collapse(entry.reason ?? '');
  const rejected = (entry.rejected ?? []).map(collapse).filter(Boolean);
  const date = entry.date ?? todayStamp();
  const parts = [`- **${question}** → ${endWithStop(choice)}`];
  if (reason) {
    parts.push(endWithStop(reason));
  }
  if (rejected.length > 0) {
    parts.push(`_(rejected: ${rejected.join(', ')})_`);
  }
  if (date) {
    parts.push(`— ${date}`);
  }
  return parts.join(' ');
};

/** Two questions are the same fork when they read the same ignoring case and punctuation. */
export const sameQuestion = (a: string, b: string): boolean =>
  collapse(a)
    .toLowerCase()
    .replace(/[?.!,:;]+$/, '') ===
  collapse(b)
    .toLowerCase()
    .replace(/[?.!,:;]+$/, '');

const ONE_LINER = /^[ \t]*[-*][ \t]*\*\*(.+?)\*\*[ \t]*(?:→|->)[ \t]*(.+)$/;
const BLOCK_HEADING = /^##[ \t]+(.+)$/;
const BLOCK_CHOICE = /^[ \t]*[-*][ \t]*\*\*Chosen:\*\*[ \t]*(.+)$/i;
const BLOCK_REASON = /^[ \t]*[-*][ \t]*\*\*Why:\*\*[ \t]*(.+)$/i;
const TRAILING_DATE = /[ \t]*[—-][ \t]*(\d{4}-\d{2}-\d{2})[ \t]*$/;
const REJECTED = /[ \t]*_\((?:rejected|отклонено):[ \t]*(.+?)\)_[ \t]*/i;

/** Split a one-liner's tail into choice / reason / rejected / date. */
const parseTail = (tail: string): Omit<DecisionEntry, 'question'> => {
  let rest = tail.trim();
  let date = '';
  const dateMatch = TRAILING_DATE.exec(rest);
  if (dateMatch) {
    date = dateMatch[1];
    rest = rest.slice(0, dateMatch.index).trim();
  }
  let rejected: string[] = [];
  const rejectedMatch = REJECTED.exec(rest);
  if (rejectedMatch) {
    rejected = rejectedMatch[1]
      .split(',')
      .map(part => part.trim())
      .filter(Boolean);
    rest = (
      rest.slice(0, rejectedMatch.index) + rest.slice(rejectedMatch.index + rejectedMatch[0].length)
    ).trim();
  }
  // The choice is the first sentence; anything after it is the reason. Written by this module, so
  // the split is exact — and forgiving enough for a line a human typed by hand.
  const stop = /\.(?:\s+|$)/.exec(rest);
  const choice = stop ? rest.slice(0, stop.index) : rest;
  const reason = stop ? rest.slice(stop.index + stop[0].length) : '';
  return {
    choice: choice.trim().replace(/[.]+$/, ''),
    reason: reason.trim().replace(/[.]+$/, ''),
    rejected,
    date,
  };
};

/**
 * Every settled fork in the log, oldest first.
 *
 * Both shapes are read: the one-liner this module writes, and the `## question` + `- **Chosen:**`
 * block the original scaffold documented (projects created before the tool existed still hold it).
 * Fenced blocks are stripped first — the old scaffold's own example *is* a `## <the question>`
 * block, and reading it back would put a template into the planner prompt.
 */
export const extractDecisionEntries = (markdown: string): DecisionEntry[] => {
  const withoutFences = markdown.replace(/```[\s\S]*?(?:```|$)/g, '');
  const entries: DecisionEntry[] = [];
  let question: string | null = null;
  for (const line of withoutFences.split(/\r?\n/)) {
    const heading = BLOCK_HEADING.exec(line);
    if (heading) {
      question = heading[1].trim();
      continue;
    }
    const chosen = BLOCK_CHOICE.exec(line);
    if (chosen && question) {
      entries.push({
        question,
        choice: chosen[1].trim().replace(/[.]+$/, ''),
        reason: '',
        rejected: [],
        date: '',
      });
      question = null;
      continue;
    }
    // `- **Why:**` belongs to the block entry just pushed, so it fills that one's reason in.
    const why = BLOCK_REASON.exec(line);
    const last = entries[entries.length - 1];
    if (why && last && !last.reason) {
      entries[entries.length - 1] = { ...last, reason: why[1].trim().replace(/[.]+$/, '') };
      continue;
    }
    const oneLiner = ONE_LINER.exec(line);
    if (oneLiner) {
      entries.push({ question: oneLiner[1].trim(), ...parseTail(oneLiner[2]) });
    }
  }
  return entries;
};

/**
 * Append a decision to the log's text, or replace the entry that settled the same fork.
 *
 * Replacement rather than a second line, because the file answers one question — "what has the user
 * already settled?" — and two lines for one fork make the planner read a contradiction. It happens
 * on the documented path, not in a corner case: an `ask_user` answer is recorded by code the moment
 * it arrives, and the agent is invited to follow it with a `record_decision` carrying the reason.
 *
 * Returns the new file text, the line that was written, and whether it replaced an earlier entry.
 */
export const appendDecision = (
  source: string,
  entry: Omit<DecisionEntry, 'date' | 'rejected'> & {
    readonly rejected?: readonly string[];
    readonly date?: string;
  }
): { readonly text: string; readonly line: string; readonly replaced: boolean } => {
  const base = source.trim().length > 0 ? source : `${DECISIONS_HEADING}\n`;
  const lines = base.split(/\r?\n/);
  let existingQuestion: string | null = null;
  const existing = lines.findIndex(candidate => {
    const match = ONE_LINER.exec(candidate);
    if (match === null || !sameQuestion(match[1], entry.question)) {
      return false;
    }
    existingQuestion = match[1].trim();
    return true;
  });
  if (existing >= 0) {
    // The wording stays as the user was asked it. A later call may enrich the choice or add the
    // reason; rewriting the question would quietly restate the fork as the model now remembers it.
    const line = formatDecisionLine({ ...entry, question: existingQuestion ?? entry.question });
    lines[existing] = line;
    return { text: `${lines.join('\n').replace(/\s+$/, '')}\n`, line, replaced: true };
  }
  const line = formatDecisionLine(entry);
  return { text: `${base.replace(/\s+$/, '')}\n\n${line}\n`, line, replaced: false };
};
