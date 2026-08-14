/**
 * The reachability journal: which controls a REAL pointer has been proved to reach, kept in the
 * project so the proof outlives the editor session that earned it.
 *
 * Why this exists (plan §5.6.2): a semantic `invoke` exercises everything that happens *after*
 * "the point is inside the control", but it synthesizes the pointer from the control's own
 * transform, so it can never establish that a finger could hit the control at all. Only a physical
 * tap can, and only the control itself is an acceptable witness (`hovering`/`pressed` are set by
 * its own bounds check). That proof used to live in a `Set` in `GameInputService`: it died with the
 * page and — worse — never expired, so a control that had since moved off screen still read
 * `reachable`.
 *
 * A proof is therefore stamped with the **context it was earned in**. If the context changed, the
 * proof burns automatically instead of being remembered by an agent's good will.
 *
 * ## What goes into the context, and why it is split in two
 *
 * The plan names the balance directly: too wide a hash goes stale on every window resize, too
 * narrow a one misses a control that moved. Two different kinds of fact need two different
 * comparisons, so the record keeps them apart:
 *
 * - **Discrete facts, compared exactly** — scene, ancestor chain, hidden ancestors, `visible`,
 *   `enabled`, whether the control has collapsed to nothing, and the single *normalized* fact that
 *   stands in for viewport + DPR + canvas size + camera/projection: **does the control land inside
 *   the frame**. That normalization is the whole trick. The runtime's 2D camera is an *expand*
 *   camera (`SceneRunner`: the logical camera grows with the viewport aspect), so the pixel — and
 *   even the normalized 0..1 — position of a fixed world point genuinely moves when the window is
 *   resized. Hashing pixels, DPR or camera numbers would burn every proof on every resize; hashing
 *   frame membership burns a proof exactly when the resize actually pushed the control out of
 *   reach. These fields are what {@link contextHash} digests.
 * - **Continuous facts, compared with a tolerance** — world position, size, ancestor scroll
 *   offsets. Quantizing them onto a grid instead would flap at cell boundaries, and — the case that
 *   really matters — the context is captured *during the tap*, while the control is pressed, so any
 *   hover/press/bob animation would invalidate the proof one frame after earning it. A tolerance
 *   has neither problem: a 4 px idle bob keeps the proof, a control that moved across the screen
 *   loses it.
 *
 * Transient `scale` is deliberately **not** in the context (it is animation state, not layout — a
 * PunchScale would burn every proof); a control scaled or sized down to nothing is caught by the
 * discrete `collapsed` flag instead.
 */

import { ServiceContainer } from '@/fw/di';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';

/** Where the journal lives inside the project. The project templates ship an empty one. */
export const REACHABILITY_JOURNAL_PATH = 'design/tests/reachability.json';

/** File format version. A file carrying anything else is not ours and is not merged. */
export const REACHABILITY_JOURNAL_VERSION = 1;

/**
 * How far a control may drift and keep its proof, in world (design) units. Sized to absorb idle
 * bobs and press offsets, not relocation: a button that moved a tenth of a 1080-unit screen burns.
 */
export const POSITION_TOLERANCE = 8;

/** How far an ancestor scroll container may have scrolled, in the same units. */
export const SCROLL_TOLERANCE = 8;

/** How much the control's own size may differ, relative. Absorbs juice, not a relayout. */
export const SIZE_TOLERANCE_RATIO = 0.15;

/** Most proofs kept in the file; the oldest are dropped first. */
export const MAX_JOURNAL_ENTRIES = 500;

/** Whether the control projects inside the canvas — the normalized stand-in for the whole view. */
export type ReachFrame = 'in' | 'out' | 'unknown';

