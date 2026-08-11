import { injectable } from '@/fw/di';
import { appState } from '@/state';
import type { WorkspaceMode } from '@/state/AppState';

/** Per-project workspace-mode memory, so a reload reopens the shell the user was last in. */
const STORAGE_KEY = 'pix3.workspaceMode:v1';

/** Hash route that forces the prompt-first shell (`#flow`), mirroring `#editor` for Studio. */
export const FLOW_HASH = '#flow';

/**
 * Whether the page was ENTERED at `#flow`, sampled at module load. It cannot be read later: opening
 * a project rewrites the hash (`syncEditorRoute` / `RouterService`) long before the project reaches
 * `ready`, and `set()` rewrites it again — a live read would either miss a `#flow` entry or make
 * every subsequently opened project inherit Flow.
 */
const ENTERED_AT_FLOW_HASH =
  typeof window !== 'undefined' && window.location.hash.startsWith(FLOW_HASH);

const isWorkspaceMode = (value: unknown): value is WorkspaceMode =>
  value === 'flow' || value === 'studio';

const readStore = (): Record<string, WorkspaceMode> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const result: Record<string, WorkspaceMode> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isWorkspaceMode(value)) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
};

/**
 * Owns `appState.ui.workspaceMode`: which shell is on screen (Flow = prompt + stage, Studio = the
 * full docked editor). This is shell routing, not an editing action — like `isLayoutReady` it is
 * written directly rather than through the undo gateway (undoing your way back into another
 * workspace would be nonsense), but every UI entry point goes through
 * `SwitchWorkspaceModeCommand` so the mode still shows up in the menu/command palette.
 *
 * The mode is remembered per project id: a project born in Flow reopens in Flow after a reload,
 * while everything that existed before this feature keeps opening in Studio.
 */
@injectable()
export class WorkspaceModeService {
  private readonly listeners = new Set<(mode: WorkspaceMode) => void>();

  /** Mode chosen while no project was open yet; claimed by the next project that opens. */
  private pendingMode: WorkspaceMode | null = null;

  get(): WorkspaceMode {
    return appState.ui.workspaceMode;
  }

  /**
   * Switch shells. Persists the choice for the current project and keeps the URL hash in step so a
   * reload (or a shared link) lands in the same shell.
   */
  set(mode: WorkspaceMode, options: { persist?: boolean } = {}): void {
    const persist = options.persist ?? true;
    if (persist) {
      this.remember(mode);
    }
    if (appState.ui.workspaceMode === mode) {
      this.syncHash(mode);
      return;
    }
    appState.ui.workspaceMode = mode;
    this.syncHash(mode);
    for (const listener of this.listeners) {
      listener(mode);
    }
  }

  toggle(): void {
    this.set(this.get() === 'flow' ? 'studio' : 'flow');
  }

  subscribe(listener: (mode: WorkspaceMode) => void): () => void {
    this.listeners.add(listener);
    listener(this.get());
    return () => this.listeners.delete(listener);
  }

  /** Remember `mode` for a project id without switching to it (used right after project creation). */
  remember(mode: WorkspaceMode, projectId = appState.project.id): void {
    if (!projectId) {
      // No project yet — this is the prompt-hero path, where Flow is chosen BEFORE the project it
      // will hold exists. Park the choice; the first project to open claims it. Without this the
      // shell resolves the freshly created project to its default (Studio) and throws the user out
      // of Flow the moment their game finishes generating.
      this.pendingMode = mode;
      return;
    }
    try {
      const store = readStore();
      store[projectId] = mode;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      // Persistence is a convenience; the in-memory mode stays authoritative.
    }
  }

  /**
   * Resolve the shell a freshly opened project should land in: an explicit `#flow` hash wins, then
   * the project's remembered mode, else Studio. Called by the shell when a project becomes ready.
   */
  resolveForOpenedProject(projectId: string | null): WorkspaceMode {
    const pending = this.pendingMode;
    if (pending) {
      this.pendingMode = null;
      if (projectId) {
        this.remember(pending, projectId);
      }
      return pending;
    }
    if (ENTERED_AT_FLOW_HASH) {
      return 'flow';
    }
    if (!projectId) return 'studio';
    return readStore()[projectId] ?? 'studio';
  }

  private syncHash(mode: WorkspaceMode): void {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    const query = hash.includes('?') ? `?${hash.split('?')[1]}` : '';
    const next = `${mode === 'flow' ? FLOW_HASH : '#editor'}${query}`;
    if (hash === next) return;
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}${next}`);
  }
}
