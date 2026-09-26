/**
 * In-memory stand-in for the parts of `ProjectStorageService` the co-authoring services use.
 * Spec helper only (never imported by editor code).
 */
import type { FileDescriptor } from '@/services/project/FileSystemAPIService';
import type { StorageBackendKind } from '@/services/project/ProjectStorageService';

export class MemoryStorage {
  readonly files = new Map<string, string>();
  /** Raw bytes that override `files` for a path (e.g. a BOM the text view hides). */
  readonly bytes = new Map<string, Uint8Array>();
  backend: StorageBackendKind = 'local';
  /** Paths (prefixes) whose writes throw, e.g. a read-only `.pix3/`. */
  readonly failWrites = new Set<string>();
  readonly writes: Array<{ path: string; contents: string }> = [];

  private key(path: string): string {
    return path.replace(/^res:\/\//, '').replace(/^\/+/, '');
  }

  getBackend(): StorageBackendKind {
    return this.backend;
  }

  async readTextFile(path: string): Promise<string> {
    const raw = this.bytes.get(this.key(path));
    if (raw) return new TextDecoder('utf-8').decode(raw);
    const value = this.files.get(this.key(path));
    if (value === undefined) throw new Error(`not found: ${path}`);
    return value;
  }

  async readBlob(path: string): Promise<Blob> {
    const key = this.key(path);
    const raw = this.bytes.get(key);
    if (raw) return new Blob([new Uint8Array(raw)]);
    const value = this.files.get(key);
    if (value === undefined) throw new Error(`not found: ${path}`);
    return new Blob([new TextEncoder().encode(value)]);
  }

  /** Put raw bytes at `path` (the text view decodes them, dropping a BOM). */
  setBytes(path: string, bytes: Uint8Array): void {
    const key = this.key(path);
    this.bytes.set(key, bytes);
    this.files.set(key, new TextDecoder('utf-8').decode(bytes));
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    const key = this.key(path);
    for (const prefix of this.failWrites) {
      if (key.startsWith(prefix)) throw new Error(`write refused: ${path}`);
    }
    this.files.set(key, contents);
    this.bytes.delete(key);
    this.writes.push({ path: key, contents });
  }

  async fileExists(path: string): Promise<boolean> {
    return this.files.has(this.key(path));
  }

  async deleteEntry(path: string): Promise<void> {
    const key = this.key(path);
    for (const file of Array.from(this.files.keys())) {
      if (file === key || file.startsWith(`${key}/`)) {
        this.files.delete(file);
        this.bytes.delete(file);
      }
    }
  }

  async listDirectory(path = '.'): Promise<FileDescriptor[]> {
    const dir = path === '.' ? '' : `${this.key(path)}/`;
    const out = new Map<string, FileDescriptor>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(dir)) continue;
      const rest = file.slice(dir.length);
      const [head, ...tail] = rest.split('/');
      const childPath = `${dir}${head}`;
      out.set(childPath, {
        name: head,
        kind: tail.length > 0 ? 'directory' : 'file',
        path: childPath,
        size: null,
      });
    }
    if (out.size === 0 && dir !== '') throw new Error(`no directory ${path}`);
    return Array.from(out.values());
  }
}

/** Replace `@inject` getters on an instance with fixed values. */
export function wire<T extends object>(target: T, deps: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(deps)) {
    Object.defineProperty(target, key, { value, configurable: true, writable: true });
  }
  return target;
}
