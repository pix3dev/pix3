import { injectable } from '@/fw/di';
import type { LlmMessage } from '@/services/llm/LlmTypes';

/** One persisted conversation — the wire-format message history of one agent chat. */
export interface AgentConversationRecord {
  /** Stable conversation id (unique across the whole store). */
  id: string;
  /** Project session id (`appState.project.id`) this conversation belongs to. */
  projectId: string;
  /** Short human label derived from the first user message. */
  title: string;
  messages: LlmMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Lightweight listing entry (no message payload) for the history UI. */
export interface AgentConversationMeta {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/**
 * Persists agent chat history in IndexedDB so conversations survive a page reload. A project can now
 * hold many conversations (keyed by a unique conversation id, indexed by project id) — the "New chat"
 * button starts another one instead of wiping the old. Content is plain JSON (text / tool-use /
 * tool-result blocks); tool images are not persisted.
 *
 * Mirrors the IndexedDB access pattern of {@link import('@/services/image-gen/GenerationHistoryService').GenerationHistoryService}.
 * When IndexedDB is unavailable (tests / private mode quirks) every method degrades to a no-op / empty
 * result and the active conversation lives in memory only. The v1→v2 upgrade migrates the old
 * single-per-project records (keyed by projectId) into the new multi-conversation store.
 */
@injectable()
export class AgentChatHistoryStore {
  private static readonly DB_NAME = 'pix3-agent-chat';
  private static readonly DB_VERSION = 2;
  private static readonly STORE = 'conversations_v2';
  private static readonly LEGACY_STORE = 'conversations';
  private static readonly PROJECT_INDEX = 'by-project';

  static isSupported(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  /** Metadata for every conversation of a project, newest first (message payload omitted). */
  async list(projectId: string): Promise<AgentConversationMeta[]> {
    if (!AgentChatHistoryStore.isSupported() || !projectId) {
      return [];
    }
    const db = await this.openDb();
    try {
      const records = await new Promise<AgentConversationRecord[]>((resolve, reject) => {
        const tx = db.transaction(AgentChatHistoryStore.STORE, 'readonly');
        const index = tx
          .objectStore(AgentChatHistoryStore.STORE)
          .index(AgentChatHistoryStore.PROJECT_INDEX);
        const req = index.getAll(projectId);
        req.onsuccess = () => resolve((req.result as AgentConversationRecord[]) ?? []);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB getAll error'));
      });
      return records
        .map(record => ({
          id: record.id,
          projectId: record.projectId,
          title: record.title,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          messageCount: record.messages?.length ?? 0,
        }))
        .sort((left, right) => right.updatedAt - left.updatedAt);
    } finally {
      db.close();
    }
  }

  async get(id: string): Promise<AgentConversationRecord | undefined> {
    if (!AgentChatHistoryStore.isSupported() || !id) {
      return undefined;
    }
    const db = await this.openDb();
    try {
      return await new Promise<AgentConversationRecord | undefined>((resolve, reject) => {
        const tx = db.transaction(AgentChatHistoryStore.STORE, 'readonly');
        const getReq = tx.objectStore(AgentChatHistoryStore.STORE).get(id);
        getReq.onsuccess = () => resolve(getReq.result as AgentConversationRecord | undefined);
        getReq.onerror = () => reject(getReq.error ?? new Error('IndexedDB get error'));
      });
    } finally {
      db.close();
    }
  }

  async put(record: AgentConversationRecord): Promise<void> {
    if (!AgentChatHistoryStore.isSupported() || !record.id) {
      return;
    }
    // Deep-copy through JSON so IndexedDB never holds references into live state.
    const stored: AgentConversationRecord = {
      ...record,
      messages: JSON.parse(JSON.stringify(record.messages)) as LlmMessage[],
    };
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(AgentChatHistoryStore.STORE, 'readwrite');
        tx.objectStore(AgentChatHistoryStore.STORE).put(stored);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction error'));
      });
    } finally {
      db.close();
    }
  }

  async delete(id: string): Promise<void> {
    if (!AgentChatHistoryStore.isSupported() || !id) {
      return;
    }
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(AgentChatHistoryStore.STORE, 'readwrite');
        tx.objectStore(AgentChatHistoryStore.STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction error'));
      });
    } finally {
      db.close();
    }
  }

  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(
        AgentChatHistoryStore.DB_NAME,
        AgentChatHistoryStore.DB_VERSION
      );
      request.onupgradeneeded = () => {
        const db = request.result;
        const tx = request.transaction;
        if (!db.objectStoreNames.contains(AgentChatHistoryStore.STORE)) {
          const store = db.createObjectStore(AgentChatHistoryStore.STORE, { keyPath: 'id' });
          store.createIndex(AgentChatHistoryStore.PROJECT_INDEX, 'projectId', { unique: false });
        }
        // Migrate v1 single-per-project records into the new multi-conversation store, then drop the
        // legacy store. Best-effort: a migration hiccup must not block opening the DB.
        if (tx && db.objectStoreNames.contains(AgentChatHistoryStore.LEGACY_STORE)) {
          try {
            const legacy = tx.objectStore(AgentChatHistoryStore.LEGACY_STORE);
            const target = tx.objectStore(AgentChatHistoryStore.STORE);
            const cursorReq = legacy.openCursor();
            cursorReq.onsuccess = () => {
              const cursor = cursorReq.result;
              if (cursor) {
                const old = cursor.value as {
                  projectId?: string;
                  messages?: LlmMessage[];
                  updatedAt?: number;
                };
                if (old.projectId) {
                  const at = old.updatedAt ?? 0;
                  target.put({
                    id: `${old.projectId}-legacy`,
                    projectId: old.projectId,
                    title: 'Imported chat',
                    messages: old.messages ?? [],
                    createdAt: at,
                    updatedAt: at,
                  } satisfies AgentConversationRecord);
                }
                cursor.continue();
              } else {
                db.deleteObjectStore(AgentChatHistoryStore.LEGACY_STORE);
              }
            };
          } catch {
            // Ignore migration failures — the new store is already in place.
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open error'));
    });
  }
}
