import { inject, injectable } from '@/fw/di';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';

export type FlowPlanStepStatus = 'done' | 'active' | 'todo';

export interface FlowPlanStep {
  readonly title: string;
  readonly status: FlowPlanStepStatus;
  /** Optional one-line evidence the agent recorded next to the item ("proved with game_input"). */
  readonly note?: string;
}

export interface FlowPlan {
  /** One-line pitch for the header, from `design/brief.md`. */
  readonly pitch: string | null;
  readonly title: string | null;
  readonly steps: readonly FlowPlanStep[];
}

export const FLOW_BRIEF_PATH = 'design/brief.md';
export const FLOW_PROGRESS_PATH = 'design/progress.md';
export const FLOW_DECISIONS_PATH = 'design/decisions.md';

const EMPTY_PLAN: FlowPlan = { pitch: null, title: null, steps: [] };

/**
 * Reads the plan the Flow header shows: the increment checklist the agent keeps in
 * `design/progress.md` plus the pitch from `design/brief.md`.
 *
 * Deliberately derived from the PROJECT FILES rather than from agent events: the docs are the
 * agent's memory across context compaction (design §5.6), so a tracker fed by them survives a
 * compacted conversation, a reload, and a switch to Studio and back. Nothing here writes — the
 * expander seeds the files and the agent updates them.
 */
@injectable()
export class FlowPlanService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  async load(): Promise<FlowPlan> {
    const [brief, progress] = await Promise.all([
      this.readOptional(FLOW_BRIEF_PATH),
      this.readOptional(FLOW_PROGRESS_PATH),
    ]);
    if (brief === null && progress === null) {
      return EMPTY_PLAN;
    }
    return {
      title: brief ? extractTitle(brief) : null,
      pitch: brief ? extractPitch(brief) : null,
      steps: progress ? parseChecklist(progress) : [],
    };
  }

  private async readOptional(path: string): Promise<string | null> {
    try {
      return await this.storage.readTextFile(path);
    } catch {
      return null;
    }
  }
}

/** First `# Heading` of the brief. */
const extractTitle = (markdown: string): string | null => {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
};

/**
 * The pitch line: an explicit `**Pitch:**`/`Pitch:` field when the brief has one, else the first
 * non-empty prose line after the title.
 */
const extractPitch = (markdown: string): string | null => {
  const explicit = markdown.match(/^\*{0,2}(?:pitch|питч)\*{0,2}\s*:\s*(.+)$/im);
  if (explicit) {
    return explicit[1].replace(/\*/g, '').trim();
  }
  const lines = markdown.split('\n');
  const titleIndex = lines.findIndex(line => /^#\s+/.test(line));
  for (let i = titleIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    return line.replace(/\*/g, '');
  }
  return null;
};

/**
 * A numbered plan step, as models keep rewriting the checklist into: `1. tap coins ← DONE`.
 *
 * Observed live: an increment that rewrote `design/progress.md` as a numbered list emptied the plan
 * tracker to "No plan yet" while the agent was reporting real progress against it. The file is the
 * agent's own memory in its own words, so the parser meets it where it is — a status word anywhere
 * on the line (DONE / IN PROGRESS / TODO, or a leading `[x]`) decides the marker.
 */
const matchNumberedStep = (line: string): RegExpMatchArray | null => {
  const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
  if (!numbered) return null;
  const body = numbered[1].trim();
  const done = /(^|\s|←|->|—)(done|готово|✅|\[x\])\b/i.test(body) || /^\[x\]/i.test(body);
  const active = /\b(in progress|current|активн|в работе|\(now\))\b/i.test(body);
  const marker = done ? 'x' : active ? '~' : ' ';
  // Strip the status word itself so the tracker shows the step, not the bookkeeping.
  const title = body
    .replace(/\s*(?:←|->|—|--)?\s*\b(done|готово|in progress|current|✅)\b.*$/i, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .trim();
  return [line, marker, title || body] as unknown as RegExpMatchArray;
};

/**
 * Parse a markdown checklist into plan steps. `- [x]` is done, `- [ ]` is pending, and `- [~]`
 * (or a trailing "(in progress)") marks the increment being worked on right now — the skill asks
 * the agent to mark exactly one that way so the tracker can show what is happening.
 */
export const parseChecklist = (markdown: string): FlowPlanStep[] => {
  const steps: FlowPlanStep[] = [];
  for (const line of markdown.split('\n')) {
    const match = line.match(/^\s*[-*]\s*\[([ xX~>])\]\s*(.+)$/) ?? matchNumberedStep(line);
    if (!match) continue;
    const marker = match[1].toLowerCase();
    let title = match[2].trim();
    let note: string | undefined;
    // "Add enemies — proved with game_input" → the tail becomes the hover note, not the label.
    const noteSplit = title.match(/^(.+?)\s+(?:—|--|·)\s+(.+)$/);
    if (noteSplit) {
      title = noteSplit[1].trim();
      note = noteSplit[2].trim();
    }
    const inProgress = marker === '~' || marker === '>' || /\(in progress\)/i.test(title);
    steps.push({
      title: title.replace(/\s*\(in progress\)\s*/i, '').trim(),
      status: marker === 'x' ? 'done' : inProgress ? 'active' : 'todo',
      note,
    });
  }
  return steps;
};
