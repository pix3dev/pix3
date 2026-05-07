import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { CodeDocumentService } from '@/services/CodeDocumentService';
import { appState, resetAppState, type EditorTab } from '@/state';

type MonacoSelectionLike = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

type EditorStub = {
  dispose: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  getScrollLeft: ReturnType<typeof vi.fn>;
  getScrollTop: ReturnType<typeof vi.fn>;
  getSelection: ReturnType<typeof vi.fn>;
  layout: ReturnType<typeof vi.fn>;
  onDidBlurEditorText: ReturnType<typeof vi.fn>;
  onDidChangeCursorSelection: ReturnType<typeof vi.fn>;
  onDidScrollChange: ReturnType<typeof vi.fn>;
  restoreViewState: ReturnType<typeof vi.fn>;
  saveViewState: ReturnType<typeof vi.fn>;
  setScrollLeft: ReturnType<typeof vi.fn>;
  setScrollTop: ReturnType<typeof vi.fn>;
  setSelection: ReturnType<typeof vi.fn>;
};

type ModelStub = {
  dispose: ReturnType<typeof vi.fn>;
  getValue: ReturnType<typeof vi.fn>;
  onDidChangeContent: ReturnType<typeof vi.fn>;
  setValue: ReturnType<typeof vi.fn>;
};

type CodeTabElement = HTMLElementTagNameMap['pix3-code-tab'] & {
  updateComplete?: Promise<unknown>;
};

const createdEditors: EditorStub[] = [];

let monacoMock: {
  editor: {
    create: ReturnType<typeof vi.fn>;
    createModel: ReturnType<typeof vi.fn>;
  };
  Selection: new (
    startLineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number
  ) => MonacoSelectionLike;
  Uri: {
    parse: (value: string) => string;
  };
};

vi.mock('./monaco-loader', () => ({
  ensureMonacoLoaded: vi.fn(async () => monacoMock),
}));

await import('./code-tab');

class CodeDocumentServiceStub {
  private readonly documents = new Map<
    string,
    {
      resourcePath: string;
      language: 'typescript' | 'javascript' | 'json';
      text: string;
      savedText: string;
      isDirty: boolean;
      lastModifiedTime: number | null;
    }
  >();

  private readonly listeners = new Map<
    string,
    Set<
      (event: {
        resourcePath: string;
        reason: 'load' | 'change' | 'save' | 'reload' | 'external-change';
        snapshot: {
          resourcePath: string;
          language: 'typescript' | 'javascript' | 'json';
          text: string;
          savedText: string;
          isDirty: boolean;
          lastModifiedTime: number | null;
        };
      }) => void
    >
  >();

  async ensureLoaded(resourcePath: string) {
    const existing = this.documents.get(resourcePath);
    if (existing) {
      return existing;
    }

    const snapshot = {
      resourcePath,
      language: resourcePath.endsWith('.json')
        ? 'json'
        : resourcePath.endsWith('.js')
          ? 'javascript'
          : 'typescript',
      text: `// ${resourcePath}`,
      savedText: `// ${resourcePath}`,
      isDirty: false,
      lastModifiedTime: 1,
    } as const;

    this.documents.set(resourcePath, snapshot);
    return snapshot;
  }

  subscribe(
    resourcePath: string,
    listener: (event: {
      resourcePath: string;
      reason: 'load' | 'change' | 'save' | 'reload' | 'external-change';
      snapshot: {
        resourcePath: string;
        language: 'typescript' | 'javascript' | 'json';
        text: string;
        savedText: string;
        isDirty: boolean;
        lastModifiedTime: number | null;
      };
    }) => void
  ): () => void {
    let bucket = this.listeners.get(resourcePath);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(resourcePath, bucket);
    }

    bucket.add(listener);
    return () => {
      const current = this.listeners.get(resourcePath);
      current?.delete(listener);
      if (current && current.size === 0) {
        this.listeners.delete(resourcePath);
      }
    };
  }
}

beforeEach(() => {
  resetAppState();
  createdEditors.length = 0;
  monacoMock = createMonacoMock();

  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      disconnect(): void {}
      observe(): void {}
      unobserve(): void {}
    } as typeof ResizeObserver;
  }

  const container = ServiceContainer.getInstance();
  container.addService(
    container.getOrCreateToken(CodeDocumentService),
    CodeDocumentServiceStub,
    'singleton'
  );
});

