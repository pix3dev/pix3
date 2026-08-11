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
  await dispatcher.execute(new LoadSceneCommand({ filePath: resourcePath, sceneId }));
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
