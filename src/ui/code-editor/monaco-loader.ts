import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

let monacoPromise: Promise<typeof import('monaco-editor')> | null = null;
let environmentConfigured = false;

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker?: (_moduleId: string, label: string) => Worker;
    };
  }
}

export const ensureMonacoLoaded = async (): Promise<typeof import('monaco-editor')> => {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      await import('monaco-editor/min/vs/editor/editor.main.css');
      configureEnvironment();
      return import('monaco-editor');
    })();
  }

  return monacoPromise;
};

const configureEnvironment = (): void => {
  if (environmentConfigured) {
    return;
  }

  window.MonacoEnvironment = {
    getWorker(_moduleId: string, label: string): Worker {
      if (label === 'json') {
        return new JsonWorker();
      }

      if (label === 'typescript' || label === 'javascript') {
        return new TsWorker();
      }

      return new EditorWorker();
    },
  };

  environmentConfigured = true;
};
