import type { AgentKitInstallReport } from './agent-kit-install';
import type { CliVersionResolution } from './cli-version-gate';

/**
 * What the "Continue in your agent" screen shows after the editor wrote the agent kit (plan §1.1
 * step 3): the commands that start an agent in the project folder, the first prompt, and the
 * honest state of the live channel. Pure data, so the wording is specced without a DOM.
 */

export interface AgentHandoffCommand {
  readonly label: string;
  readonly command: string;
}

export interface AgentHandoff {
  readonly id: string;
  readonly folderName: string;
  readonly backend: 'local' | 'workspace';
  readonly kit: AgentKitInstallReport;
  readonly cli: CliVersionResolution;
  readonly editorVersion: string;
  /** `cd <folder> && claude` / `codex`. */
  readonly startCommands: readonly AgentHandoffCommand[];
  readonly firstPrompt: string;
  /** Where the prompt's recipe facts come from, for the screen's caption. */
  readonly firstPromptSource: string;
  /** Configure the pix3 MCP server (Codex always; Claude Code only when `.mcp.json` is absent). */
  readonly setupCommands: readonly AgentHandoffCommand[];
  /** The `pix3 serve` command a local-folder project needs for the live channel; null on a workspace. */
  readonly serveCommand: string | null;
  /** Why this run left `.mcp.json` out (no confirmed CLI version), or null when it pinned one. */
  readonly mcpMissingReason: string | null;
}

export interface BuildAgentHandoffInput {
  readonly id: string;
  readonly folderName: string;
  readonly backend: 'local' | 'workspace';
  readonly kit: AgentKitInstallReport;
  readonly cli: CliVersionResolution;
  readonly editorVersion: string;
  /** Title of the template the project was created from (`template.yaml` `title`). */
  readonly recipeTitle: string | null;
  /** The project ships `design/recipe.md`. */
  readonly hasRecipeDoc: boolean;
}

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

export const PROMPT_PLACEHOLDER = '<describe your game in one sentence>';

/**
 * The first prompt. The recipe facts come from `template.yaml` (its `title`) and the presence of
 * `design/recipe.md`; the rest is what the kit's AGENTS.md already teaches, so the prompt only
 * points there and leaves the idea to the human.
 */
export const buildFirstPrompt = (recipeTitle: string | null, hasRecipeDoc: boolean): string => {
  const origin = recipeTitle
    ? `This folder is a Pix3 game made from the "${recipeTitle}" recipe, and it already plays.`
    : 'This folder is a Pix3 game project.';
  const read = hasRecipeDoc
    ? 'Read AGENTS.md, then design/recipe.md (the map of what to change).'
    : 'Read AGENTS.md first.';
  const ask = hasRecipeDoc
    ? `Turn it into my game: ${PROMPT_PLACEHOLDER}. Change the recipe, do not rebuild it.`
    : `Make my game: ${PROMPT_PLACEHOLDER}.`;
  return `${origin} ${read} ${ask} Finish every change with a green pix3 check.`;
};

export const buildAgentHandoff = (input: BuildAgentHandoffInput): AgentHandoff => {
  const cd = `cd ${shellQuote(input.folderName)}`;
  const pinned = input.cli.kind === 'unavailable' ? null : input.cli.version;
  const cliRef = `@pix3/cli@${pinned ?? input.editorVersion}`;

  let mcpMissingReason: string | null = null;
  if (pinned === null) {
    mcpMissingReason =
      input.cli.kind === 'unavailable' && input.cli.reason === 'not-published'
        ? `The CLI version matching this editor (${input.editorVersion}) is not published yet, so .mcp.json was not written.`
        : `The CLI version matching this editor (${input.editorVersion}) is not published yet, or the npm registry could not be reached — .mcp.json was not written.`;
  }

  const setupCommands: AgentHandoffCommand[] = [];
  if (pinned === null) {
    setupCommands.push({
      label: 'Once it is published: write .mcp.json and see the Claude Code setup',
      command: `${cd} && npx -y ${cliRef} kit --update && npx -y ${cliRef} setup claude`,
    });
  }
  setupCommands.push({
    label: 'Codex keeps MCP servers in ~/.codex/config.toml: print the snippet to add',
    command: `${cd} && npx -y ${cliRef} setup codex`,
  });

  return {
    id: input.id,
    folderName: input.folderName,
    backend: input.backend,
    kit: input.kit,
    cli: input.cli,
    editorVersion: input.editorVersion,
    startCommands: [
      { label: 'Claude Code', command: `${cd} && claude` },
      { label: 'Codex', command: `${cd} && codex` },
    ],
    firstPrompt: buildFirstPrompt(input.recipeTitle, input.hasRecipeDoc),
    firstPromptSource: input.recipeTitle
      ? `Built from the recipe's template.yaml title${input.hasRecipeDoc ? ' and its design/recipe.md' : ''}; replace the placeholder with your idea.`
      : 'Generic: this project was not created from a recipe.',
    setupCommands,
    serveCommand: input.backend === 'local' ? `${cd} && npx -y ${cliRef} serve` : null,
    mcpMissingReason,
  };
};
