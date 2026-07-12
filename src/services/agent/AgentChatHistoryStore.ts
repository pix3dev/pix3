import { injectable } from '@/fw/di';
import type { LlmMessage } from '@/services/llm/LlmTypes';

/** One persisted conversation — the wire-format message history of a project's agent chat. */
export interface AgentConversationRecord {
  /** Project session id (`appState.project.id`) — one active conversation per project. */
  projectId: string;
  messages: LlmMessage[];
  updatedAt: number;
}

/**
 * Persists the agent chat history in IndexedDB so the conversation survives a page reload. Keyed by
 * project id — one active conversation per project (no branches/multiple chats in MVP). Content is
 * plain JSON (text / tool-use / tool-result blocks); deferred image tools would need Blob handling.
 *
 * Mirrors the IndexedDB access pattern of {@link import('../GenerationHistoryService').GenerationHistoryService}.
 * When IndexedDB is unavailable (tests / private mode quirks) every method degrades to a no-op and
 * the conversation lives in memory only.
 */
@injectable()
export class AgentChatHistoryStore {
  private static readonly DB_NAME = 'pix3-agent-chat';
  private static readonly DB_VERSION = 1;
  private static readonly STORE = 'conversations';

  static isSupported(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  async get(projectId: string): Promise<AgentConversationRecord | undefined> {
    if (!AgentChatHistoryStore.isSupported() || !projectId) {
      return undefined;
    }
    const db = await this.openDb();
    try {
      return await new Promise<AgentConversationRecord | undefined>((resolve, reject) => {
        const tx = db.transaction(AgentChatHistoryStore.STORE, 'readonly');
        const getReq = tx.objectStore(AgentChatHistoryStore.STORE).get(projectId);
        getReq.onsuccess = () => resolve(getReq.result as AgentConversationRecord | undefined);
        getReq.onerror = () => reject(getReq.error ?? new Error('IndexedDB get error'));
      });
    } finally {
      db.close();
    }
  }

  async put(projectId: string, messages: readonly LlmMessage[]): Promise<void> {
    if (!AgentChatHistoryStore.isSupported() || !projectId) {
      return;
    }
    const record: AgentConversationRecord = {
      projectId,
      // Deep-copy through JSON so IndexedDB never holds references into live state.
      messages: JSON.parse(JSON.stringify(messages)) as LlmMessage[],
      updatedAt: Date.now(),
    };
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(AgentChatHistoryStore.STORE, 'readwrite');
        tx.objectStore(AgentChatHistoryStore.STORE).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction error'));
      });
    } finally {
      db.close();
    }
  }

  async delete(projectId: string): Promise<void> {
    if (!AgentChatHistoryStore.isSupported() || !projectId) {
      return;
    }
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(AgentChatHistoryStore.STORE, 'readwrite');
        tx.objectStore(AgentChatHistoryStore.STORE).delete(projectId);
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
        if (!db.objectStoreNames.contains(AgentChatHistoryStore.STORE)) {
          db.createObjectStore(AgentChatHistoryStore.STORE, { keyPath: 'projectId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open error'));
    });
  }
}
