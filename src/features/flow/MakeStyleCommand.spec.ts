import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { appState, resetAppState } from '@/state';
import { createCommandContext, snapshotState } from '@/core/command';
import type { OperationCommit, OperationInvokeResult } from '@/core/Operation';
import { OperationService } from '@/services/core/OperationService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import {
  FLOW_REFERENCES_INDEX_PATH,
  FlowReferencesService,
} from '@/services/flow/FlowReferencesService';
import { DECISIONS_PATH, extractDecisionEntries } from '@/services/flow/decision-log';
import { STYLE_DECISION_QUESTION, STYLE_DOC_PATH } from '@/services/flow/style-doc';
import { parseStylePalette } from '@/services/flow/PrototypeBootstrapService';
import { MakeStyleCommand } from './MakeStyleCommand';

/**
 * `extractPalette` reads pixels through a canvas, which happy-dom does not have. The quantizer has
 * its own spec; what this file is about is the three files the choice writes and puts back.
 */
vi.mock('@/services/image-gen/image-ops', () => ({
  extractPalette: vi.fn(async () => [
    { hex: '#2b1a0e', color: { r: 43, g: 26, b: 14 }, weight: 0.5 },
    { hex: '#e8c07d', color: { r: 232, g: 192, b: 125 }, weight: 0.3 },
  ]),
}));

class StorageStub {
  readonly blobs = new Map<string, Blob>();
  readonly texts = new Map<string, string>();

  listDirectory = vi.fn(async (path: string) => {
    const prefix = path === '.' ? '' : `${path}/`;
    return [...this.blobs.keys(), ...this.texts.keys()]
      .filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
      .map(file => ({
        name: file.slice(prefix.length),
        kind: 'file' as const,
        path: file,
        size: 8,
      }));
  });

  readBlob = vi.fn(async (path: string) => {
    const blob = this.blobs.get(path);
    if (!blob) {
      throw new Error(`missing ${path}`);
    }
    return blob;
  });

  readTextFile = vi.fn(async (path: string) => {
    const text = this.texts.get(path);
    if (text === undefined) {
      throw new Error(`missing ${path}`);
    }
    return text;
  });

  writeTextFile = vi.fn(async (path: string, contents: string) => {
    this.texts.set(path, contents);
  });

  writeBinaryFile = vi.fn(async (path: string, data: ArrayBuffer) => {
    this.blobs.set(path, new Blob([data]));
  });

  deleteEntry = vi.fn(async (path: string) => {
    this.blobs.delete(path);
    this.texts.delete(path);
  });

  createDirectory = vi.fn(async () => undefined);
  getLastModified = vi.fn(async () => null);
}

/** Captures the commit instead of pushing it, so undo can be driven directly. */
class OperationServiceStub {
  commit: OperationCommit | null = null;
  invokeAndPush = vi.fn(async (operation: { perform(context: unknown): unknown }) => {
    const result = (await operation.perform(
      createCommandContext(appState, snapshotState(appState), ServiceContainer.getInstance())
    )) as OperationInvokeResult;
    this.commit = result.commit ?? null;
    return result.didMutate && Boolean(result.commit);
  });
}

let storage: StorageStub;
let operations: OperationServiceStub;

const register = (type: Parameters<ServiceContainer['getOrCreateToken']>[0], instance: object) => {
  const container = ServiceContainer.getInstance();
  const wrapper = class {
    constructor() {
      return instance;
    }
  };
  container.addService(
    container.getOrCreateToken(type),
    wrapper as Parameters<ServiceContainer['addService']>[1],
    'singleton'
  );
};

