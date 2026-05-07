import { customElement, html, inject, property, state, ComponentBase } from '@/fw';
import { appState, type CodeEditorContextState, type CodeEditorSelectionState } from '@/state';
import { subscribe } from 'valtio/vanilla';
import { CodeDocumentService } from '@/services/CodeDocumentService';
import './code-tab.ts.css';
import { ensureMonacoLoaded } from './monaco-loader';

type MonacoApi = typeof import('monaco-editor');
type MonacoEditor = import('monaco-editor').editor.IStandaloneCodeEditor;
type MonacoModel = import('monaco-editor').editor.ITextModel;
type MonacoViewState = import('monaco-editor').editor.ICodeEditorViewState;
type MonacoSelection = import('monaco-editor').Selection;
type MonacoDisposable = import('monaco-editor').IDisposable;

@customElement('pix3-code-tab')
export class CodeTabComponent extends ComponentBase {
  @inject(CodeDocumentService)
  private readonly codeDocumentService!: CodeDocumentService;

  @property({ type: String, reflect: true, attribute: 'tab-id' })
  tabId = '';

  @state()
  private status: 'idle' | 'loading' | 'ready' | 'error' = 'idle';

  @state()
  private errorMessage: string | null = null;

  private disposeTabsSubscription?: () => void;
  private disposeDocumentSubscription?: () => void;
  private editorHost?: HTMLElement;
  private resizeObserver?: ResizeObserver;
  private monaco?: MonacoApi;
  private editor?: MonacoEditor;
  private model?: MonacoModel;
  private modelContentListener?: MonacoDisposable;
  private editorStateListeners: MonacoDisposable[] = [];
  private activeResourcePath: string | null = null;
  private isApplyingExternalUpdate = false;
  private wasActive = false;
  private initializeEditorPromise: Promise<void> | null = null;
  private initializeEditorResourcePath: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeTabsSubscription = subscribe(appState.tabs, () => {
      void this.syncFromTabState();
    });
  }

  disconnectedCallback(): void {
    this.disposeTabsSubscription?.();
    this.disposeTabsSubscription = undefined;
    this.disposeDocumentSubscription?.();
    this.disposeDocumentSubscription = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.wasActive = false;
    this.disposeEditor();
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.editorHost = this.querySelector<HTMLElement>('[data-role="editor-host"]') ?? undefined;
    if (this.editorHost) {
      this.resizeObserver = new ResizeObserver(() => {
        this.editor?.layout();
      });
      this.resizeObserver.observe(this.editorHost);
    }
    void this.syncFromTabState();
  }

  protected updated(changedProperties: Map<PropertyKey, unknown>): void {
    if (changedProperties.has('tabId')) {
      void this.syncFromTabState();
    }
  }

  protected render() {
    return html`
      <section class="code-tab" data-state=${this.status}>
        ${this.status === 'error'
          ? html`
              <div class="placeholder">
                <div class="placeholder__title">Unable to open file</div>
                <div class="placeholder__body">${this.errorMessage ?? 'Unknown error'}</div>
              </div>
            `
          : null}
        ${this.status !== 'ready' && this.status !== 'error'
          ? html`
              <div class="placeholder">
                <div class="placeholder__title">Preparing code editor</div>
                <div class="placeholder__body">
                  Monaco loads only when a code tab becomes active, so the main editor can start
                  lighter.
                </div>
                <div class="placeholder__lines">
                  <div class="placeholder__line"></div>
                  <div class="placeholder__line"></div>
                  <div class="placeholder__line"></div>
                </div>
              </div>
            `
          : null}
        <div
          class="editor-host"
          data-role="editor-host"
          style=${this.status === 'ready' ? '' : 'display:none;'}
        ></div>
      </section>
    `;
  }

  private async syncFromTabState(): Promise<void> {
    const tab = appState.tabs.tabs.find(candidate => candidate.id === this.tabId);
    if (!tab || tab.type !== 'code') {
      return;
    }

    const isActive = appState.tabs.activeTabId === tab.id;
    const resourcePath = tab.resourceId;
    const resourceChanged = this.activeResourcePath !== resourcePath;
    const activeStateChanged = this.wasActive !== isActive;

    this.wasActive = isActive;

    if (resourceChanged) {
      this.activeResourcePath = resourcePath;
      this.disposeDocumentSubscription?.();
      this.disposeDocumentSubscription = this.codeDocumentService.subscribe(resourcePath, event => {
        void this.handleDocumentEvent(event.snapshot.text, event.reason);
      });
    }

    if (!resourceChanged && !activeStateChanged && this.status !== 'idle') {
      return;
    }

    if (!isActive) {
      if (activeStateChanged) {
        this.persistViewState();
      }
      return;
    }

    if (!this.editor || resourceChanged) {
      await this.ensureEditorInitialized(resourcePath);
      return;
    }

    if (activeStateChanged) {
      this.restoreViewState();
    }

    this.editor.focus();
    this.editor.layout();
  }

  private async ensureEditorInitialized(resourcePath: string): Promise<void> {
    if (this.initializeEditorPromise && this.initializeEditorResourcePath === resourcePath) {
      await this.initializeEditorPromise;
      return;
    }

    this.initializeEditorResourcePath = resourcePath;
    this.initializeEditorPromise = this.initializeEditor(resourcePath).finally(() => {
      if (this.initializeEditorResourcePath === resourcePath) {
        this.initializeEditorPromise = null;
      }
    });

    await this.initializeEditorPromise;
  }

  private async initializeEditor(resourcePath: string): Promise<void> {
    if (!this.editorHost) {
      return;
    }

    this.status = 'loading';
    this.errorMessage = null;

    try {
      const [monaco, snapshot] = await Promise.all([
        ensureMonacoLoaded(),
        this.codeDocumentService.ensureLoaded(resourcePath),
      ]);

      this.monaco = monaco;
      this.disposeEditor();

      this.model = monaco.editor.createModel(
        snapshot.text,
        snapshot.language,
        monaco.Uri.parse(resourcePath)
      );

      this.modelContentListener = this.model.onDidChangeContent(() => {
        if (this.isApplyingExternalUpdate) {
          return;
        }
        void this.codeDocumentService.updateContent(resourcePath, this.model?.getValue() ?? '');
      });

      this.editor = monaco.editor.create(this.editorHost, {
        automaticLayout: false,
        minimap: { enabled: true },
        model: this.model,
        scrollBeyondLastLine: false,
        theme: 'vs-dark',
        tabSize: 2,
        insertSpaces: true,
      });

      this.editorStateListeners = [
        this.editor.onDidBlurEditorText(() => this.persistViewState()),
        this.editor.onDidScrollChange(() => this.persistViewState()),
        this.editor.onDidChangeCursorSelection(() => this.persistViewState()),
      ];

      this.restoreViewState();
      this.status = 'ready';
      this.editor.focus();
      this.editor.layout();
    } catch (error) {
      this.status = 'error';
      this.errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  private handleDocumentEvent(
    nextText: string,
    reason: 'load' | 'change' | 'save' | 'reload' | 'external-change'
  ): void {
    if (!this.editor || !this.model) {
      return;
    }

    if (reason === 'external-change') {
      return;
    }

    if (this.model.getValue() === nextText) {
      return;
    }

    const selection = this.editor.getSelection();
    const viewState = this.editor.saveViewState();
    this.isApplyingExternalUpdate = true;
    this.model.setValue(nextText);
    this.isApplyingExternalUpdate = false;

    if (viewState) {
      this.editor.restoreViewState(viewState);
    }

    if (selection) {
      this.editor.setSelection(selection);
    }
  }

  private persistViewState(): void {
    const tab = appState.tabs.tabs.find(candidate => candidate.id === this.tabId);
    if (!tab || !this.editor) {
      return;
    }

    const selection = this.editor.getSelection();
    const viewState = this.editor.saveViewState();
    const contextState: CodeEditorContextState = {
      monacoViewState: viewState ?? undefined,
      scrollTop: this.editor.getScrollTop(),
      scrollLeft: this.editor.getScrollLeft(),
      selection: selection ? this.serializeSelection(selection) : undefined,
    };

    tab.contextState = {
      ...(tab.contextState ?? {}),
      codeEditor: contextState,
    };
  }

  private restoreViewState(): void {
    const tab = appState.tabs.tabs.find(candidate => candidate.id === this.tabId);
    if (!tab || !this.editor) {
      return;
    }

    const contextState = tab.contextState?.codeEditor;
    if (!contextState) {
      return;
    }

    const viewState = contextState.monacoViewState as MonacoViewState | undefined;
    if (viewState) {
      this.editor.restoreViewState(viewState);
    }

    if (typeof contextState.scrollTop === 'number') {
      this.editor.setScrollTop(contextState.scrollTop);
    }

    if (typeof contextState.scrollLeft === 'number') {
      this.editor.setScrollLeft(contextState.scrollLeft);
    }

    if (contextState.selection) {
      this.editor.setSelection(this.deserializeSelection(contextState.selection));
    }
  }

  private serializeSelection(
    selection: import('monaco-editor').Selection
  ): CodeEditorSelectionState {
    return {
      startLineNumber: selection.startLineNumber,
      startColumn: selection.startColumn,
      endLineNumber: selection.endLineNumber,
      endColumn: selection.endColumn,
    };
  }

  private deserializeSelection(selection: CodeEditorSelectionState): MonacoSelection {
    if (!this.monaco) {
      throw new Error('Monaco is not loaded');
    }

    return new this.monaco.Selection(
      selection.startLineNumber,
      selection.startColumn,
      selection.endLineNumber,
      selection.endColumn
    );
  }

  private disposeEditor(): void {
    this.persistViewState();
    for (const listener of this.editorStateListeners) {
      listener.dispose();
    }
    this.editorStateListeners = [];
    this.modelContentListener?.dispose();
    this.modelContentListener = undefined;
    this.editor?.dispose();
    this.editor = undefined;
    this.model?.dispose();
    this.model = undefined;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-code-tab': CodeTabComponent;
  }
}
