import type { ServiceContainer } from '@/fw/di';
import { appState } from '@/state';
import { SceneManager } from '@pix3/runtime';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';
import { LoadSceneCommand } from '@/features/scene/LoadSceneCommand';

/** Resource id of the singleton game tab in Studio. */
const GAME_TAB_RESOURCE_ID = 'game-view-instance';

/**
 * Where the game lives depends on the workspace, and the play commands must not care.
 *
 * In **Studio** a scene is played by focusing its editor tab and opening the Game tab — both
 * Golden-Layout operations through `EditorTabService`. **Flow has no layout and no tabs**: the
 * runtime is mounted straight into the Flow stage (`GamePlaySessionService.registerTabHost`), so
 * the same commands must instead load the scene graph directly and leave the surface alone.
 *
 * Without this split every play path silently no-ops in Flow: `EditorTabService.openResourceTab`
 * needs a layout that was never initialized, so play mode flips on with nothing ever mounted and
 * the stage stays black — which is also what breaks the agent's `play_start` there.
 */
const isFlow = (): boolean => appState.ui.workspaceMode === 'flow';

/** Scene id EditorTabService would derive for a resource path — kept in sync deliberately. */
export const deriveSceneId = (resourcePath: string): string => {
  const withoutScheme = resourcePath
    .replace(/^res:\/\//i, '')
    .replace(/^templ:\/\//i, '')
    .replace(/^collab:\/\//i, '');
  const withoutExtension = withoutScheme.replace(/\.[^./]+$/i, '');
  const normalized = withoutExtension
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized || 'scene';
};

/**
 * Make `resourcePath` the active scene, whichever workspace we are in. Studio routes through the
 * tab (so the viewport, selection and camera state follow); Flow loads the graph and points the
 * SceneManager at it.
 */
export const ensureSceneActive = async (
  container: ServiceContainer,
  resourcePath: string
): Promise<void> => {
  if (!isFlow()) {
    const tabs = container.getService<EditorTabService>(
      container.getOrCreateToken(EditorTabService)
    );
    await tabs.focusOrOpenScene(resourcePath);
    return;
  }

  const sceneId = deriveSceneId(resourcePath);
  const sceneManager = container.getService<SceneManager>(container.getOrCreateToken(SceneManager));

  if (appState.scenes.descriptors[sceneId]) {
    if (appState.scenes.activeSceneId !== sceneId) {
      // Both halves, always: `activeSceneId` alone leaves SceneManager pointing at the previously
      // loaded graph, and every consumer that resolves "the active graph" then edits the wrong tree.
      sceneManager.setActiveScene(sceneId);
      appState.scenes.activeSceneId = sceneId;
    }
    return;
  }

  // Scripts first: a scene parsed before esbuild has registered the project's `user:*` classes
  // loads with its script components silently dropped — it renders, but the game logic is dead.
  const scripts = container.getService<ProjectScriptLoaderService>(
    container.getOrCreateToken(ProjectScriptLoaderService)
  );
  await scripts.ensureReady();

  const dispatcher = container.getService<CommandDispatcher>(
    container.getOrCreateToken(CommandDispatcher)
  );
  const loaded = await dispatcher.execute(
    new LoadSceneCommand({ filePath: resourcePath, sceneId })
  );

  // A blocked command is not an exception: `CommandDispatcher.execute` warns and returns false when
  // preconditions fail (a project that flipped out of `ready` mid-await is enough). Swallowing that
  // is what turns "the scene never opened" into the far more confusing "play mode is on, the stage
  // is black, and the next start is refused because the game is already running".
  if (!loaded || !appState.scenes.activeSceneId) {
    throw new Error(`Could not open the scene ${resourcePath}.`);
  }
};

/** Path (relative, no scheme) of the scene the editor treats as the gameplay scene. */
const GAMEPLAY_SCENE_PATH = 'scenes/main.pix3scene';

const stripScheme = (path: string): string =>
  path
    .replace(/^res:\/\//i, '')
    .replace(/^\/+/, '')
    .toLowerCase();

/**
 * Which scene to open when a play command is asked to run "the current scene" and nothing is open.
 *
 * The order deliberately prefers the **gameplay** scene over the project's entry scene: recipe
 * projects boot a menu (`entryScene: scenes/menu.pix3scene` → `defaultExportScenePath`), and landing
 * a prototyping session on the menu is both what the user sees on the stage and — worse — what every
 * subsequent agent edit targets, since `appState.scenes.activeSceneId` is the editing surface.
 * `AgentToolRegistry.ensureActiveScene` already reasons this way; this is the same order, reachable
 * from the commands.
 *
 * The manifest's `defaultExportScenePath` is **not** in the order, on purpose: on a recipe project
 * that value *is* the menu. A project that genuinely ships no `scenes/main.pix3scene` and has no
 * scene open gets a failure naming the path it looked for, and the caller can still run the whole
 * flow through `game.start-main` — which is a better outcome than silently prototyping on a menu.
 */
export const resolveGameplayScenePath = (state: {
  scenes: { descriptors: Record<string, { filePath?: string } | undefined> };
}): string => {
  const descriptorPaths = Object.values(state.scenes.descriptors)
    .map(descriptor => descriptor?.filePath ?? '')
    .filter(path => path.length > 0);

  return (
    descriptorPaths.find(path => stripScheme(path) === GAMEPLAY_SCENE_PATH) ??
    descriptorPaths[0] ??
    // Nothing is open: a fresh Flow project, which never had a startup scene opened for it
    // (`PrototypeBootstrapService` goes straight to `createNewProjectWithOptions`, skipping
    // `openStartupScene`). Every shipped template carries this path.
    `res://${GAMEPLAY_SCENE_PATH}`
  );
};

/**
 * Reveal the surface the running game is drawn on. Studio opens/focuses the Game tab; in Flow the
 * stage is permanently mounted, so there is nothing to open.
 */
export const openGameSurface = async (container: ServiceContainer): Promise<void> => {
  if (isFlow()) {
    return;
  }
  const tabs = container.getService<EditorTabService>(container.getOrCreateToken(EditorTabService));
  await tabs.openResourceTab('game', GAME_TAB_RESOURCE_ID, {}, true);
};

/** Tear the Studio game tab down after a stop. No-op in Flow, where the stage simply idles. */
export const closeGameSurface = async (container: ServiceContainer): Promise<void> => {
  if (isFlow()) {
    return;
  }
  const tabs = container.getService<EditorTabService>(container.getOrCreateToken(EditorTabService));
  await tabs.closeTab(`game:${GAME_TAB_RESOURCE_ID}`);
};