beforeEach(() => {
  resetAppState();
  appState.project.status = 'ready';
  appState.project.id = 'project-1';
  appState.project.projectName = 'Ant Strategy';
  storage = new StorageStub();
  operations = new OperationServiceStub();
  const references = new FlowReferencesService();
  Object.defineProperty(references, 'storage', { value: storage, configurable: true });
  register(ProjectStorageService, storage);
  register(OperationService, operations);
  register(FlowReferencesService, references);

  storage.blobs.set('references/mood-2.png', new Blob(['png']));
  storage.blobs.set('references/mood-1.png', new Blob(['png']));
  storage.texts.set(
    FLOW_REFERENCES_INDEX_PATH,
    JSON.stringify({
      'mood-1.png': { role: 'style-candidate', origin: 'agent', caption: 'painterly' },
      'mood-2.png': { role: 'style-candidate', origin: 'agent', caption: 'flat vector, dusk' },
    })
  );
});

afterEach(() => {
  resetAppState();
  vi.restoreAllMocks();
});

const context = () =>
  createCommandContext(appState, snapshotState(appState), ServiceContainer.getInstance());

const run = async (path: string) => {
  const command = new MakeStyleCommand({ path });
  return command.execute(context());
};

describe('MakeStyleCommand', () => {
  it('refuses anything outside references/', async () => {
    const result = await new MakeStyleCommand({ path: 'design/source/ref.png' }).preconditions(
      context()
    );
    expect(result.canExecute).toBe(false);
  });

  /** A vector reference would quantize to nothing and write a style document that says nothing. */
  it('refuses a file whose palette cannot be measured', async () => {
    const svg = await new MakeStyleCommand({ path: 'references/logo.svg' }).preconditions(
      context()
    );
    expect(svg.canExecute).toBe(false);
    const text = await new MakeStyleCommand({ path: 'references/notes.txt' }).preconditions(
      context()
    );
    expect(text.canExecute).toBe(false);
  });

  it('needs an open project', async () => {
    appState.project.status = 'idle';
    const result = await new MakeStyleCommand({ path: 'references/mood-2.png' }).preconditions(
      context()
    );
    expect(result.canExecute).toBe(false);
  });
});

