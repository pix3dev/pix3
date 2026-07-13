import { injectable } from '@/fw/di';
import gamePrototype from './agent-skills/game-prototype.md?raw';
import assetGeneration from './agent-skills/asset-generation.md?raw';
import verifyAndFix from './agent-skills/verify-and-fix.md?raw';

/** A bundled knowledge pack the in-editor agent can read on demand via the `read_skill` tool. */
export interface AgentSkill {
  readonly id: string;
  /** One-line "when to use" hook — this is what the system-prompt index shows. */
  readonly whenToUse: string;
  readonly content: string;
}

/**
 * Editor-shipped "skills" for the in-editor agent: short, imperative process guides (author a game
 * from a GDD, generate matching art, verify-and-fix) that weak coding models follow well. The
 * system prompt lists them as a tiny index (`id — when to use`); the agent pulls a full pack with
 * the `read_skill` tool only when a task matches. This keeps process knowledge editable as markdown
 * (not baked into code) and out of the base prompt until it's needed.
 *
 * The packs teach *process*; concrete facts (component types, node properties, commands) come from
 * the live introspection tools (`list_component_types`, `node_inspect`, `list_commands`).
 */
@injectable()
export class AgentSkillsService {
  private readonly skills: readonly AgentSkill[] = [
    {
      id: 'game-prototype',
      whenToUse: 'turning a GDD/design doc into a playable prototype (the overall build loop)',
      content: gamePrototype,
    },
    {
      id: 'asset-generation',
      whenToUse: 'generating game art/sprites/icons that match the design and wiring them to nodes',
      content: assetGeneration,
    },
    {
      id: 'verify-and-fix',
      whenToUse: 'running the game to check it works and debugging runtime/script errors',
      content: verifyAndFix,
    },
  ];

  /** All skills (for the tool schema enum + the system-prompt index). */
  list(): readonly AgentSkill[] {
    return this.skills;
  }

  get(id: string): AgentSkill | undefined {
    return this.skills.find(skill => skill.id === id);
  }

  /** The compact index injected into the system prompt: one `- id — when to use` line each. */
  indexLines(): string[] {
    return this.skills.map(skill => `- ${skill.id} — ${skill.whenToUse}`);
  }

  /**
   * Return a skill's content, optionally sliced to a single `## Section` (case-insensitive match on
   * the heading text) so a targeted read stays small. Returns null for an unknown id/section.
   */
  read(id: string, section?: string): string | null {
    const skill = this.get(id);
    if (!skill) {
      return null;
    }
    if (!section || !section.trim()) {
      return skill.content;
    }
    return extractSection(skill.content, section.trim());
  }
}

/** Extract a `## <section>` block (up to the next `## `/`# ` heading). Case-insensitive contains. */
const extractSection = (content: string, section: string): string | null => {
  const lines = content.split('\n');
  const needle = section.toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,3}\s/.test(line) && line.toLowerCase().includes(needle)) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    return null;
  }
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      break;
    }
    out.push(lines[i]);
  }
  return out.join('\n').trim();
};
