import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import type { GameAspectRatio, Navigation2DSettings } from '@/state/AppState';

export interface UpdateEditorSettingsParams {
  warnOnUnsavedUnload?: boolean;
  pauseRenderingOnUnfocus?: boolean;
  navigation2D?: Partial<Navigation2DSettings>;
  gameAspectRatio?: GameAspectRatio;
}

export interface EditorSettingsSnapshot {
  warnOnUnsavedUnload: boolean;
  pauseRenderingOnUnfocus: boolean;
  navigation2D: Navigation2DSettings;
  gameAspectRatio: GameAspectRatio;
}

const isGameAspectRatio = (value: unknown): value is GameAspectRatio => {
  return (
    value === 'free' || value === '16:9-landscape' || value === '16:9-portrait' || value === '4:3'
  );
};

export const EDITOR_SETTINGS_STORAGE_KEY = 'pix3.editorSettings:v1';

export const loadEditorSettings = (): Partial<EditorSettingsSnapshot> | null => {
  try {
    const raw = localStorage.getItem(EDITOR_SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EditorSettingsSnapshot> | null;
    if (parsed) {
      const result: Partial<EditorSettingsSnapshot> = {};
      if (typeof parsed.warnOnUnsavedUnload === 'boolean') {
        result.warnOnUnsavedUnload = parsed.warnOnUnsavedUnload;
      }
      if (typeof parsed.pauseRenderingOnUnfocus === 'boolean') {
        result.pauseRenderingOnUnfocus = parsed.pauseRenderingOnUnfocus;
      }
      if (parsed.navigation2D && typeof parsed.navigation2D === 'object') {
        const nav2D: Partial<Navigation2DSettings> = {};
        if (typeof parsed.navigation2D.panSensitivity === 'number') {
          nav2D.panSensitivity = parsed.navigation2D.panSensitivity;
        }
        if (typeof parsed.navigation2D.zoomSensitivity === 'number') {
          nav2D.zoomSensitivity = parsed.navigation2D.zoomSensitivity;
        }
        if (Object.keys(nav2D).length > 0) {
          result.navigation2D = nav2D as Navigation2DSettings;
        }
      }
      if (isGameAspectRatio(parsed.gameAspectRatio)) {
        result.gameAspectRatio = parsed.gameAspectRatio;
      }
      return result;
    }
    return null;
  } catch {
    return null;
  }
};

const persistEditorSettings = (settings: EditorSettingsSnapshot): void => {
  try {
    localStorage.setItem(EDITOR_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore persistence errors
  }
};

export class UpdateEditorSettingsOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'editor.update-settings',
    title: 'Update Editor Settings',
    description: 'Update editor-level preferences',
    tags: ['editor', 'settings'],
  };

  constructor(private readonly params: UpdateEditorSettingsParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, snapshot } = context;

    const prevWarn = snapshot.ui.warnOnUnsavedUnload;
    const nextWarn = this.params.warnOnUnsavedUnload ?? prevWarn;

    const prevPause = snapshot.ui.pauseRenderingOnUnfocus;
    const nextPause = this.params.pauseRenderingOnUnfocus ?? prevPause;

    const prevNav2D = snapshot.ui.navigation2D;
    const nextNav2D: Navigation2DSettings = {
      panSensitivity: this.params.navigation2D?.panSensitivity ?? prevNav2D.panSensitivity,
      zoomSensitivity: this.params.navigation2D?.zoomSensitivity ?? prevNav2D.zoomSensitivity,
    };

    const prevGameAspectRatio = snapshot.ui.gameAspectRatio;
    const nextGameAspectRatio = this.params.gameAspectRatio ?? prevGameAspectRatio;

    const hasChanges =
      nextWarn !== prevWarn ||
      nextPause !== prevPause ||
      nextNav2D.panSensitivity !== prevNav2D.panSensitivity ||
      nextNav2D.zoomSensitivity !== prevNav2D.zoomSensitivity ||
      nextGameAspectRatio !== prevGameAspectRatio;

    if (!hasChanges) {
      return { didMutate: false };
    }

    state.ui.warnOnUnsavedUnload = nextWarn;
    state.ui.pauseRenderingOnUnfocus = nextPause;
    state.ui.navigation2D = nextNav2D;
    state.ui.gameAspectRatio = nextGameAspectRatio;

    const serialize = (
      w: boolean,
      p: boolean,
      n: Navigation2DSettings,
      g: GameAspectRatio
    ): EditorSettingsSnapshot => ({
      warnOnUnsavedUnload: w,
      pauseRenderingOnUnfocus: p,
      navigation2D: n,
      gameAspectRatio: g,
    });

    persistEditorSettings(serialize(nextWarn, nextPause, nextNav2D, nextGameAspectRatio));

    return {
      didMutate: true,
      commit: {
        label: 'Update Editor Settings',
        undo: async () => {
          state.ui.warnOnUnsavedUnload = prevWarn;
          state.ui.pauseRenderingOnUnfocus = prevPause;
          state.ui.navigation2D = prevNav2D;
          state.ui.gameAspectRatio = prevGameAspectRatio;
          persistEditorSettings(serialize(prevWarn, prevPause, prevNav2D, prevGameAspectRatio));
        },
        redo: async () => {
          state.ui.warnOnUnsavedUnload = nextWarn;
          state.ui.pauseRenderingOnUnfocus = nextPause;
          state.ui.navigation2D = nextNav2D;
          state.ui.gameAspectRatio = nextGameAspectRatio;
          persistEditorSettings(serialize(nextWarn, nextPause, nextNav2D, nextGameAspectRatio));
        },
      },
    };
  }
}