afterEach(() => {
  document.body.innerHTML = '';
  resetAppState();
  vi.restoreAllMocks();
});

describe('CodeTabComponent', () => {
  it('persists view state on deactivation and ignores unrelated tab state changes', async () => {
    const firstTab = createCodeTab('res://scripts/alpha.ts');
    appState.tabs.tabs = [firstTab];
    appState.tabs.activeTabId = firstTab.id;

    const firstElement = document.createElement('pix3-code-tab') as CodeTabElement;
    firstElement.setAttribute('tab-id', firstTab.id);
    document.body.appendChild(firstElement);

    await vi.waitFor(() => {
      expect(createdEditors).toHaveLength(1);
    });

    const secondTab = createCodeTab('res://scripts/beta.ts');
    appState.tabs.tabs = [...appState.tabs.tabs, secondTab];
    appState.tabs.activeTabId = secondTab.id;

    const secondElement = document.createElement('pix3-code-tab') as CodeTabElement;
    secondElement.setAttribute('tab-id', secondTab.id);
    document.body.appendChild(secondElement);

    await vi.waitFor(() => {
      expect(createdEditors).toHaveLength(2);
    });

    expect(appState.tabs.tabs[0]?.contextState?.codeEditor).toEqual({
      monacoViewState: { viewState: 'saved' },
      scrollTop: 0,
      scrollLeft: 0,
      selection: {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      },
    });

    const activeEditor = createdEditors[1];
    const focusCallCount = activeEditor.focus.mock.calls.length;
    const layoutCallCount = activeEditor.layout.mock.calls.length;

    appState.tabs.tabs = appState.tabs.tabs.map(tab =>
      tab.id === secondTab.id
        ? {
            ...tab,
            title: '*beta.ts',
            isDirty: true,
          }
        : tab
    );

    await Promise.resolve();

    expect(activeEditor.focus).toHaveBeenCalledTimes(focusCallCount);
    expect(activeEditor.layout).toHaveBeenCalledTimes(layoutCallCount);
  });
});

function createCodeTab(resourceId: string): EditorTab {
  const title = resourceId.split('/').at(-1) ?? resourceId;
  return {
    id: `code:${resourceId}`,
    resourceId,
    type: 'code',
    title,
    isDirty: false,
    contextState: {},
  };
}

function createMonacoMock(): {
  editor: {
    create: ReturnType<typeof vi.fn>;
    createModel: ReturnType<typeof vi.fn>;
  };
  Selection: new (
    startLineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number
  ) => MonacoSelectionLike;
  Uri: {
    parse: (value: string) => string;
  };
} {
  class Selection implements MonacoSelectionLike {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number
    ) {}
  }

  const createModel = vi.fn((initialText: string): ModelStub => {
    let value = initialText;
    const listeners = new Set<() => void>();

    return {
      dispose: vi.fn(),
      getValue: vi.fn(() => value),
      onDidChangeContent: vi.fn(listener => {
        listeners.add(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      }),
      setValue: vi.fn(nextValue => {
        value = nextValue;
        for (const listener of listeners) {
          listener();
        }
      }),
    };
  });

  const create = vi.fn((): EditorStub => {
    const selection = new Selection(1, 1, 1, 1);
    const editor: EditorStub = {
      dispose: vi.fn(),
      focus: vi.fn(),
      getScrollLeft: vi.fn(() => 0),
      getScrollTop: vi.fn(() => 0),
      getSelection: vi.fn(() => selection),
      layout: vi.fn(),
      onDidBlurEditorText: vi.fn(() => ({ dispose: () => undefined })),
      onDidChangeCursorSelection: vi.fn(() => ({ dispose: () => undefined })),
      onDidScrollChange: vi.fn(() => ({ dispose: () => undefined })),
      restoreViewState: vi.fn(),
      saveViewState: vi.fn(() => ({ viewState: 'saved' })),
      setScrollLeft: vi.fn(),
      setScrollTop: vi.fn(),
      setSelection: vi.fn(),
    };

    createdEditors.push(editor);
    return editor;
  });

  return {
    editor: {
      create,
      createModel,
    },
    Selection,
    Uri: {
      parse: (value: string) => value,
    },
  };
}