describe('MakeStyleOperation (through the command)', () => {
  it('promotes the role, writes the style document, and files the decision', async () => {
    await run('references/mood-2.png');

    const index = JSON.parse(storage.texts.get(FLOW_REFERENCES_INDEX_PATH) ?? '{}');
    expect(index['mood-2.png'].role).toBe('style');

    const style = storage.texts.get(STYLE_DOC_PATH) ?? '';
    // Measured, not guessed — and readable back by the transition that tints the recipe art.
    expect(parseStylePalette(style)).toEqual(['#2b1a0e', '#e8c07d']);
    expect(style).toContain('`references/mood-2.png`');

    const decisions = extractDecisionEntries(storage.texts.get(DECISIONS_PATH) ?? '');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].question).toBe(STYLE_DECISION_QUESTION);
    expect(decisions[0].choice).toBe('mood-2.png');
    expect(decisions[0].reason).toBe('flat vector, dusk');
    // The losing candidate is named, so a later reader sees what the look was chosen against.
    expect(decisions[0].rejected).toEqual(['mood-1.png']);
  });

  /**
   * A generated candidate's caption is its whole generation prompt — a paragraph. The log is
   * re-read at the start of every compacted conversation, so a decision that carries one costs
   * context forever; the full wording stays in `style.md`.
   */
  it('files the gist of a long caption, not the whole generation prompt', async () => {
    const prompt =
      'Cozy top-down kitchen with a chef raccoon at the stations, warm inviting colours, ' +
      'flat vector illustration style, clean bold shapes, minimal gradients, cartoonish and ' +
      'friendly. Counters, pots, ingredients, order tickets. Bright cheerful palette.';
    storage.texts.set(
      FLOW_REFERENCES_INDEX_PATH,
      JSON.stringify({
        'mood-2.png': { role: 'style-candidate', origin: 'agent', caption: prompt },
      })
    );

    await run('references/mood-2.png');

    const [decision] = extractDecisionEntries(storage.texts.get(DECISIONS_PATH) ?? '');
    expect(decision.reason.length).toBeLessThan(100);
    // Cut at a phrase boundary, so the fragment reads finished rather than dangling.
    expect(decision.reason).toBe(
      'Cozy top-down kitchen with a chef raccoon at the stations, warm inviting colours…'
    );
    // The full prompt is still on record where the style itself is described.
    expect(storage.texts.get(STYLE_DOC_PATH)).toContain('Bright cheerful palette.');
  });

  it("leaves the losing candidates alone — they are the user's to keep or delete", async () => {
    await run('references/mood-2.png');

    const index = JSON.parse(storage.texts.get(FLOW_REFERENCES_INDEX_PATH) ?? '{}');
    expect(index['mood-1.png'].role).toBe('style-candidate');
    expect(storage.blobs.has('references/mood-1.png')).toBe(true);
  });

  /**
   * Changing your mind must not leave a project describing one style and pointing at another, so
   * all three writes come back together.
   */
  it('undo restores the role, the style document and the decision log as one', async () => {
    await run('references/mood-2.png');
    expect(operations.commit).not.toBeNull();

    await operations.commit?.undo();

    const index = JSON.parse(storage.texts.get(FLOW_REFERENCES_INDEX_PATH) ?? '{}');
    expect(index['mood-2.png'].role).toBe('style-candidate');
    expect(storage.texts.get(STYLE_DOC_PATH)).toBe('');
    expect(extractDecisionEntries(storage.texts.get(DECISIONS_PATH) ?? '')).toEqual([]);
  });

  it('redo re-applies the same choice', async () => {
    await run('references/mood-2.png');
    await operations.commit?.undo();
    await operations.commit?.redo();

    const index = JSON.parse(storage.texts.get(FLOW_REFERENCES_INDEX_PATH) ?? '{}');
    expect(index['mood-2.png'].role).toBe('style');
    expect(parseStylePalette(storage.texts.get(STYLE_DOC_PATH) ?? '')).toHaveLength(2);
  });

  /**
   * Picking a second style REPLACES the first decision instead of leaving a log that names two —
   * the payoff of `record_decision` keying on a constant question.
   */
  it('a second choice replaces the first decision rather than stacking one', async () => {
    await run('references/mood-2.png');
    await run('references/mood-1.png');

    const decisions = extractDecisionEntries(storage.texts.get(DECISIONS_PATH) ?? '');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].choice).toBe('mood-1.png');
  });

  /**
   * Found live: changing your mind left BOTH pictures marked `style` while `style.md` named one,
   * and the transition reads the role — so the planner would have been handed two styles.
   */
  it('takes the role back off the picture the previous choice adopted', async () => {
    await run('references/mood-1.png');
    await run('references/mood-2.png');

    const index = JSON.parse(storage.texts.get(FLOW_REFERENCES_INDEX_PATH) ?? '{}');
    expect(index['mood-2.png'].role).toBe('style');
    expect(index['mood-1.png'].role).toBe('style-candidate');
  });

  it('leaves a `style` the user set by hand alone — only its own promotion is reversible', async () => {
    // No style.md yet, so nothing names mood-1 as this action's doing; the role is the user's.
    storage.texts.set(
      FLOW_REFERENCES_INDEX_PATH,
      JSON.stringify({
        'mood-1.png': { role: 'style', origin: 'user' },
        'mood-2.png': { role: 'style-candidate', origin: 'agent', caption: 'dusk' },
      })
    );

    await run('references/mood-2.png');

    const index = JSON.parse(storage.texts.get(FLOW_REFERENCES_INDEX_PATH) ?? '{}');
    expect(index['mood-1.png'].role).toBe('style');
  });

  it('undo puts the superseded style back', async () => {
    await run('references/mood-1.png');
    await run('references/mood-2.png');
    await operations.commit?.undo();

    const index = JSON.parse(storage.texts.get(FLOW_REFERENCES_INDEX_PATH) ?? '{}');
    expect(index['mood-1.png'].role).toBe('style');
    expect(index['mood-2.png'].role).toBe('style-candidate');
  });

  it('does not write a style pointing at a file that is gone', async () => {
    storage.blobs.delete('references/mood-2.png');

    await run('references/mood-2.png');

    expect(storage.texts.has(STYLE_DOC_PATH)).toBe(false);
    expect(operations.commit).toBeNull();
  });
});
