/**
 * The autopilot's queue: which increment the supervisor takes next, and the message it sends to
 * take it (autopilot plan §2.1 and §2.3).
 *
 * Pure, and deliberately reading the SAME `design/progress.md` the side panel renders and the agent
 * itself maintains. A second queue file would be a second source of truth about what the prototype
 * still owes — the class of bug that already cost this codebase an afternoon over the active scene.
 *
 * The checklist lines are parsed by {@link parseChecklist}, so the supervisor and the tracker can
 * never disagree about what an item says. What this module adds on top is the one thing a flat list
 * cannot carry: which SECTION an item is in, because the priority order treats a playtest defect,
 * a main-list increment and a spectacle beat differently.
 */

import { parseChecklist, type FlowPlan, type FlowPlanStep } from '@/services/flow/FlowPlanService';

/**
 * Priority class of a queue item, in the order {@link selectNextStep} considers them (plan §2.3;
 * step 1, "a message from the human", is not this module's business — it always wins upstream).
 */
export type AutopilotStepKind = 'fix-p0' | 'active' | 'todo' | 'fix-p1' | 'wow';

export interface AutopilotStep extends FlowPlanStep {
  readonly kind: AutopilotStepKind;
}

export interface AutopilotSelection {
  /** The increment to take, or null when there is nothing left to take. */
  readonly step: AutopilotStep | null;
  /** True when the checklist is clear — "the prototype is as done as the queue can say" (§5). */
  readonly done: boolean;
}

/** Section of `design/progress.md` an item was found in. */
type ProgressSection = 'main' | 'wow' | 'playtest';

/**
 * A defect item, as the playtester will write it (plan §2.1): `- [ ] FIX: <defect> — <report>`.
 *
 * The class marker is optional because the plan's format does not carry one, and the default is
 * P0 on purpose: an unclassified defect interrupts the queue. Being wrong that way costs one
 * increment spent early on a cosmetic bug; being wrong the other way ships a crash.
 */
const FIX_PREFIX = /^FIX\s*(?:[([]\s*(P[01])\s*[)\]]|\s+(P[01]))?\s*[:：]\s*(.*)$/i;

/** The prose line `renderProgressMarkdown` writes above the spectacle beats. */
const WOW_LEAD = /^spectacle beats\b/i;

const sectionForHeading = (heading: string): ProgressSection => {
  if (/found by playtest|playtest/i.test(heading)) return 'playtest';
  if (/spectacle|wow/i.test(heading)) return 'wow';
  return 'main';
};

/**
 * Every unfinished item of `design/progress.md`, in file order, tagged with its priority class.
 *
 * Done items are dropped here rather than filtered by the caller: nothing downstream has a use for
 * them, and a queue that carries them invites a caller to forget the check.
 */
export const parseAutopilotSteps = (progressMarkdown: string): AutopilotStep[] => {
  const steps: AutopilotStep[] = [];
  let section: ProgressSection = 'main';
  for (const line of progressMarkdown.split('\n')) {
    const heading = /^##+\s+(.+)$/.exec(line);
    if (heading) {
      section = sectionForHeading(heading[1]);
      continue;
    }
    // The bootstrap's own checklist has no heading over the spectacle beats — just the prose line
    // that introduces them — so the lead-in is what switches the section for a file it wrote.
    if (WOW_LEAD.test(line.trim())) {
      section = 'wow';
      continue;
    }
    // One line at a time through the shared parser: the supervisor must read an item exactly as
    // the tracker shows it, including the `— note` tail and the numbered-list shapes models write.
    const [parsed] = parseChecklist(line);
    if (!parsed || parsed.status === 'done') {
      continue;
    }
    const fix = FIX_PREFIX.exec(parsed.title);
    if (fix) {
      const severity = (fix[1] ?? fix[2] ?? 'P0').toUpperCase();
      steps.push({
        ...parsed,
        title: fix[3].trim() || parsed.title,
        kind: severity === 'P1' ? 'fix-p1' : 'fix-p0',
      });
      continue;
    }
    steps.push({
      ...parsed,
      kind: section === 'wow' ? 'wow' : parsed.status === 'active' ? 'active' : 'todo',
    });
  }
  return steps;
};

/** The order of {@link AutopilotStepKind}, most urgent first. */
const PRIORITY: readonly AutopilotStepKind[] = ['fix-p0', 'active', 'todo', 'fix-p1', 'wow'];

/**
 * The next increment, by the deterministic priority of plan §2.3 — no model involved.
 *
 * An unfinished `- [~]` outranks a fresh `- [ ]` because it is the increment the verify gate would
 * not let close honestly: taking a new one on top of it is how a prototype ends up with two
 * half-built mechanics and no proof for either.
 */
export const selectNextStep = (steps: readonly AutopilotStep[]): AutopilotSelection => {
  for (const kind of PRIORITY) {
    const step = steps.find(candidate => candidate.kind === kind);
    if (step) {
      return { step, done: false };
    }
  }
  return { step: null, done: true };
};

/** Convenience for callers holding the raw file: {@link parseAutopilotSteps} + {@link selectNextStep}. */
export const selectNextStepFromProgress = (progressMarkdown: string): AutopilotSelection =>
  selectNextStep(parseAutopilotSteps(progressMarkdown));

/**
 * The turn message the supervisor sends to take one increment.
 *
 * Modelled on `renderFirstTurnMessage` and saying the same three things — take ONE increment, prove
 * it in the running game, write the result back to `design/progress.md` — plus the one instruction
 * that only makes sense with nobody at the keyboard: do not spend a turn asking about a detail you
 * are allowed to choose. The `[Autopilot]` prefix mirrors the loop's own `[Pix3]` interjections, so
 * the agent (and the user reading the thread later) can tell a supervised turn from a typed one.
 */
export const renderAutopilotTurnMessage = (step: AutopilotStep, plan: FlowPlan): string => {
  const isFix = step.kind === 'fix-p0' || step.kind === 'fix-p1';
  const lines: string[] = [
    `[Autopilot] Nobody is at the keyboard, so I took the next item from \`design/progress.md\` myself.`,
    '',
  ];
  if (plan.title) {
    lines.push(`Prototype: **${plan.title}**${plan.pitch ? ` — ${plan.pitch}` : ''}`, '');
  }
  lines.push(
    isFix
      ? `Fix this defect, and nothing else this turn: **${step.title}**`
      : `Take this increment, and only this one: **${step.title}**`
  );
  if (step.note) {
    lines.push(`Recorded next to it: ${step.note}`);
  }
  lines.push(
    '',
    'Prove it in the running game before you report: compile, play, drive it with `game_input`,',
    'judge the outcome with `game_run` (an `until` that says what success IS), and read errors.',
    'Then update `design/progress.md` — tick this item `- [x]` with how you proved it, and mark the',
    'next one `- [~]` — and reply with one short summary of what changed and what it now does.',
    '',
    'Decide the small things yourself and say which way you went: colours, sizes, counts, wording,',
    'placement. Keep `ask_user` for a fork that would change the structure of the scene or the',
    'scripts — and expect to answer it yourself, because no one is reading it right now.'
  );
  return lines.join('\n');
};
