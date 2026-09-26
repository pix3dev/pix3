import { injectable } from '@/fw/di';
import { appState } from '@/state';
import { sha256 } from '@/services/project/external-merge/hash';
import { toProjectPath } from '@/services/project/coauthoring/coauthoring-paths';
import {
  parseSceneText,
  checkDocShape,
  type MergeDoc,
} from '@/services/project/external-merge/scene-doc';
import { toMergeDoc } from '@/services/project/external-merge/human-operation-diff';

/** What the editor last knew to be on disk for one path. */
export interface KnownDiskVersion {
  /** sha256 of the raw bytes the editor read from or wrote to disk, never a re-serialization. */
  readonly hash: string;
  readonly source: 'read' | 'write';
  /**
   * For editor writes: the protected-set generation the written version contains (every human
   * entry with `gen <= genAtWrite` is in it). Undefined for reads.
   */
  readonly genAtWrite?: number;
  readonly at: number;
}

/** `E` of plan §4.3: the last version the editor wrote or accepted, parsed on first use. */
export interface EditorVersion {
  readonly doc: MergeDoc;
  readonly hash: string;
}

interface EditorVersionEntry {
  readonly text: string;
  readonly hash: string;
  parsed?: MergeDoc | null;
}

/**
 * The editor's memory of scene files on disk (plan §4.3 "E — последняя версия, записанная
 * редактором" and §5 C4 "проверка перед записью"):
 *
 * - `path → { hash, genAtWrite }` of the last version the editor READ (load / reload) or WROTE
 *   (save / autosave). The pre-write check of `SaveSceneOperation` compares the file's current
 *   hash with this and refuses to write over anything else.
 * - the set of paths with a **pending external version**: detected on disk, not applied to the
 *   graph yet (still settling, unparsable, or waiting for play mode to end). Autosave holds those
 *   paths — an autosave over them would clobber the agent's unfinished write.
 *
 * - `E` per path — the text of the last version the editor wrote (save / autosave / merge write-back)
 *   or accepted from disk (load, a reload whose merge result equals the file). Parsed lazily; the
 *   external merge reads it as `editorVersion`.
 * - paths **held for a decision**: a rejected merge left the agent's version on disk and the last
 *   good graph in the editor; until the human picks "accept" or "keep mine" (or a newer version
 *   arrives), autosave must not write over it. `isPendingExternal` covers both sets.
 *
 * Keys are project paths without a scheme (`scenes/a.pix3scene`). Mirrors the pending set into
 * `appState.project.coauthoring.pendingExternalPaths` for the status bar.
 */
@injectable()
export class SceneDiskStateService {
  private readonly known = new Map<string, KnownDiskVersion>();
  private readonly pending = new Set<string>();
  private readonly held = new Set<string>();
  private readonly editorVersions = new Map<string, EditorVersionEntry>();
  private readonly listeners = new Set<() => void>();

  /**
   * Hash `content` (pass the RAW bytes read from disk; a string is hashed as UTF-8) and remember it
   * as the version read from `path`. With `acceptedText`, that text also becomes `E`. Returns the hash.
   */
  async recordRead(
    path: string,
    content: Uint8Array | string,
    acceptedText?: string
  ): Promise<string> {
    const hash = await sha256(content);
    this.recordReadHash(path, hash);
    const text = acceptedText ?? (typeof content === 'string' ? content : undefined);
    if (text !== undefined) {
      this.setEditorVersion(path, text, hash);
    }
    return hash;
  }

  /** Remember `text` (with byte hash `hash`) as `E` of `path`. */
  setEditorVersion(path: string, text: string, hash: string): void {
    this.editorVersions.set(toProjectPath(path), { text, hash });
  }

  /** `E` of `path`, or null when unknown or unparsable. */
  getEditorVersion(path: string): EditorVersion | null {
    const entry = this.editorVersions.get(toProjectPath(path));
    if (!entry) return null;
    if (entry.parsed === undefined) {
      try {
        const doc = parseSceneText(entry.text);
        entry.parsed = checkDocShape(doc).length === 0 ? toMergeDoc(doc) : null;
      } catch {
        entry.parsed = null;
      }
    }
    return entry.parsed ? { doc: structuredClone(entry.parsed), hash: entry.hash } : null;
  }

  getEditorVersionText(path: string): string | null {
    return this.editorVersions.get(toProjectPath(path))?.text ?? null;
  }

  recordReadHash(path: string, hash: string): void {
    this.known.set(toProjectPath(path), { hash, source: 'read', at: Date.now() });
    this.notify();
  }

  /**
   * Remember a version the editor itself wrote (containing human entries up to `genAtWrite`).
   * `text` (what was written) becomes `E`.
   */
  recordWrite(path: string, hash: string, genAtWrite?: number, text?: string): void {
    if (text !== undefined) {
      this.setEditorVersion(path, text, hash);
    }
    this.known.set(toProjectPath(path), {
      hash,
      source: 'write',
      ...(genAtWrite !== undefined ? { genAtWrite } : {}),
      at: Date.now(),
    });
    this.notify();
  }

  getKnown(path: string): KnownDiskVersion | null {
    return this.known.get(toProjectPath(path)) ?? null;
  }

  /** True when `hash` is exactly what the editor last read or wrote at `path` (an own write). */
  isKnownHash(path: string, hash: string): boolean {
    return this.known.get(toProjectPath(path))?.hash === hash;
  }

  forget(path: string): void {
    const key = toProjectPath(path);
    this.known.delete(key);
    this.editorVersions.delete(key);
    this.releaseDecision(key);
    this.clearPendingExternal(key);
  }

  /** A rejected merge waits for the human: autosave holds `path` until {@link releaseDecision}. */
  holdForDecision(path: string): void {
    const key = toProjectPath(path);
    if (!this.held.has(key)) {
      this.held.add(key);
      this.notify();
    }
  }

  releaseDecision(path: string): void {
    if (this.held.delete(toProjectPath(path))) {
      this.notify();
    }
  }

  isHeldForDecision(path: string): boolean {
    return this.held.has(toProjectPath(path));
  }

  markPendingExternal(path: string): void {
    const key = toProjectPath(path);
    if (this.pending.has(key)) {
      return;
    }
    this.pending.add(key);
    this.syncState();
    this.notify();
  }

  clearPendingExternal(path: string): void {
    if (this.pending.delete(toProjectPath(path))) {
      this.syncState();
      this.notify();
    }
  }

  /** An external version is not applied yet: settling, unparsable, or held for a decision. */
  isPendingExternal(path: string): boolean {
    const key = toProjectPath(path);
    return this.pending.has(key) || this.held.has(key);
  }

  getPendingExternalPaths(): string[] {
    return Array.from(this.pending);
  }

  /** Listener runs after any change (known version or pending set). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Forget everything (project closed / switched). */
  reset(): void {
    this.known.clear();
    this.pending.clear();
    this.held.clear();
    this.editorVersions.clear();
    this.syncState();
    this.notify();
  }

  dispose(): void {
    this.known.clear();
    this.pending.clear();
    this.held.clear();
    this.editorVersions.clear();
    this.listeners.clear();
  }

  private syncState(): void {
    appState.project.coauthoring.pendingExternalPaths = Array.from(this.pending);
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch (error) {
        console.error('[SceneDiskStateService] Listener error', error);
      }
    }
  }
}