/** The context a reach proof was earned in. See the module comment for the two-part comparison. */
export interface ReachContext {
  /** Ancestor node ids, root first, joined with '>'. Catches reparenting and scene swaps. */
  ancestors: string;
  /** Ids of ancestors whose `visible` is false, root first. Empty when the chain is shown. */
  hiddenAncestors: string;
  /** The control's own `visible`. */
  visible: boolean;
  /** The control's own `enabled`, or null for a node that has none (a scripted clickable object). */
  enabled: boolean | null;
  /** True when world scale or authored size has collapsed to (near) nothing. */
  collapsed: boolean;
  /** Normalized viewport/DPR/canvas/camera: does it land in the frame at all. */
  frame: ReachFrame;
  /** World position, rounded to 0.1 units. Compared with {@link POSITION_TOLERANCE}. */
  world: [number, number, number];
  /** Authored width/height when the node exposes them, else null. Compared relatively. */
  size: [number, number] | null;
  /** Scroll offset of each ancestor scroll container, root first. Compared with a tolerance. */
  scroll: number[];
}

/** One proved control, as stored in `design/tests/reachability.json`. */
export interface ReachProof {
  nodeId: string;
  /** Human aid only — never compared, so renaming a control does not burn its proof. */
  name: string;
  /**
   * The scene the proof is filed under — in practice `appState.scenes.activeSceneId`,
   * which is the scene play STARTED from.
   *
   * Known imprecision, recorded rather than papered over: a game that calls
   * `scene.changeScene()` mid-run keeps proving controls under the starting id,
   * because the runtime's live graph is private to `SceneRunner` (`runtimeGraph`)
   * and `SceneGraph` carries no id of its own, so there is nothing cheap to read
   * the true id from. It cannot manufacture a false proof — the ancestor chain in
   * {@link ReachContext} is compared exactly, and a control from another scene has
   * a different chain — but it does mean two scenes can share one namespace here,
   * so a stale proof survives slightly longer than it should. Fixing it properly
   * means a public "id of the running graph" on `SceneRunner` plus threading it
   * through the harness.
   */
  sceneId: string;
  /** Digest of the discrete half of {@link context}. Stable id for logs and diffs. */
  hash: string;
  context: ReachContext;
  /** ISO timestamp of the physical interaction that earned it. */
  provenAt: string;
}

/** Journal keyed by scene + node: node ids are unique inside a scene, not across scenes. */
export const proofKey = (sceneId: string, nodeId: string): string => `${sceneId}::${nodeId}`;

