import { describe, expect, it } from 'vitest';

import type { AgentKitInstallReport } from './agent-kit-install';
import { buildAgentHandoff, buildFirstPrompt, PROMPT_PLACEHOLDER } from './agent-handoff';

const report = (mcpCliVersion: string | null): AgentKitInstallReport => ({
  version: '1.6.0',
  files: [{ path: 'AGENTS.md', action: 'written' }],
  instructions: [],
  notes: [],
  types: 'kit-tsconfig',
  mcpCliVersion,
  agentKitMetadata: { version: '1.6.0', files: ['AGENTS.md'] },
});

describe('buildAgentHandoff', () => {
  it('builds the start commands, the recipe prompt and the serve line for a local folder', () => {
    const handoff = buildAgentHandoff({
      id: 'h1',
      folderName: 'my game',
      backend: 'local',
      kit: report('1.6.0'),
      cli: { kind: 'lockstep', version: '1.6.0' },
      editorVersion: '1.6.0',
      recipeTitle: 'Tapper 2D',
      hasRecipeDoc: true,
    });
    expect(handoff.startCommands.map(c => c.command)).toEqual([
      "cd 'my game' && claude",
      "cd 'my game' && codex",
    ]);
    expect(handoff.firstPrompt).toContain('"Tapper 2D" recipe');
    expect(handoff.firstPrompt).toContain('design/recipe.md');
    expect(handoff.firstPrompt).toContain(PROMPT_PLACEHOLDER);
    expect(handoff.serveCommand).toBe("cd 'my game' && npx -y @pix3/cli@1.6.0 serve");
    expect(handoff.mcpMissingReason).toBeNull();
    expect(handoff.setupCommands.map(c => c.command)).toEqual([
      "cd 'my game' && npx -y @pix3/cli@1.6.0 setup codex",
    ]);
  });

  it('says the matching CLI is not published and offers the setup instruction instead', () => {
    const handoff = buildAgentHandoff({
      id: 'h2',
      folderName: 'game',
      backend: 'local',
      kit: report(null),
      cli: { kind: 'unavailable', reason: 'not-published' },
      editorVersion: '1.6.0',
      recipeTitle: null,
      hasRecipeDoc: false,
    });
    expect(handoff.mcpMissingReason).toBe(
      'The CLI version matching this editor (1.6.0) is not published yet, so .mcp.json was not written.'
    );
    expect(handoff.setupCommands[0].command).toBe(
      'cd game && npx -y @pix3/cli@1.6.0 kit --update && npx -y @pix3/cli@1.6.0 setup claude'
    );
  });

  it('pins the latest published version everywhere when that is what the gate found', () => {
    const handoff = buildAgentHandoff({
      id: 'h3',
      folderName: 'game',
      backend: 'workspace',
      kit: report('1.5.0'),
      cli: { kind: 'latest', version: '1.5.0' },
      editorVersion: '1.6.0',
      recipeTitle: null,
      hasRecipeDoc: false,
    });
    expect(handoff.serveCommand).toBeNull();
    expect(handoff.setupCommands.every(c => c.command.includes('@pix3/cli@1.5.0'))).toBe(true);
  });

  it('writes a generic prompt for a project that is not from a recipe', () => {
    expect(buildFirstPrompt(null, false)).toBe(
      `This folder is a Pix3 game project. Read AGENTS.md first. Make my game: ${PROMPT_PLACEHOLDER}. Finish every change with a green pix3 check.`
    );
  });
});