const round = (value: number, decimals = 1): number => {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * FNV-1a over the canonical form of the discrete fields. Not a security digest — a short, stable,
 * dependency-free id for "the same layout situation", readable in a diff of the journal file.
 */
export const contextHash = (context: ReachContext, sceneId: string): string => {
  const canonical = [
    sceneId,
    context.ancestors,
    context.hiddenAncestors,
    context.visible ? 'v1' : 'v0',
    context.enabled === null ? 'e-' : context.enabled ? 'e1' : 'e0',
    context.collapsed ? 'c1' : 'c0',
    context.frame,
  ].join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/** Normalize a raw context into the stored (rounded) shape. */
export const normalizeContext = (context: ReachContext): ReachContext => ({
  ancestors: context.ancestors,
  hiddenAncestors: context.hiddenAncestors,
  visible: context.visible,
  enabled: context.enabled,
  collapsed: context.collapsed,
  frame: context.frame,
  world: [round(context.world[0]), round(context.world[1]), round(context.world[2])],
  size: context.size ? [round(context.size[0]), round(context.size[1])] : null,
  scroll: context.scroll.map(value => round(value)),
});

const describeAncestorChange = (recorded: string, current: string): string => {
  if (!recorded) return `it had no ancestors, now it sits under "${current}"`;
  if (!current) return `it sat under "${recorded}", now it has no ancestors`;
  return `its ancestor chain changed ("${recorded}" → "${current}")`;
};

/**
 * Does a recorded proof still hold in the current context? On a mismatch the reason is a sentence,
 * because "the hash did not match" is exactly the silence this journal exists to remove — knowing
 * *why* a proof burned (it moved / a parent got hidden / it left the frame) is the most useful
 * signal the whole mechanism produces.
 */
export const compareReachContext = (
  recorded: ReachContext,
  current: ReachContext
): { matches: true } | { matches: false; reason: string } => {
  const no = (reason: string): { matches: false; reason: string } => ({ matches: false, reason });

  if (recorded.ancestors !== current.ancestors) {
    return no(describeAncestorChange(recorded.ancestors, current.ancestors));
  }
  if (recorded.hiddenAncestors !== current.hiddenAncestors) {
    return no(
      current.hiddenAncestors
        ? `an ancestor is hidden now ("${current.hiddenAncestors}")`
        : 'the ancestors that were hidden then are shown now'
    );
  }
  if (recorded.visible !== current.visible) {
    return no(current.visible ? 'it was hidden when proved' : 'its own visible is false now');
  }
  if (recorded.enabled !== current.enabled) {
    return no(
      current.enabled === false
        ? 'it was enabled when proved and is disabled now'
        : `its enabled state changed (${String(recorded.enabled)} → ${String(current.enabled)})`
    );
  }
  if (recorded.collapsed !== current.collapsed) {
    return no(
      current.collapsed
        ? 'it has collapsed to (near) zero size since'
        : 'it was collapsed when proved and has a size now'
    );
  }
  if (recorded.frame !== current.frame) {
    return no(
      current.frame === 'in'
        ? `it was ${recorded.frame === 'out' ? 'outside the frame' : 'unprojectable'} when proved`
        : current.frame === 'out'
          ? 'it projected inside the frame then and outside it now'
          : 'it cannot be projected at all now'
    );
  }
  for (let axis = 0; axis < 3; axis++) {
    const drift = Math.abs(recorded.world[axis] - current.world[axis]);
    if (drift > POSITION_TOLERANCE) {
      return no(
        `it moved: world ${recorded.world[0]},${recorded.world[1]} → ${current.world[0]},${current.world[1]}`
      );
    }
  }
  if ((recorded.size === null) !== (current.size === null)) {
    return no('it stopped (or started) reporting a size');
  }
  if (recorded.size && current.size) {
    for (let axis = 0; axis < 2; axis++) {
      const was = recorded.size[axis];
      const now = current.size[axis];
      const scale = Math.max(Math.abs(was), Math.abs(now), 1);
      if (Math.abs(was - now) / scale > SIZE_TOLERANCE_RATIO) {
        return no(
          `it was resized: ${recorded.size[0]}x${recorded.size[1]} → ${current.size[0]}x${current.size[1]}`
        );
      }
    }
  }
  if (recorded.scroll.length !== current.scroll.length) {
    return no('the scroll containers around it changed');
  }
  for (let i = 0; i < recorded.scroll.length; i++) {
    if (Math.abs(recorded.scroll[i] - current.scroll[i]) > SCROLL_TOLERANCE) {
      return no(
        `a scroll container around it scrolled (${recorded.scroll[i]} → ${current.scroll[i]})`
      );
    }
  }
  return { matches: true };
};

// ---------------------------------------------------------------------------
// File shape
// ---------------------------------------------------------------------------

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const parseContext = (value: unknown): ReachContext | null => {
  const raw = value as Partial<ReachContext> | null;
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.visible !== 'boolean' || typeof raw.collapsed !== 'boolean') return null;
  if (raw.enabled !== null && typeof raw.enabled !== 'boolean') return null;
  if (raw.frame !== 'in' && raw.frame !== 'out' && raw.frame !== 'unknown') return null;
  if (typeof raw.ancestors !== 'string' || typeof raw.hiddenAncestors !== 'string') return null;
  if (!Array.isArray(raw.world) || raw.world.length !== 3 || !raw.world.every(isFiniteNumber)) {
    return null;
  }
  if (raw.size !== null) {
    if (!Array.isArray(raw.size) || raw.size.length !== 2 || !raw.size.every(isFiniteNumber)) {
      return null;
    }
  }
  if (!Array.isArray(raw.scroll) || !raw.scroll.every(isFiniteNumber)) return null;
  return {
    ancestors: raw.ancestors,
    hiddenAncestors: raw.hiddenAncestors,
    visible: raw.visible,
    enabled: raw.enabled ?? null,
    collapsed: raw.collapsed,
    frame: raw.frame,
    world: [raw.world[0], raw.world[1], raw.world[2]],
    size: raw.size ? [raw.size[0], raw.size[1]] : null,
    scroll: [...raw.scroll],
  };
};

/**
 * Read a journal file. A missing, unreadable, foreign or wrong-version file is **not** an error
 * that stops the tool: the caller starts from an empty journal and is told so, because the cost of
 * a lost proof is one extra tap while the cost of a thrown tool call is the whole run.
 *
 * Individually broken entries are dropped and counted, so one bad record does not discard the rest.
 */
export const parseJournal = (
  text: string
): { proofs: ReachProof[]; reset?: string; droppedEntries?: number } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      proofs: [],
      reset: `it is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const file = parsed as { version?: unknown; proven?: unknown } | null;
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    return { proofs: [], reset: 'its top level is not an object' };
  }
  if (file.version !== REACHABILITY_JOURNAL_VERSION) {
    return {
      proofs: [],
      reset: `its version is ${JSON.stringify(file.version)}, not ${REACHABILITY_JOURNAL_VERSION}`,
    };
  }
  if (!Array.isArray(file.proven)) {
    return { proofs: [], reset: '`proven` is not an array' };
  }
  const proofs: ReachProof[] = [];
  let dropped = 0;
  for (const entry of file.proven) {
    const raw = entry as Partial<ReachProof> | null;
    const context = raw ? parseContext(raw.context) : null;
    if (
      !raw ||
      typeof raw.nodeId !== 'string' ||
      !raw.nodeId ||
      typeof raw.sceneId !== 'string' ||
      !context
    ) {
      dropped++;
      continue;
    }
    proofs.push({
      nodeId: raw.nodeId,
      name: typeof raw.name === 'string' ? raw.name : '',
      sceneId: raw.sceneId,
      hash: typeof raw.hash === 'string' ? raw.hash : contextHash(context, raw.sceneId),
      context,
      provenAt: typeof raw.provenAt === 'string' ? raw.provenAt : new Date(0).toISOString(),
    });
  }
  return { proofs, ...(dropped ? { droppedEntries: dropped } : {}) };
};

/** Serialize, newest last and capped, in the shape the project templates ship. */
export const serializeJournal = (proofs: readonly ReachProof[]): string => {
  const ordered = [...proofs].sort((a, b) => a.provenAt.localeCompare(b.provenAt));
  const capped = ordered.slice(Math.max(0, ordered.length - MAX_JOURNAL_ENTRIES));
  return `${JSON.stringify({ version: REACHABILITY_JOURNAL_VERSION, proven: capped }, null, 2)}\n`;
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Where the journal is kept. The production backend is the open project, reached through the same
 * `ProjectStorageService` every other project write goes through (so a directory-handle project,
 * an OPFS browser project and a cloud project are all served without this module knowing which).
 * A spec hands in {@link InMemoryReachabilityStore} instead — which is also how "the proof survives
 * a reload" is testable: build a second service over the same store.
 */
export interface ReachabilityStore {
  /** File contents, or null when there is no file (or no project at all). */
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export class InMemoryReachabilityStore implements ReachabilityStore {
  constructor(private text: string | null = null) {}

  async read(): Promise<string | null> {
    return this.text;
  }

  async write(text: string): Promise<void> {
    this.text = text;
  }

  /** Test aid: what a reader would see right now. */
  peek(): string | null {
    return this.text;
  }
}

/** The real backend: `design/tests/reachability.json` inside the open project. */
export class ProjectFileReachabilityStore implements ReachabilityStore {
  private storage(): ProjectStorageService {
    const container = ServiceContainer.getInstance();
    return container.getService<ProjectStorageService>(
      container.getOrCreateToken(ProjectStorageService)
    );
  }

  async read(): Promise<string | null> {
    try {
      return await this.storage().readTextFile(REACHABILITY_JOURNAL_PATH);
    } catch {
      // Missing file, no project open, no permission — all "nothing proved yet" as far as the
      // journal is concerned. A hard failure here would take `game_controls` down with it.
      return null;
    }
  }

  async write(text: string): Promise<void> {
    const storage = this.storage();
    try {
      await storage.writeTextFile(REACHABILITY_JOURNAL_PATH, text);
    } catch (error) {
      // The one recoverable case: the project predates `design/tests/` (only newer templates ship
      // it). Create it once and retry; anything else is reported to the caller.
      try {
        await storage.createDirectory('design/tests');
      } catch {
        throw error;
      }
      await storage.writeTextFile(REACHABILITY_JOURNAL_PATH, text);
    }
  }
}
