import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AmbientLightNode, Camera3D, GeometryMesh, Node3D, NodeBase } from '@pix3/runtime';
import { appState } from '@/state';
import { clearErrors } from '@/core/agent-introspection';
import { AgentToolRegistry, IDEA_STAGE_TOOLS, type JsonSchema } from './AgentToolRegistry';
import { GameTestService } from './GameTestService';
import { GAME_ASSERTION_KINDS } from './game-assertions';
import {
  InMemoryTraceStore,
  TRACE_FORMAT_VERSION,
  type GameInputTrace,
  type TraceStore,
} from './game-traces';
import { ProjectReportStore, ProjectTraceStore } from './ProjectTraceStore';
import type { RunProtocolStore } from './game-run-protocol';
import { UpdateObjectPropertyCommand } from '@/features/properties/UpdateObjectPropertyCommand';
import { SaveSceneCommand } from '@/features/scene/SaveSceneCommand';
import { ReloadSceneCommand } from '@/features/scene/ReloadSceneCommand';
import { AddComponentCommand } from '@/features/scripts/AddComponentCommand';
import { RemoveComponentCommand } from '@/features/scripts/RemoveComponentCommand';
import { UpdateComponentPropertyCommand } from '@/features/scripts/UpdateComponentPropertyCommand';
import { ReparentNodeCommand } from '@/features/scene/ReparentNodeCommand';

interface CommandMeta {
  metadata: { id: string; title: string; menuPath?: string };
}

/** Build a registry with fake dependencies injected in place of the DI-resolved ones. */
const buildRegistry = (overrides: Record<string, unknown> = {}): AgentToolRegistry => {
  const registry = new AgentToolRegistry();
  for (const [key, value] of Object.entries(overrides)) {
    // Screenshot results carry a fallback-lighting disclaimer, so every viewportRenderer double
    // needs that method; default it to "the scene lights itself" unless a case says otherwise.
    const stub =
      key === 'viewportRenderer' && value && typeof value === 'object'
        ? { isUsingEditorFallbackLighting: () => false, ...(value as object) }
        : value;
    Object.defineProperty(registry, key, { value: stub, configurable: true });
  }
  // The screenshot tools ask this service to build Vibe's missing viewport before they give up.
  // A spec has no editor shell, so default it to "nothing to mount" rather than let the tools
  // resolve the real (WebGL-backed) service out of the container.
  if (!('studioViewportMount' in overrides)) {
    Object.defineProperty(registry, 'studioViewportMount', {
      value: { ensureStudioViewportMounted: async () => false },
      configurable: true,
    });
  }
  return registry;
};

/** A sceneManager stub with an active graph, for tools gated by ensureActiveScene(). */
const activeSceneManager = () => ({ getActiveSceneGraph: () => ({ nodeMap: new Map() }) });

/** A minimal valid trace, for the store-backed `game_trace` cases. */
const makeStoredTrace = (name: string): GameInputTrace => ({
  formatVersion: TRACE_FORMAT_VERSION,
  name,
  recordedAt: '2026-01-01T00:00:00.000Z',
  env: {
    seed: null,
    fixedDeltaSec: 1 / 60,
    ticksPerFrame: 1,
    runtimeVersion: '1.0.0',
    viewport: { width: 800, height: 600 },
    sceneId: 'main',
  },
  events: [],
  outcome: { kind: 'until', channel: 'until', index: 0, frame: 5, gameTimeMs: 83 },
  metrics: { frames: 5, gameTimeMs: 83, newErrors: 0 },
});

const makeNode = (over: Record<string, unknown> = {}): NodeBase => {
  const node = Object.create(NodeBase.prototype) as Record<string, unknown>;
  Object.assign(node, {
    nodeId: 'n1',
    type: 'Node3D',
    name: 'Cube',
    visible: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    groups: [],
    components: [],
    children: [],
    properties: {},
    ...over,
  });
  return node as unknown as NodeBase;
};

describe('AgentToolRegistry', () => {
  beforeEach(() => {
    clearErrors();
  });

  it('lists the expected tools', () => {
    const names = buildRegistry()
      .list()
      .map(t => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'read_skill',
        'ask_advisor',
        'ask_user',
        'scene_tree',
        'node_inspect',
        'find_nodes',
        'get_selection',
        'set_property',
        'move_node',
        'list_component_types',
        'add_component',
        'set_component_property',
        'remove_component',
        'list_commands',
        'run_command',
        'fs_list',
        'fs_read',
        'fs_write',
        'str_replace',
        'fs_delete',
        'compile_scripts',
        'check_scripts',
        'play_start',
        'play_stop',
        'play_restart',
        'play_status',
        'game_input',
        'game_controls',
        'game_observe',
        'game_time',
        'game_run',
        'game_trace',
        'read_logs',
        'read_errors',
        'viewport_screenshot',
        'analyze_image',
        'generate_asset',
        'generate_sfx',
        'process_asset',
      ])
    );
  });

  it('specs() drops the handler', () => {
    const spec = buildRegistry().specs()[0];
    expect(spec).toHaveProperty('name');
    expect(spec).toHaveProperty('inputSchema');
    expect(spec).not.toHaveProperty('handler');
  });

  it('throws on an unknown tool', async () => {
    await expect(buildRegistry().execute('nope')).rejects.toThrow(/Unknown tool/);
  });

  describe('specs(allow) — the Flow idea-stage preset', () => {
    it('offers text, files, images and questions, and nothing else', () => {
      const names = buildRegistry()
        .specs(IDEA_STAGE_TOOLS)
        .map(spec => spec.name);

      expect(names.sort()).toEqual([...IDEA_STAGE_TOOLS].sort());
    });

    it('hides every scene, script, play-mode and gameplay tool', () => {
      // The class of failure this closes: an agent creating nodes and scripts against a design
      // nobody has agreed to, at a stage where the genre recipe has not been chosen yet.
      const names = new Set(
        buildRegistry()
          .specs(IDEA_STAGE_TOOLS)
          .map(spec => spec.name)
      );

      for (const forbidden of [
        'scene_tree',
        'node_inspect',
        'create_node',
        'set_property',
        'add_component',
        'compile_scripts',
        'play_start',
        'play_restart',
        'game_input',
        'game_observe',
        'game_run',
        'viewport_screenshot',
        'run_command',
      ]) {
        expect(names.has(forbidden), `${forbidden} must not be offered at the idea stage`).toBe(
          false
        );
      }
    });

    it('is the full surface with no allow-set (the prototype stage)', () => {
      const registry = buildRegistry();
      const all = registry.specs().map(spec => spec.name);

      expect(all).toContain('create_node');
      expect(all).toContain('play_start');
      expect(all.length).toBeGreaterThan(IDEA_STAGE_TOOLS.size);
      // `execute` is not gated by the filter: the allow-set narrows what the MODEL is offered.
      expect(registry.list().map(tool => tool.name)).toEqual(all);
    });
  });

  describe('viewport_screenshot', () => {
    it('returns the capture with the image lifted into __images', async () => {
      const captureScreenshot = vi.fn(() => ({
        dataBase64: 'QUJD',
        mimeType: 'image/jpeg',
        width: 640,
        height: 360,
      }));
      const registry = buildRegistry({ viewportRenderer: { captureScreenshot } });

      const result = (await registry.execute('viewport_screenshot', { maxSize: 640 })) as Record<
        string,
        unknown
      >;

      expect(captureScreenshot).toHaveBeenCalledWith({ maxSize: 640 });
      expect(result.ok).toBe(true);
      expect(result.__images).toEqual([{ mimeType: 'image/jpeg', data: 'QUJD' }]);
    });

    it('admits when the picture is lit by editor-only fallback lights', async () => {
      // The incident's second half: an unlit 3D scene photographs fine in the editor because the
      // viewport lights it itself, so a screenshot "proved" a game that ran black.
      const cube = new GeometryMesh({ id: 'cube', name: 'Cube', geometry: 'box', size: [1, 1, 1] });
      const registry = buildRegistry({
        viewportRenderer: {
          captureScreenshot: () => ({
            dataBase64: 'QUJD',
            mimeType: 'image/jpeg',
            width: 64,
            height: 64,
          }),
          isUsingEditorFallbackLighting: () => true,
        },
        sceneManager: { getActiveSceneGraph: () => ({ nodeMap: new Map(), rootNodes: [cube] }) },
      });

      const result = (await registry.execute('viewport_screenshot')) as Record<string, unknown>;

      expect(result.editorFallbackLighting).toBe(true);
      expect(String(result.lightingWarning)).toMatch(/EDITOR-ONLY/);
    });

    it('stays quiet about lighting when the scene lights itself', async () => {
      const cube = new GeometryMesh({ id: 'cube', name: 'Cube', geometry: 'box', size: [1, 1, 1] });
      const light = new AmbientLightNode({ id: 'amb', name: 'Ambient' });
      const registry = buildRegistry({
        viewportRenderer: {
          captureScreenshot: () => ({
            dataBase64: 'QUJD',
            mimeType: 'image/jpeg',
            width: 64,
            height: 64,
          }),
          isUsingEditorFallbackLighting: () => false,
        },
        sceneManager: {
          getActiveSceneGraph: () => ({ nodeMap: new Map(), rootNodes: [cube, light] }),
        },
      });

      const result = (await registry.execute('viewport_screenshot')) as Record<string, unknown>;

      expect(result.editorFallbackLighting).toBeUndefined();
    });

    it('reports a friendly error when the viewport is not initialized', async () => {
      const registry = buildRegistry({ viewportRenderer: { captureScreenshot: () => null } });
      const result = (await registry.execute('viewport_screenshot')) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/not initialized/);
    });

    it('mounts the Studio viewport on demand and retries when Vibe never built one', async () => {
      // A session reloaded straight into Vibe has no viewport at all — the shell skips Golden
      // Layout there on purpose. The agent must still be able to look at the authored scene, so
      // the tool asks for a hidden mount and photographs it instead of reporting a dead end.
      let mounted = false;
      const captureScreenshot = vi.fn(() =>
        mounted ? { dataBase64: 'TU9VTlQ', mimeType: 'image/jpeg', width: 640, height: 360 } : null
      );
      const ensureStudioViewportMounted = vi.fn(async () => {
        mounted = true;
        return true;
      });
      const registry = buildRegistry({
        viewportRenderer: { captureScreenshot },
        studioViewportMount: { ensureStudioViewportMounted },
      });

      const result = (await registry.execute('viewport_screenshot')) as Record<string, unknown>;

      expect(ensureStudioViewportMounted).toHaveBeenCalledTimes(1);
      expect(captureScreenshot).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(true);
      expect(result.view).toBe('editor');
      expect(result.__images).toEqual([{ mimeType: 'image/jpeg', data: 'TU9VTlQ' }]);
    });

    it('keeps the honest error when there is no shell to mount a viewport in', async () => {
      const captureScreenshot = vi.fn(() => null);
      const registry = buildRegistry({
        viewportRenderer: { captureScreenshot },
        studioViewportMount: { ensureStudioViewportMounted: async () => false },
      });

      const result = (await registry.execute('viewport_screenshot')) as Record<string, unknown>;

      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/not initialized/);
      // No point asking the renderer twice when nothing was mounted in between.
      expect(captureScreenshot).toHaveBeenCalledTimes(1);
    });

    it('a framed capture mounts the Studio viewport too', async () => {
      let mounted = false;
      const captureFramedScreenshot = vi.fn(() =>
        mounted ? { dataBase64: 'Rk9P', mimeType: 'image/jpeg', width: 512, height: 512 } : null
      );
      const node = makeNode({ nodeId: 'n42', name: 'Hero' });
      const registry = buildRegistry({
        viewportRenderer: { captureFramedScreenshot },
        sceneManager: { getActiveSceneGraph: () => ({ nodeMap: new Map([['n42', node]]) }) },
        studioViewportMount: {
          ensureStudioViewportMounted: async () => {
            mounted = true;
            return true;
          },
        },
      });

      const result = (await registry.execute('viewport_screenshot', {
        nodeId: 'n42',
      })) as Record<string, unknown>;

      expect(captureFramedScreenshot).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(true);
      expect(result.framed).toBe('node');
    });

    it('captures the RUNNING GAME instead of the editor while play mode is active', async () => {
      const gameCapture = vi.fn(() => ({
        dataBase64: 'R0FNRQ',
        mimeType: 'image/jpeg',
        width: 320,
        height: 180,
      }));
      const editorCapture = vi.fn(() => null);
      const registry = buildRegistry({
        playSession: { captureScreenshot: gameCapture },
        viewportRenderer: { captureScreenshot: editorCapture },
      });
      appState.ui.isPlaying = true;
      try {
        const result = (await registry.execute('viewport_screenshot')) as Record<string, unknown>;
        expect(result.ok).toBe(true);
        expect(result.view).toBe('game');
        expect(result.__images).toEqual([{ mimeType: 'image/jpeg', data: 'R0FNRQ' }]);
        expect(gameCapture).toHaveBeenCalledWith({ maxSize: 1024 });
        expect(editorCapture).not.toHaveBeenCalled();
      } finally {
        appState.ui.isPlaying = false;
      }
    });

    it('source "editor" still captures the edit-mode viewport while playing, with a note', async () => {
      const editorCapture = vi.fn(() => ({
        dataBase64: 'RURJVA',
        mimeType: 'image/jpeg',
        width: 640,
        height: 360,
      }));
      const gameCapture = vi.fn();
      const registry = buildRegistry({
        playSession: { captureScreenshot: gameCapture },
        viewportRenderer: { captureScreenshot: editorCapture },
      });
      appState.ui.isPlaying = true;
      try {
        const result = (await registry.execute('viewport_screenshot', {
          source: 'editor',
        })) as Record<string, unknown>;
        expect(result.ok).toBe(true);
        expect(result.view).toBe('editor');
        expect(gameCapture).not.toHaveBeenCalled();
        // It says what the frame IS, not that a capture failed: nothing went wrong here, the
        // agent asked for the editor and got it while a game happens to be running.
        expect(String(result.note)).toMatch(/EDIT-MODE viewport, not the running game/);
        expect(String(result.note)).not.toMatch(/not ready/);
      } finally {
        appState.ui.isPlaying = false;
      }
    });

    it('source "game" errors when the game is not running', async () => {
      const registry = buildRegistry({ viewportRenderer: { captureScreenshot: () => null } });
      const result = (await registry.execute('viewport_screenshot', { source: 'game' })) as Record<
        string,
        unknown
      >;
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/not running/);
    });

    it('falls back to the editor viewport (with a note) when the game canvas is not ready', async () => {
      const editorCapture = vi.fn(() => ({
        dataBase64: 'RURJVA',
        mimeType: 'image/jpeg',
        width: 640,
        height: 360,
      }));
      const registry = buildRegistry({
        playSession: { captureScreenshot: () => null },
        viewportRenderer: { captureScreenshot: editorCapture },
      });
      appState.ui.isPlaying = true;
      try {
        const result = (await registry.execute('viewport_screenshot')) as Record<string, unknown>;
        expect(result.ok).toBe(true);
        expect(result.view).toBe('editor');
        expect(String(result.note)).toMatch(/not ready/);
      } finally {
        appState.ui.isPlaying = false;
      }
    });

    it('frames a node: routes to captureFramedScreenshot and reports framed:node', async () => {
      const captureFramedScreenshot = vi.fn(() => ({
        dataBase64: 'Rk9P',
        mimeType: 'image/jpeg',
        width: 512,
        height: 512,
      }));
      const node = makeNode({ nodeId: 'n42', name: 'Hero' });
      const registry = buildRegistry({
        viewportRenderer: { captureFramedScreenshot },
        sceneManager: { getActiveSceneGraph: () => ({ nodeMap: new Map([['n42', node]]) }) },
      });

      const result = (await registry.execute('viewport_screenshot', {
        nodeId: 'n42',
        isolate: true,
        padding: 0.5,
      })) as Record<string, unknown>;

      expect(captureFramedScreenshot).toHaveBeenCalledWith({
        maxSize: 1024,
        frame: 'node',
        nodeId: 'n42',
        isolate: true,
        paddingMultiplier: 2,
      });
      expect(result.ok).toBe(true);
      expect(result.view).toBe('editor');
      expect(result.framed).toBe('node');
      expect(result.framedNodeName).toBe('Hero');
      expect(result.__images).toEqual([{ mimeType: 'image/jpeg', data: 'Rk9P' }]);
    });

    it('frame:"node" without a nodeId errors', async () => {
      const captureFramedScreenshot = vi.fn();
      const registry = buildRegistry({ viewportRenderer: { captureFramedScreenshot } });
      const result = (await registry.execute('viewport_screenshot', { frame: 'node' })) as Record<
        string,
        unknown
      >;
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/requires nodeId/);
      expect(captureFramedScreenshot).not.toHaveBeenCalled();
    });

    it('isolate without a target errors', async () => {
      const captureFramedScreenshot = vi.fn();
      const registry = buildRegistry({ viewportRenderer: { captureFramedScreenshot } });
      const result = (await registry.execute('viewport_screenshot', {
        frame: 'all',
        isolate: true,
      })) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/isolate needs a target/);
      expect(captureFramedScreenshot).not.toHaveBeenCalled();
    });

    it('framing with source "game" errors', async () => {
      const captureFramedScreenshot = vi.fn();
      const registry = buildRegistry({ viewportRenderer: { captureFramedScreenshot } });
      const result = (await registry.execute('viewport_screenshot', {
        frame: 'all',
        source: 'game',
      })) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/editor viewport/);
      expect(captureFramedScreenshot).not.toHaveBeenCalled();
    });

    it('propagates a typed error from captureFramedScreenshot (e.g. hidden node)', async () => {
      const captureFramedScreenshot = vi.fn(() => ({ error: 'The target node is hidden.' }));
      const registry = buildRegistry({
        viewportRenderer: { captureFramedScreenshot },
        sceneManager: { getActiveSceneGraph: () => ({ nodeMap: new Map() }) },
      });
      const result = (await registry.execute('viewport_screenshot', {
        frame: 'selection',
      })) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/hidden/);
    });
  });

  describe('read_skill', () => {
    it('returns a bundled skill by id', async () => {
      const registry = buildRegistry();
      const result = (await registry.execute('read_skill', { id: 'game-prototype' })) as Record<
        string,
        unknown
      >;
      expect(result.ok).toBe(true);
      expect(String(result.content)).toMatch(/game-prototype/i);
    });

    it('reports an error for an unknown skill', async () => {
      const registry = buildRegistry();
      const result = (await registry.execute('read_skill', { id: 'nope' })) as Record<
        string,
        unknown
      >;
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/Unknown skill/);
    });
  });

  describe('ask_advisor', () => {
    it('passes the question plus a project-grounded context to the advisor', async () => {
      const consult = vi.fn(async () => 'use a Timer component instead of setInterval');
      const advisor = {
        consult,
        describeAdvisor: async () => ({
          providerId: 'cerebras',
          providerLabel: 'Cerebras',
          modelId: 'zai-glm-4.7',
          modelLabel: 'GLM 4.7',
        }),
      };
      const registry = buildRegistry({ advisor });

      const result = (await registry.execute('ask_advisor', {
        question: 'How do I schedule a repeating spawn?',
        context: 'GameManager.ts uses setInterval and leaks between plays.',
      })) as Record<string, unknown>;

      expect(consult).toHaveBeenCalledTimes(1);
      const [question, context] = consult.mock.calls[0] as unknown as [string, string];
      expect(question).toBe('How do I schedule a repeating spawn?');
      expect(context).toMatch(/^Pix3 project /); // grounding header prepended
      expect(context).toContain('GameManager.ts uses setInterval');
      expect(result.ok).toBe(true);
      expect(result.answer).toBe('use a Timer component instead of setInterval');
      expect(result.advisor).toBe('Cerebras · GLM 4.7');
    });

    it('returns a friendly error when no advisor is configured', async () => {
      const advisor = {
        consult: vi.fn(async () => {
          throw new Error('No advisor model is configured.');
        }),
        describeAdvisor: async () => null,
      };
      const registry = buildRegistry({ advisor });

      const result = (await registry.execute('ask_advisor', {
        question: 'help',
        context: 'ctx',
      })) as Record<string, unknown>;

      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/No advisor model/);
    });
  });

  describe('ask_user', () => {
    it('echoes the question and options back as a structured result', async () => {
      const result = (await buildRegistry().execute('ask_user', {
        question: 'Win by score or by timer?',
        options: ['by score', 'by timer'],
      })) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(result.question).toBe('Win by score or by timer?');
      expect(result.options).toEqual(['by score', 'by timer']);
      expect(result.allowFreeform).toBe(true);
    });

    it('rejects an empty question', async () => {
      const result = (await buildRegistry().execute('ask_user', { question: '  ' })) as Record<
        string,
        unknown
      >;
      expect(result.ok).toBe(false);
    });
  });

  describe('record_decision', () => {
    /** A storage double that remembers one file — enough for an append-and-read-back log. */
    const decisionStorage = (initial: string | null = null) => {
      const files = new Map<string, string>();
      if (initial !== null) {
        files.set('design/decisions.md', initial);
      }
      return {
        files,
        readTextFile: async (path: string) => {
          const found = files.get(path);
          if (found === undefined) {
            throw new Error(`ENOENT ${path}`);
          }
          return found;
        },
        writeTextFile: async (path: string, content: string) => {
          files.set(path, content);
        },
        listDirectory: async () => [],
        createDirectory: async () => {},
      };
    };

    it('appends one canonical line to the decision log', async () => {
      const storage = decisionStorage('# Decisions\n');
      const result = (await buildRegistry({ storage }).execute('record_decision', {
        question: 'Win by score or by timer?',
        choice: 'By timer',
        reason: 'A fixed session fits the ad slot',
        alternatives: ['by score'],
      })) as Record<string, unknown>;

      expect(result.ok).toBe(true);
      expect(result.replaced).toBe(false);
      expect(result.line).toMatch(
        /^- \*\*Win by score or by timer\?\*\* → By timer\. A fixed session fits the ad slot\. _\(rejected: by score\)_ — \d{4}-\d{2}-\d{2}$/
      );
      expect(storage.files.get('design/decisions.md')).toContain('→ By timer.');
    });

    it('creates the log when the project has none yet', async () => {
      const storage = decisionStorage(null);
      const result = (await buildRegistry({ storage }).execute('record_decision', {
        question: 'Coop?',
        choice: 'Solo first',
      })) as Record<string, unknown>;

      expect(result.ok).toBe(true);
      expect(storage.files.get('design/decisions.md')).toMatch(/^# Decisions/);
    });

    /**
     * The path the feature actually walks: code files the `ask_user` answer, then the agent adds
     * the reason it learned. A second line would leave the planner reading the same fork twice.
     */
    it('replaces the entry for a fork already in the log instead of adding a second', async () => {
      const storage = decisionStorage(null);
      const registry = buildRegistry({ storage });
      await registry.execute('record_decision', { question: 'Coop?', choice: 'Solo first' });
      const result = (await registry.execute('record_decision', {
        question: 'Coop?',
        choice: 'Solo first',
        reason: 'Networking can wait',
      })) as Record<string, unknown>;

      expect(result.replaced).toBe(true);
      const log = storage.files.get('design/decisions.md') ?? '';
      expect(log.match(/\*\*Coop\?\*\*/g)).toHaveLength(1);
      expect(log).toContain('Networking can wait');
    });

    it('refuses an entry that is missing the question or the choice', async () => {
      const storage = decisionStorage('# Decisions\n');
      const registry = buildRegistry({ storage });
      expect(
        (
          (await registry.execute('record_decision', { question: ' ', choice: 'x' })) as {
            ok: boolean;
          }
        ).ok
      ).toBe(false);
      expect(
        (
          (await registry.execute('record_decision', { question: 'x', choice: '' })) as {
            ok: boolean;
          }
        ).ok
      ).toBe(false);
      expect(storage.files.get('design/decisions.md')).toBe('# Decisions\n');
    });
  });

  describe('analyze_image', () => {
    it('captures the viewport and routes it to the vision helper', async () => {
      const captureScreenshot = vi.fn(() => ({
        dataBase64: 'QUJD',
        mimeType: 'image/jpeg',
        width: 640,
        height: 360,
      }));
      const analyze = vi.fn(async () => 'a red car, top-down, flat shading');
      const vision = {
        analyze,
        describeHelper: async () => ({
          providerLabel: 'Google Gemini',
          modelLabel: 'Gemini Flash',
          modelId: 'gemini-flash',
        }),
      };
      const registry = buildRegistry({ viewportRenderer: { captureScreenshot }, vision });

      const result = (await registry.execute('analyze_image', {
        source: 'viewport',
        question: 'what is this?',
      })) as Record<string, unknown>;

      expect(analyze).toHaveBeenCalledWith(
        { type: 'image', mimeType: 'image/jpeg', data: 'QUJD' },
        'what is this?'
      );
      expect(result.ok).toBe(true);
      expect(result.answer).toMatch(/red car/);
      expect(result.model).toContain('Gemini');
    });

    it('source "viewport" routes to the running game while play mode is active', async () => {
      const gameCapture = vi.fn(() => ({
        dataBase64: 'R0FNRQ',
        mimeType: 'image/jpeg',
        width: 320,
        height: 180,
      }));
      const analyze = vi.fn(async () => 'the game is running');
      const registry = buildRegistry({
        playSession: { captureScreenshot: gameCapture },
        viewportRenderer: { captureScreenshot: vi.fn(() => null) },
        vision: { analyze, describeHelper: async () => null },
      });
      appState.ui.isPlaying = true;
      try {
        const result = (await registry.execute('analyze_image', {
          source: 'viewport',
        })) as Record<string, unknown>;
        expect(gameCapture).toHaveBeenCalledWith({ maxSize: 1024 });
        expect(analyze).toHaveBeenCalledWith(
          { type: 'image', mimeType: 'image/jpeg', data: 'R0FNRQ' },
          ''
        );
        expect(result.ok).toBe(true);
      } finally {
        appState.ui.isPlaying = false;
      }
    });

    it('opens a project path, previews it, and frees the handle', async () => {
      const assetGen = {
        get: vi.fn(() => null),
        open: vi.fn(async () => ({ id: 'img-x' })),
        preview: vi.fn(async () => 'data:image/png;base64,QUJD'),
        discard: vi.fn(),
      };
      const analyze = vi.fn(async () => 'blue palette');
      const registry = buildRegistry({
        assetGen,
        vision: { analyze, describeHelper: async () => null },
      });

      const result = (await registry.execute('analyze_image', {
        source: 'res://design/references/screen1.jpg',
      })) as Record<string, unknown>;

      expect(assetGen.open).toHaveBeenCalledWith('design/references/screen1.jpg');
      expect(analyze).toHaveBeenCalledWith(
        { type: 'image', mimeType: 'image/png', data: 'QUJD' },
        ''
      );
      expect(assetGen.discard).toHaveBeenCalledWith('img-x');
      expect(result.ok).toBe(true);
    });

    it('reports the vision error when no helper is available', async () => {
      const captureScreenshot = vi.fn(() => ({
        dataBase64: 'QUJD',
        mimeType: 'image/jpeg',
        width: 10,
        height: 10,
      }));
      const vision = {
        analyze: vi.fn(async () => {
          throw new Error('No vision-capable model with a configured API key is available.');
        }),
        describeHelper: async () => null,
      };
      const registry = buildRegistry({ viewportRenderer: { captureScreenshot }, vision });

      const result = (await registry.execute('analyze_image', { source: 'viewport' })) as Record<
        string,
        unknown
      >;

      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/vision-capable/);
    });
  });

  describe('generate_asset', () => {
    const makeAssetGen = (keyConfigured: boolean) => ({
      status: vi.fn(async () => ({ keyConfigured })),
      generate: vi.fn(async () => ({ id: 'img-1', width: 512, height: 512 })),
      // The pipeline yields a new handle (bg-removed → trimmed → downscaled).
      postProcess: vi.fn(async () => ({ id: 'img-2', width: 256, height: 256 })),
      open: vi.fn(async () => ({ id: 'img-open', width: 512, height: 512 })),
      save: vi.fn(async () => ({
        path: 'assets/ui/button.png',
        width: 256,
        height: 256,
        bytes: 1234,
        mimeType: 'image/png',
      })),
      alphaStats: vi.fn(async () => ({ hasAlpha: true, transparentFraction: 0.4 })),
      preview: vi.fn(async () => 'data:image/webp;base64,UFJFVklFVw=='),
      discard: vi.fn(),
    });

    it('refuses without a configured image key', async () => {
      const assetGen = makeAssetGen(false);
      const registry = buildRegistry({ assetGen });
      const result = (await registry.execute('generate_asset', {
        prompt: 'a button',
        name: 'assets/ui/button',
      })) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/API key/);
      expect(assetGen.generate).not.toHaveBeenCalled();
    });

    it('generates, post-processes with the sprite preset, saves the result, previews it, and frees every handle', async () => {
      const assetGen = makeAssetGen(true);
      const registry = buildRegistry({ assetGen });

      const result = (await registry.execute('generate_asset', {
        prompt: 'a button',
        name: 'assets/ui/button',
        transparent: true,
      })) as Record<string, unknown>;

      expect(assetGen.generate).toHaveBeenCalledWith({
        prompt: 'a button',
        references: undefined,
        transparent: true,
      });
      // transparent → sprite preset; the processed handle is what gets saved & previewed.
      expect(assetGen.postProcess).toHaveBeenCalledWith('img-1', 'sprite', { maxSize: undefined });
      expect(assetGen.save).toHaveBeenCalledWith('img-2', 'assets/ui/button', {});
      expect(assetGen.preview).toHaveBeenCalledWith('img-2', 256);
      expect(result.ok).toBe(true);
      expect(result.preset).toBe('sprite');
      expect(result.saved).toMatchObject({ path: 'assets/ui/button.png' });
      expect(result.original).toEqual({ width: 512, height: 512 });
      expect(result.__images).toEqual([{ mimeType: 'image/webp', data: 'UFJFVklFVw==' }]);
      expect(assetGen.discard).toHaveBeenCalledWith('img-1');
      expect(assetGen.discard).toHaveBeenCalledWith('img-2');
    });

    it('defaults an opaque generation to the texture preset', async () => {
      const assetGen = makeAssetGen(true);
      const registry = buildRegistry({ assetGen });

      await registry.execute('generate_asset', { prompt: 'a tiled floor', name: 'floor' });

      expect(assetGen.postProcess).toHaveBeenCalledWith('img-1', 'texture', { maxSize: undefined });
    });

    it('honours an explicit postProcess preset and maxSize', async () => {
      const assetGen = makeAssetGen(true);
      const registry = buildRegistry({ assetGen });

      await registry.execute('generate_asset', {
        prompt: 'an icon',
        name: 'icon',
        transparent: true,
        postProcess: 'icon',
        maxSize: 128,
      });

      expect(assetGen.postProcess).toHaveBeenCalledWith('img-1', 'icon', { maxSize: 128 });
    });

    /**
     * The idea stage's default output folder and its index write are decided HERE, in the tool, not
     * asked for in the skill: "the artefact exists but is not in the references list" is the quiet
     * breakage a prompt cannot fix (design §3.6).
     */
    describe('at the idea stage', () => {
      const ideaRegistry = (
        assetGen: ReturnType<typeof makeAssetGen>,
        flowReferences: { upsert: ReturnType<typeof vi.fn> }
      ): AgentToolRegistry =>
        buildRegistry({ assetGen, flowReferences, flowStage: { isIdeaStage: () => true } });

      it('puts a bare name in references/ and indexes it with origin agent and the prompt as caption', async () => {
        const assetGen = makeAssetGen(true);
        assetGen.save = vi.fn(async () => ({
          path: 'references/mood-1.png',
          width: 256,
          height: 256,
          bytes: 1234,
          mimeType: 'image/png',
        }));
        const flowReferences = { upsert: vi.fn(async () => undefined) };

        await ideaRegistry(assetGen, flowReferences).execute('generate_asset', {
          prompt: 'flat vector city at dusk',
          name: 'mood-1.png',
        });

        expect(assetGen.save).toHaveBeenCalledWith('img-2', 'references/mood-1.png', {});
        expect(flowReferences.upsert).toHaveBeenCalledWith('mood-1.png', {
          origin: 'agent',
          caption: 'flat vector city at dusk',
          prompt: 'flat vector city at dusk',
        });
      });

      /**
       * Observed live: the model asked for `design/reference_screenshot.png`, so the picture it had
       * just drawn never showed up in the references column — the one place the user looks for it.
       * At this stage nothing else consumes a generated file, so the folder is not the model's to
       * choose; only the file name is.
       */
      it('redirects an explicit folder into references/ and still indexes it', async () => {
        const assetGen = makeAssetGen(true);
        // The real `save` writes at the path it is handed; the stub reports the redirected one.
        assetGen.save = vi.fn(async () => ({
          path: 'references/reference_screenshot.png',
          width: 256,
          height: 256,
          bytes: 1234,
          mimeType: 'image/png',
        }));
        const flowReferences = { upsert: vi.fn(async () => undefined) };

        await ideaRegistry(assetGen, flowReferences).execute('generate_asset', {
          prompt: 'a fake screenshot',
          name: 'design/reference_screenshot.png',
        });

        expect(assetGen.save).toHaveBeenCalledWith(
          'img-2',
          'references/reference_screenshot.png',
          {}
        );
        expect(flowReferences.upsert).toHaveBeenCalledWith('reference_screenshot.png', {
          origin: 'agent',
          caption: 'a fake screenshot',
          prompt: 'a fake screenshot',
        });
      });

      it('says in the result that the folder was decided for the model', async () => {
        const assetGen = makeAssetGen(true);
        assetGen.save = vi.fn(async () => ({
          path: 'references/mood-1.png',
          width: 256,
          height: 256,
          bytes: 1234,
          mimeType: 'image/png',
        }));

        const result = (await ideaRegistry(assetGen, {
          upsert: vi.fn(async () => undefined),
        }).execute('generate_asset', { prompt: 'a mood', name: 'mood-1.png' })) as {
          note: string;
        };

        expect(result.note).toContain('references/');
        expect(result.note).toMatch(/not yours to choose/i);
      });

      /**
       * Observed live, twice: the model generated a moodboard (which lands in `references/`), then
       * "corrected" the location with process_asset into `design/` and deleted the original — so
       * the artefact vanished from the Files column, the only place the user looks for it.
       */
      it('refuses to process a reference OUT of references/', async () => {
        const assetGen = makeAssetGen(true);
        const registry = ideaRegistry(assetGen, { upsert: vi.fn(async () => undefined) });
        appState.project.status = 'ready';

        const result = (await registry.execute('process_asset', {
          path: 'references/mood-1.png',
          name: 'design/mood-1.png',
        })) as { ok: boolean; error: string };

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/references\//);
        expect(assetGen.open).not.toHaveBeenCalled();
        appState.project.status = 'idle';
      });

      it('still processes a reference in place', async () => {
        const assetGen = makeAssetGen(true);
        assetGen.save = vi.fn(async () => ({
          path: 'references/mood-1.png',
          width: 256,
          height: 256,
          bytes: 1234,
          mimeType: 'image/png',
        }));
        const registry = ideaRegistry(assetGen, { upsert: vi.fn(async () => undefined) });
        appState.project.status = 'ready';

        const result = (await registry.execute('process_asset', {
          path: 'references/mood-1.png',
        })) as { ok: boolean };

        expect(result.ok).toBe(true);
        expect(assetGen.save).toHaveBeenCalledWith('img-2', 'references/mood-1.png', {});
        appState.project.status = 'idle';
      });
    });

    it('keeps the asset-type folder for a bare name at the prototype stage', async () => {
      const assetGen = makeAssetGen(true);
      const registry = buildRegistry({ assetGen, flowStage: { isIdeaStage: () => false } });

      await registry.execute('generate_asset', { prompt: 'a car', name: 'car.png' });

      expect(assetGen.save).toHaveBeenCalledWith('img-2', 'sprites/car.png', {});
    });
  });

  describe('generate_sfx', () => {
    const COIN =
      'sound "coin pickup" 200ms pickup\n  body: tone sine 880Hz | gain 0.8 decay 150ms\n';

    const soundResult = (over: Record<string, unknown> = {}) => ({
      outcome: 'accepted',
      accepted: true,
      soundline: COIN,
      grammarVersion: 'soundline/v0',
      issues: [],
      llmProviderId: 'stub',
      llmModelId: 'stub-model',
      wav: new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' }),
      durationMs: 250,
      peak: 0.8,
      clipped: false,
      suggestedName: 'coin_pickup',
      ...over,
    });

    /** Named parameters, so `mock.calls[n][i]` stays typed (a bare `async () =>` infers `[]`). */
    const makeSfxGen = (available = true) => ({
      isAvailable: vi.fn(async () => available),
      generate: vi.fn(async (_options: Record<string, unknown>) => soundResult()),
      save: vi.fn(async (_result: unknown, _name: string) => ({
        path: 'sfx/coin_pickup.wav',
        bytes: 4,
        durationMs: 250,
      })),
    });

    it('refuses when no LLM lane is configured, pointing at Agent settings', async () => {
      const sfxGen = makeSfxGen(false);
      const registry = buildRegistry({ sfxGen });
      const result = (await registry.execute('generate_sfx', { prompt: 'a coin' })) as Record<
        string,
        unknown
      >;
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/Settings → AI Agent/);
      expect(sfxGen.generate).not.toHaveBeenCalled();
    });

    it('generates, saves under res://sfx/, and hands the recipe back for later edits', async () => {
      const sfxGen = makeSfxGen();
      const registry = buildRegistry({ sfxGen });

      const result = (await registry.execute('generate_sfx', {
        prompt: 'crisp coin pickup',
        name: 'coin_pickup',
      })) as Record<string, unknown>;

      expect(sfxGen.generate).toHaveBeenCalledWith({ prompt: 'crisp coin pickup' });
      expect(sfxGen.save.mock.calls[0][1]).toBe('coin_pickup');
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe('accepted');
      expect(result.saved).toMatchObject({ path: 'sfx/coin_pickup.wav' });
      expect(result.resourcePath).toBe('res://sfx/coin_pickup.wav');
      expect(result.durationMs).toBe(250);
      expect(result.peak).toBe(0.8);
      // The recipe is the master; without it the next tweak is a re-roll.
      expect(result.soundline).toContain('sound "coin pickup"');
      expect(result.grammarVersion).toBe('soundline/v0');
    });

    it('treats prompt+soundline+feedback as an edit, sending the feedback as the request', async () => {
      const sfxGen = makeSfxGen();
      const registry = buildRegistry({ sfxGen });

      await registry.execute('generate_sfx', {
        prompt: 'crisp coin pickup',
        soundline: COIN,
        feedback: 'duller, 100 ms shorter',
      });

      expect(sfxGen.generate).toHaveBeenCalledWith({
        prompt: 'duller, 100 ms shorter',
        soundline: COIN,
      });
    });

    it('reports a refusal as a NORMAL result — a retry would only refuse again', async () => {
      const sfxGen = makeSfxGen();
      sfxGen.generate.mockResolvedValue(
        soundResult({
          accepted: false,
          outcome: 'refused',
          soundline: '',
          wav: undefined,
          durationMs: undefined,
          peak: undefined,
          message: 'A human voice is out of scope for procedural synthesis.',
        })
      );
      const registry = buildRegistry({ sfxGen });

      const result = (await registry.execute('generate_sfx', {
        prompt: 'a man saying hello',
      })) as Record<string, unknown>;

      expect(result.ok).toBe(true);
      expect(result.outcome).toBe('refused');
      expect(result.accepted).toBe(false);
      expect(String(result.note)).toContain('out of scope');
      expect(result.saved).toBeUndefined();
      expect(sfxGen.save).not.toHaveBeenCalled();
    });

    it('surfaces validator warnings on an accepted sound', async () => {
      const sfxGen = makeSfxGen();
      sfxGen.generate.mockResolvedValue(
        soundResult({
          issues: [
            {
              severity: 'warn',
              layer: 'body',
              rule: 'pickup.decay',
              got: '150ms',
              expected: '< 120ms',
              hint: 'Shorten the decay.',
            },
          ],
        })
      );
      const registry = buildRegistry({ sfxGen });

      const result = (await registry.execute('generate_sfx', { prompt: 'a coin' })) as Record<
        string,
        unknown
      >;
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual(['body: pickup.decay — Shorten the decay.']);
      expect(result.errors).toBeUndefined();
    });

    it('honours save:false so a recipe can be iterated on without leaving files', async () => {
      const sfxGen = makeSfxGen();
      const registry = buildRegistry({ sfxGen });

      const result = (await registry.execute('generate_sfx', {
        prompt: 'a coin',
        save: false,
      })) as Record<string, unknown>;

      expect(sfxGen.save).not.toHaveBeenCalled();
      expect(result.saved).toBeNull();
      expect(result.soundline).toContain('sound "coin pickup"');
      expect(String(result.note)).toContain('Not saved');
    });

    it('clamps the iteration budget rather than trusting the caller', async () => {
      const sfxGen = makeSfxGen();
      const registry = buildRegistry({ sfxGen });
      await registry.execute('generate_sfx', { prompt: 'a coin', maxIterations: 99 });
      // The service owns the cap; the tool must not silently drop the field either.
      expect(sfxGen.generate.mock.calls[0][0].maxIterations).toBe(99);
    });

    it('reports a save failure as an error rather than claiming success', async () => {
      const sfxGen = makeSfxGen();
      sfxGen.save.mockRejectedValue(new Error('No project is open — cannot save.'));
      const registry = buildRegistry({ sfxGen });

      const result = (await registry.execute('generate_sfx', { prompt: 'a coin' })) as Record<
        string,
        unknown
      >;
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/No project is open/);
    });

    it('teaches the ladder and the music/voice exclusion in its description', () => {
      const spec = buildRegistry()
        .specs()
        .find(tool => tool.name === 'generate_sfx');
      expect(spec).toBeDefined();
      const description = spec?.description ?? '';
      expect(description).toContain('scene.audio.sfx');
      expect(description).toMatch(/replaced by a sound designer/i);
      expect(description).toMatch(/never use this for music, ambience beds or any voice/i);
      expect(description).toContain('res://sfx/');
    });
  });
  describe('process_asset', () => {
    const makeAssetGen = () => ({
      open: vi.fn(async () => ({ id: 'img-open', width: 900, height: 700 })),
      postProcess: vi.fn(async () => ({ id: 'img-proc', width: 256, height: 256 })),
      save: vi.fn(async () => ({
        path: 'src/assets/textures/car.png',
        width: 256,
        height: 256,
        bytes: 999,
        mimeType: 'image/png',
      })),
      alphaStats: vi.fn(async () => ({ hasAlpha: true, transparentFraction: 0.4 })),
      preview: vi.fn(async () => 'data:image/webp;base64,UFJFVklFVw=='),
      discard: vi.fn(),
    });

    it('opens, processes, saves back in place and frees the handles', async () => {
      appState.project.status = 'ready';
      const assetGen = makeAssetGen();
      const registry = buildRegistry({ assetGen });

      const result = (await registry.execute('process_asset', {
        path: 'res://src/assets/textures/car.png',
      })) as Record<string, unknown>;

      expect(assetGen.open).toHaveBeenCalledWith('src/assets/textures/car.png');
      expect(assetGen.postProcess).toHaveBeenCalledWith('img-open', 'sprite', {
        maxSize: undefined,
      });
      // No `name` → overwrite the source path.
      expect(assetGen.save).toHaveBeenCalledWith('img-proc', 'src/assets/textures/car.png', {});
      expect(result.ok).toBe(true);
      expect(result.preset).toBe('sprite');
      expect(result.__images).toEqual([{ mimeType: 'image/webp', data: 'UFJFVklFVw==' }]);
      expect(assetGen.discard).toHaveBeenCalledWith('img-open');
      expect(assetGen.discard).toHaveBeenCalledWith('img-proc');
    });

    it('refuses when no project is open', async () => {
      appState.project.status = 'idle';
      const assetGen = makeAssetGen();
      const registry = buildRegistry({ assetGen });

      const result = (await registry.execute('process_asset', { path: 'car.png' })) as Record<
        string,
        unknown
      >;

      expect(result.ok).toBe(false);
      expect(assetGen.open).not.toHaveBeenCalled();
    });
  });

  describe('filesystem tools', () => {
    const makeStorage = () => {
      const files = new Map<string, string>([['scripts/a.ts', 'export const x = 1;']]);
      return {
        files,
        // Mirrors ProjectStorageService: write/delete bump fileRefreshSignal.
        writeTextFile: vi.fn(async (path: string, content: string) => {
          files.set(path, content);
          appState.project.fileRefreshSignal = (appState.project.fileRefreshSignal || 0) + 1;
        }),
        deleteEntry: vi.fn(async (path: string) => {
          files.delete(path);
          appState.project.fileRefreshSignal = (appState.project.fileRefreshSignal || 0) + 1;
        }),
        readTextFile: vi.fn(async (path: string) => {
          const c = files.get(path);
          if (c === undefined) throw new Error('not found');
          return c;
        }),
        readBlob: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })),
        listDirectory: vi.fn(async (dir: string) =>
          dir === 'scenes'
            ? [
                {
                  name: 'main.pix3scene',
                  kind: 'file' as const,
                  path: 'scenes/main.pix3scene',
                  size: 42,
                },
              ]
            : []
        ),
      };
    };

    it('fs_write delegates to storage and bumps fileRefreshSignal', async () => {
      const storage = makeStorage();
      const registry = buildRegistry({ storage });
      const before = appState.project.fileRefreshSignal || 0;

      const result = await registry.execute('fs_write', {
        path: 'res://scripts/spin.ts',
        content: 'code',
      });

      expect(storage.writeTextFile).toHaveBeenCalledWith('scripts/spin.ts', 'code');
      expect(result).toEqual({ ok: true, path: 'scripts/spin.ts' });
      expect(appState.project.fileRefreshSignal || 0).toBeGreaterThan(before);
    });

    it('fs_write creates a NEW file without needing overwrite (the guard never blocks creation)', async () => {
      const storage = makeStorage();
      const registry = buildRegistry({ storage });

      const result = (await registry.execute('fs_write', {
        path: 'scripts/Brand.ts',
        content: 'x'.repeat(9000),
      })) as Record<string, unknown>;

      expect(result.ok).toBe(true);
      expect(result.forcedOverwrite).toBeUndefined();
      expect(storage.files.get('scripts/Brand.ts')).toHaveLength(9000);
    });

    /**
     * A storage whose directories have to exist — `listDirectory` throws for anything
     * not in `dirs`, the way every real backend does. `makeStorage` above answers every
     * directory with an empty listing, which is why the parent-creation cases need
     * their own fake.
     */
    const makeStrictStorage = (dirs: string[] = []) => {
      const known = new Set(dirs);
      const files = new Map<string, string>();
      return {
        files,
        created: [] as string[],
        writeTextFile: vi.fn(async (path: string, content: string) => {
          const parent = path.split('/').slice(0, -1).join('/');
          if (parent && !known.has(parent))
            throw new Error(`Unable to resolve directory: ${parent}`);
          files.set(path, content);
        }),
        readTextFile: vi.fn(async () => {
          throw new Error('not found');
        }),
        listDirectory: vi.fn(async (dir: string) => {
          if (!known.has(dir)) throw new Error(`Unable to resolve directory: ${dir}`);
          return [];
        }),
        createDirectory: vi.fn(async function (this: { created: string[] }, path: string) {
          const segments = path.split('/');
          for (let i = 1; i <= segments.length; i += 1) known.add(segments.slice(0, i).join('/'));
          this.created.push(path);
        }),
      };
    };

    it('fs_write creates the missing parent directories and NAMES the ones it created', async () => {
      // The case that blocked an agent from storing its first routine: no
      // design/tests/routines/ in the project and no tool to make one.
      const storage = makeStrictStorage(['design']);
      const registry = buildRegistry({ storage });

      const result = (await registry.execute('fs_write', {
        path: 'design/tests/routines/menu-play.json',
        content: '{}',
      })) as Record<string, unknown>;

      expect(result.ok).toBe(true);
      // Only the levels that were genuinely absent — `design` existed and is not claimed.
      expect(result.createdDirectories).toEqual(['design/tests', 'design/tests/routines']);
      // Said in words too: silent parent creation turns a typo into a plausible folder,
      // so the answer has to carry the names a reader can check.
      expect(String(result.note)).toContain('design/tests/routines');
      expect(storage.created).toEqual(['design/tests/routines']);
      expect(storage.files.get('design/tests/routines/menu-play.json')).toBe('{}');
    });

    it('fs_write claims no directory when the parent is already there', async () => {
      const storage = makeStrictStorage(['scripts']);
      const registry = buildRegistry({ storage });

      const result = (await registry.execute('fs_write', {
        path: 'scripts/Spin.ts',
        content: 'code',
      })) as Record<string, unknown>;

      expect(result.ok).toBe(true);
      expect(result.createdDirectories).toBeUndefined();
      expect(result.note).toBeUndefined();
      expect(storage.createDirectory).not.toHaveBeenCalled();
      // One probe, not one per level: the ordinary write must not pay for the fix.
      expect(storage.listDirectory).toHaveBeenCalledTimes(1);
    });

    it('fs_write points a plan written to design/plan.md at the file the Plan tab reads', async () => {
      // Observed live: a session wrote its build plan to design/plan.md, the write
      // succeeded, and the Plan tab stayed empty for the whole run with nothing said.
      const storage = makeStorage();
      const registry = buildRegistry({ storage });

      const result = (await registry.execute('fs_write', {
        path: 'design/plan.md',
        content: '- [ ] build it',
      })) as Record<string, unknown>;

      // A note, not a refusal: the agent keeps its own document.
      expect(result.ok).toBe(true);
      expect(storage.files.get('design/plan.md')).toBe('- [ ] build it');
      expect(String(result.note)).toContain('design/progress.md');
    });

    it('fs_write says nothing about progress.md once the project has one', async () => {
      const storage = makeStorage();
      storage.files.set('design/progress.md', '- [x] shipped');
      const registry = buildRegistry({ storage });

      const stray = (await registry.execute('fs_write', {
        path: 'design/roadmap.md',
        content: 'later',
      })) as Record<string, unknown>;
      // The Plan tab has something to show, so a second planning document is the agent's business.
      expect(stray.note).toBeUndefined();

      const itself = (await registry.execute('fs_write', {
        path: 'design/progress.md',
        content: '- [ ] next',
      })) as Record<string, unknown>;
      expect(itself.note).toBeUndefined();
    });

    it('fs_write leaves an ordinary design/ document alone', async () => {
      const storage = makeStorage();
      const registry = buildRegistry({ storage });

      const result = (await registry.execute('fs_write', {
        path: 'design/brief.md',
        content: 'the pitch',
      })) as Record<string, unknown>;

      expect(result.note).toBeUndefined();
    });

    it('fs_write REFUSES to overwrite a large existing file and points at str_replace', async () => {
      const storage = makeStorage();
      storage.files.set('scripts/Big.ts', 'a'.repeat(2500));
      const registry = buildRegistry({ storage });

      const result = (await registry.execute('fs_write', {
        path: 'scripts/Big.ts',
        content: 'replaced',
      })) as Record<string, unknown>;

      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/str_replace/);
      expect(result.existingChars).toBe(2500);
      // The refusal must be a no-op on disk — that is the whole point of the guard.
      expect(storage.writeTextFile).not.toHaveBeenCalled();
      expect(storage.files.get('scripts/Big.ts')).toBe('a'.repeat(2500));
    });

    it('fs_write overwrites a small existing file without ceremony', async () => {
      const storage = makeStorage();
      const registry = buildRegistry({ storage });
      const result = (await registry.execute('fs_write', {
        path: 'scripts/a.ts',
        content: 'export const x = 2;',
      })) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(storage.files.get('scripts/a.ts')).toBe('export const x = 2;');
    });

    it('fs_write with overwrite:true still needs a reason, then writes and reports forcedOverwrite', async () => {
      const storage = makeStorage();
      storage.files.set('scripts/Big.ts', 'a'.repeat(2500));
      const registry = buildRegistry({ storage });

      const noReason = (await registry.execute('fs_write', {
        path: 'scripts/Big.ts',
        content: 'replaced',
        overwrite: true,
      })) as Record<string, unknown>;
      expect(noReason.ok).toBe(false);
      expect(String(noReason.error)).toMatch(/reason/);
      expect(storage.writeTextFile).not.toHaveBeenCalled();

      const forced = (await registry.execute('fs_write', {
        path: 'scripts/Big.ts',
        content: 'replaced',
        overwrite: true,
        reason: 'the whole controller is being replaced by the new state machine',
      })) as Record<string, unknown>;
      expect(forced.ok).toBe(true);
      // The chat loop counts this flag as a "stuck" signal.
      expect(forced.forcedOverwrite).toBe(true);
      expect(storage.files.get('scripts/Big.ts')).toBe('replaced');
    });

    it('fs_write to an OPEN scene file force-reloads that scene', async () => {
      const storage = makeStorage();
      const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
      const registry = buildRegistry({ storage, dispatcher });
      appState.scenes.descriptors['scene-main'] = {
        filePath: 'res://src/assets/scenes/main.pix3scene',
      } as never;
      try {
        const result = (await registry.execute('fs_write', {
          path: 'src/assets/scenes/main.pix3scene',
          content: 'root: []',
        })) as Record<string, unknown>;
        expect(result.reloadedScene).toBe('scene-main');
        expect(dispatcher.execute).toHaveBeenCalledTimes(1);
        expect(dispatcher.execute.mock.calls[0][0]).toBeInstanceOf(ReloadSceneCommand);
      } finally {
        delete appState.scenes.descriptors['scene-main'];
      }
    });

    it('fs_write to a non-open file does not dispatch a reload', async () => {
      const storage = makeStorage();
      const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
      const registry = buildRegistry({ storage, dispatcher });
      const result = (await registry.execute('fs_write', {
        path: 'scripts/spin.ts',
        content: 'code',
      })) as Record<string, unknown>;
      expect(result.reloadedScene).toBeUndefined();
      expect(dispatcher.execute).not.toHaveBeenCalled();
    });

    it('str_replace swaps a unique match and leaves the rest intact', async () => {
      const storage = makeStorage();
      storage.files.set('scripts/car.ts', 'const vx = Math.sin(a);\nconst vy = Math.cos(a);\n');
      const registry = buildRegistry({ storage });

      const result = await registry.execute('str_replace', {
        path: 'scripts/car.ts',
        old_string: 'const vx = Math.sin(a);',
        new_string: 'const vx = -Math.sin(a);',
      });

      expect(result).toMatchObject({ ok: true, path: 'scripts/car.ts', replacements: 1 });
      expect(storage.files.get('scripts/car.ts')).toBe(
        'const vx = -Math.sin(a);\nconst vy = Math.cos(a);\n'
      );
    });

    it('str_replace returns the post-edit neighbourhood so the next anchor needs no re-read', async () => {
      const storage = makeStorage();
      const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
      lines[19] = 'const speed = 1;';
      storage.files.set('scripts/big.ts', lines.join('\n'));
      const registry = buildRegistry({ storage });

      const result = (await registry.execute('str_replace', {
        path: 'scripts/big.ts',
        old_string: 'const speed = 1;',
        new_string: 'const speed = 4;',
      })) as Record<string, unknown>;

      const context = result.context as { startLine: number; endLine: number; text: string };
      expect(result.totalLines).toBe(40);
      // Edited line 20, 8 lines of context on each side.
      expect(context).toMatchObject({ startLine: 12, endLine: 28 });
      expect(context.text).toContain('const speed = 4;');
      // Byte-exact against the file as it now is — the agent may copy it into the next old_string.
      const updated = storage.files.get('scripts/big.ts')!.split('\n');
      expect(context.text).toBe(updated.slice(11, 28).join('\n'));
    });

    it('str_replace context is clamped at the file edges and reflects the NEW line count', async () => {
      const storage = makeStorage();
      storage.files.set('scripts/short.ts', 'a\nb\nc');
      const registry = buildRegistry({ storage });

      const result = (await registry.execute('str_replace', {
        path: 'scripts/short.ts',
        old_string: 'b',
        new_string: 'b1\nb2',
      })) as Record<string, unknown>;

      expect(result.totalLines).toBe(4);
      expect(result.context).toEqual({ startLine: 1, endLine: 4, text: 'a\nb1\nb2\nc' });
    });

    it('str_replace omits context when the edited lines alone blow the cap', async () => {
      const storage = makeStorage();
      // One line far past STR_REPLACE_CONTEXT_CHARS — no honest verbatim slice exists.
      storage.files.set('scripts/wide.ts', `const blob = '${'z'.repeat(3000)}';`);
      const registry = buildRegistry({ storage });

      const result = (await registry.execute('str_replace', {
        path: 'scripts/wide.ts',
        old_string: 'const blob',
        new_string: 'const data',
      })) as Record<string, unknown>;

      expect(result.ok).toBe(true);
      expect(result.context).toBeUndefined();
    });

    /**
     * A model writes `\n`; a file checked out on Windows holds `\r\n`. Measured live (P3 of the
     * vibe-vs-chat gap run): every multi-line anchor missed, and the agent fell back to rewriting a
     * whole `main.pix3scene` — the blind full-file rewrite this tool exists to prevent.
     */
    it('str_replace matches a multi-line LF anchor against a CRLF file', async () => {
      const storage = makeStorage();
      storage.files.set(
        'scenes/main.pix3scene',
        'nodes:\r\n  - type: Sprite2D\r\n    name: Player\r\n    position: [0, 0]\r\n'
      );
      const registry = buildRegistry({ storage });

      const result = (await registry.execute('str_replace', {
        path: 'scenes/main.pix3scene',
        old_string: '    name: Player\n    position: [0, 0]',
        new_string: '    name: Player\n    position: [0, 64]',
      })) as Record<string, unknown>;

      expect(result).toMatchObject({ ok: true, replacements: 1 });
      // The replacement is written with the FILE's endings, so a targeted edit never leaves a lone
      // LF behind in an otherwise-CRLF file.
      expect(storage.files.get('scenes/main.pix3scene')).toBe(
        'nodes:\r\n  - type: Sprite2D\r\n    name: Player\r\n    position: [0, 64]\r\n'
      );
      expect(String(result.note)).toMatch(/line endings/);
    });

    it('str_replace matches a CRLF anchor against an LF file', async () => {
      const storage = makeStorage();
      storage.files.set('scripts/car.ts', 'const a = 1;\nconst b = 2;\n');
      const registry = buildRegistry({ storage });

      const result = await registry.execute('str_replace', {
        path: 'scripts/car.ts',
        old_string: 'const a = 1;\r\nconst b = 2;',
        new_string: 'const a = 3;\r\nconst b = 4;',
      });

      expect(result).toMatchObject({ ok: true, replacements: 1 });
      expect(storage.files.get('scripts/car.ts')).toBe('const a = 3;\nconst b = 4;\n');
    });

    /** The fallback is a rescue for a MISS, not a normalizer: an exact match stays byte-for-byte. */
    it('str_replace leaves a mixed-ending file exactly as it found it on an exact match', async () => {
      const storage = makeStorage();
      storage.files.set('scripts/mixed.ts', 'a = 1;\r\nb = 2;\nc = 3;\r\n');
      const registry = buildRegistry({ storage });

      const result = (await registry.execute('str_replace', {
        path: 'scripts/mixed.ts',
        old_string: 'b = 2;',
        new_string: 'b = 9;',
      })) as Record<string, unknown>;

      expect(result.ok).toBe(true);
      expect(result.note).toBeUndefined();
      expect(storage.files.get('scripts/mixed.ts')).toBe('a = 1;\r\nb = 9;\nc = 3;\r\n');
    });

    it('str_replace refuses (no write) when old_string is not found', async () => {
      const storage = makeStorage();
      const registry = buildRegistry({ storage });
      const result = (await registry.execute('str_replace', {
        path: 'scripts/a.ts',
        old_string: 'export const y = 2;',
        new_string: 'whatever',
      })) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/not found/i);
      expect(storage.writeTextFile).not.toHaveBeenCalled();
    });

    it('str_replace requires uniqueness unless replace_all is set', async () => {
      const storage = makeStorage();
      storage.files.set('scripts/dup.ts', 'a;\na;\n');
      const registry = buildRegistry({ storage });

      const ambiguous = (await registry.execute('str_replace', {
        path: 'scripts/dup.ts',
        old_string: 'a;',
        new_string: 'b;',
      })) as Record<string, unknown>;
      expect(ambiguous.ok).toBe(false);
      expect(String(ambiguous.error)).toMatch(/matches 2/);
      expect(storage.writeTextFile).not.toHaveBeenCalled();

      const all = await registry.execute('str_replace', {
        path: 'scripts/dup.ts',
        old_string: 'a;',
        new_string: 'b;',
        replace_all: true,
      });
      expect(all).toMatchObject({ ok: true, replacements: 2 });
      expect(storage.files.get('scripts/dup.ts')).toBe('b;\nb;\n');
    });

    it('str_replace inserts $-patterns in new_string literally (no regex substitution)', async () => {
      const storage = makeStorage();
      storage.files.set('scripts/p.ts', 'const price = 1;');
      const registry = buildRegistry({ storage });
      await registry.execute('str_replace', {
        path: 'scripts/p.ts',
        old_string: 'const price = 1;',
        new_string: 'const label = "$&$1";',
      });
      expect(storage.files.get('scripts/p.ts')).toBe('const label = "$&$1";');
    });

    it('str_replace rejects a binary path', async () => {
      const registry = buildRegistry({ storage: makeStorage() });
      const result = (await registry.execute('str_replace', {
        path: 'art/icon.png',
        old_string: 'a',
        new_string: 'b',
      })) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/binary/i);
    });

    it('fs_delete delegates and bumps fileRefreshSignal', async () => {
      const storage = makeStorage();
      const registry = buildRegistry({ storage });
      const before = appState.project.fileRefreshSignal || 0;
      await registry.execute('fs_delete', { path: 'scripts/a.ts' });
      expect(storage.deleteEntry).toHaveBeenCalledWith('scripts/a.ts');
      expect(appState.project.fileRefreshSignal || 0).toBeGreaterThan(before);
    });

    /**
     * Observed live: the agent deleted two generated references and their `index.json` entries
     * outlived the files, so the sidecar described pictures nobody had.
     */
    it('fs_delete prunes the references index entry, and only under references/', async () => {
      const storage = makeStorage();
      const flowReferences = { removeEntry: vi.fn(async () => undefined) };
      const registry = buildRegistry({ storage, flowReferences });

      await registry.execute('fs_delete', { path: 'references/mood-1.png' });
      expect(flowReferences.removeEntry).toHaveBeenCalledWith('mood-1.png');

      flowReferences.removeEntry.mockClear();
      await registry.execute('fs_delete', { path: 'design/gdd.md' });
      expect(flowReferences.removeEntry).not.toHaveBeenCalled();
    });

    it('rejects paths containing ".."', async () => {
      const registry = buildRegistry({ storage: makeStorage() });
      await expect(registry.execute('fs_read', { path: '../secrets.txt' })).rejects.toThrow(/\.\./);
      await expect(
        registry.execute('fs_write', { path: 'scripts/../../x', content: 'y' })
      ).rejects.toThrow(/\.\./);
      await expect(registry.execute('fs_delete', { path: 'a/../../b' })).rejects.toThrow(/\.\./);
    });

    it('fs_read returns content for text and metadata for binary', async () => {
      const registry = buildRegistry({ storage: makeStorage() });
      expect(await registry.execute('fs_read', { path: 'scripts/a.ts' })).toEqual({
        path: 'scripts/a.ts',
        content: 'export const x = 1;',
        totalLines: 1,
      });
      expect(await registry.execute('fs_read', { path: 'art/icon.png' })).toEqual({
        path: 'art/icon.png',
        binary: true,
        mimeType: 'image/png',
        size: 3,
      });
    });

    /** A file comfortably over FS_READ_FULL_CHARS, so ranged reads are actually honoured. */
    const hugeFile = (lines: number): string =>
      Array.from({ length: lines }, (_, i) => `l${i + 1}${'x'.repeat(200)}`).join('\n');

    it('fs_read returns a line range with offset/limit on a large file', async () => {
      const storage = makeStorage();
      storage.files.set('scripts/big.ts', hugeFile(100));
      const registry = buildRegistry({ storage });
      const all = hugeFile(100).split('\n');

      expect(
        await registry.execute('fs_read', { path: 'scripts/big.ts', offset: 2, limit: 2 })
      ).toEqual({
        path: 'scripts/big.ts',
        content: all.slice(1, 3).join('\n'),
        totalLines: 100,
        startLine: 2,
        endLine: 3,
        hasMore: true,
      });
      // Reading to the end reports hasMore:false.
      expect(await registry.execute('fs_read', { path: 'scripts/big.ts', offset: 99 })).toEqual({
        path: 'scripts/big.ts',
        content: all.slice(98).join('\n'),
        totalLines: 100,
        startLine: 99,
        endLine: 100,
        hasMore: false,
      });
    });

    it('fs_read ignores the range on a SMALL file and hands over the whole thing', async () => {
      // Measured cost of the alternative: six paged re-reads of one 15.4 KB scene in a single turn,
      // because every str_replace shifted the line numbers the agent was paging by.
      const storage = makeStorage();
      storage.files.set('scripts/small.ts', 'l1\nl2\nl3\nl4\nl5');
      const registry = buildRegistry({ storage });

      const result = (await registry.execute('fs_read', {
        path: 'scripts/small.ts',
        offset: 2,
        limit: 2,
      })) as Record<string, unknown>;

      expect(result.content).toBe('l1\nl2\nl3\nl4\nl5');
      expect(result.totalLines).toBe(5);
      expect(result.hasMore).toBeUndefined();
      expect(String(result.note)).toMatch(/whole file/i);
    });

    it('fs_list maps directory entries', async () => {
      const registry = buildRegistry({ storage: makeStorage() });
      expect(await registry.execute('fs_list', { path: 'scenes' })).toEqual([
        { name: 'main.pix3scene', kind: 'file', path: 'scenes/main.pix3scene', size: 42 },
      ]);
    });
  });

  describe('create_node duplicate names', () => {
    /**
     * The create command selects the new node, which is how its id surfaces — so the stub sets
     * primaryNodeId and drops the node into the graph, mimicking the real operation.
     */
    const run = async (existingNames: string[], newName: string) => {
      appState.project.status = 'ready';
      const nodeMap = new Map<string, NodeBase>();
      existingNames.forEach((name, i) =>
        nodeMap.set(`old${i}`, makeNode({ nodeId: `old${i}`, name, type: 'Button2D' }))
      );
      const graph = { rootNodes: [], nodeMap };
      const dispatcher = {
        execute: vi.fn(async (_cmd: unknown) => {
          if (!nodeMap.has('fresh')) {
            nodeMap.set('fresh', makeNode({ nodeId: 'fresh', name: newName, type: 'Button2D' }));
            appState.selection.primaryNodeId = 'fresh';
          }
          return true;
        }),
        executeById: vi.fn(),
      };
      const registry = buildRegistry({
        dispatcher,
        sceneManager: { getActiveSceneGraph: () => graph },
      });
      return (await registry.execute('create_node', {
        nodeType: 'Button2D',
        name: newName,
      })) as Record<string, unknown>;
    };

    it('warns (but still creates) when the name collides with an existing node', async () => {
      const result = await run(['cell-0'], 'cell-0');
      expect(result.ok).toBe(true);
      expect(result.nodeId).toBe('fresh');
      expect(result.duplicateNameNodeIds).toEqual(['old0']);
      expect(String(result.warning)).toMatch(/ambiguous/i);
    });

    it('stays silent when the name is unique', async () => {
      const result = await run(['cell-0'], 'cell-1');
      expect(result.ok).toBe(true);
      expect(result.warning).toBeUndefined();
      expect(result.duplicateNameNodeIds).toBeUndefined();
    });
  });

  describe('move_node', () => {
    /** Parent "P" with children [A, Effects(n1), B]; n1 is the node under test. */
    const makeReorderScene = () => {
      const a = makeNode({ nodeId: 'a', name: 'A' });
      const b = makeNode({ nodeId: 'b', name: 'B' });
      const n1 = makeNode({ nodeId: 'n1', name: 'Effects' });
      const p = makeNode({ nodeId: 'P', name: 'Parent', children: [a, n1, b] });
      // parentNode is a getter-only on NodeBase.prototype — shadow it with an own data property.
      Object.defineProperty(n1, 'parentNode', { value: p, configurable: true });
      const graph = {
        rootNodes: [p],
        nodeMap: new Map([
          ['a', a],
          ['b', b],
          ['n1', n1],
          ['P', p],
        ]),
      };
      return { graph, sceneManager: { getActiveSceneGraph: () => graph } };
    };

    /** Read the private params off the dispatched ReparentNodeCommand. */
    const reparentParams = (cmd: unknown) =>
      (cmd as unknown as { params: { newParentId: string | null; newIndex: number } }).params;

    const run = async (args: Record<string, unknown>) => {
      appState.project.status = 'ready';
      const { sceneManager } = makeReorderScene();
      const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
      const registry = buildRegistry({ dispatcher, sceneManager });
      const result = (await registry.execute('move_node', args)) as Record<string, unknown>;
      return { result, dispatcher };
    };

    it('placement:"front" reorders to the last index among siblings (on top for 2D)', async () => {
      const { result, dispatcher } = await run({ nodeId: 'n1', placement: 'front' });
      expect(result.ok).toBe(true);
      const cmd = dispatcher.execute.mock.calls[0][0];
      expect(cmd).toBeInstanceOf(ReparentNodeCommand);
      // Siblings excluding n1 are [A, B] → front = index 2, parent unchanged.
      expect(reparentParams(cmd)).toMatchObject({ newParentId: 'P', newIndex: 2 });
    });

    it('placement:"back" reorders to index 0 (behind for 2D)', async () => {
      const { dispatcher } = await run({ nodeId: 'n1', placement: 'back' });
      expect(reparentParams(dispatcher.execute.mock.calls[0][0])).toMatchObject({
        newParentId: 'P',
        newIndex: 0,
      });
    });

    it('afterSiblingId places the node just after that sibling', async () => {
      const { dispatcher } = await run({ nodeId: 'n1', afterSiblingId: 'a' });
      // siblings [A, B]; after A → index 1.
      expect(reparentParams(dispatcher.execute.mock.calls[0][0])).toMatchObject({
        newParentId: 'P',
        newIndex: 1,
      });
    });

    it('beforeSiblingId places the node just before that sibling', async () => {
      const { dispatcher } = await run({ nodeId: 'n1', beforeSiblingId: 'b' });
      // siblings [A, B]; before B → index 1.
      expect(reparentParams(dispatcher.execute.mock.calls[0][0])).toMatchObject({
        newParentId: 'P',
        newIndex: 1,
      });
    });

    it('an explicit index is clamped to the sibling count', async () => {
      const { dispatcher } = await run({ nodeId: 'n1', index: 99 });
      expect(reparentParams(dispatcher.execute.mock.calls[0][0])).toMatchObject({
        newParentId: 'P',
        newIndex: 2,
      });
    });

    it('toRoot moves the node to the scene root', async () => {
      const { dispatcher } = await run({ nodeId: 'n1', toRoot: true });
      // Root siblings excluding n1 are [P] → append at index 1.
      expect(reparentParams(dispatcher.execute.mock.calls[0][0])).toMatchObject({
        newParentId: null,
        newIndex: 1,
      });
    });

    it('errors on an unknown afterSiblingId without dispatching', async () => {
      const { result, dispatcher } = await run({ nodeId: 'n1', afterSiblingId: 'ghost' });
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/afterSiblingId/);
      expect(dispatcher.execute).not.toHaveBeenCalled();
    });

    it('errors when the node does not exist', async () => {
      const { result, dispatcher } = await run({ nodeId: 'nope', placement: 'front' });
      expect(result.ok).toBe(false);
      expect(dispatcher.execute).not.toHaveBeenCalled();
    });
  });

  describe('run_command whitelist', () => {
    const allCommands: CommandMeta[] = [
      { metadata: { id: 'scene.add-node', title: 'Add Node', menuPath: 'edit' } },
      { metadata: { id: 'history.undo', title: 'Undo' } },
      { metadata: { id: 'project.open', title: 'Open Project…' } },
    ];
    const makeCommands = () => ({
      getAllCommands: () => allCommands,
      getCommand: (id: string) => allCommands.find(c => c.metadata.id === id),
    });

    it('runs a whitelisted command via the dispatcher', async () => {
      const dispatcher = { executeById: vi.fn(async () => true), execute: vi.fn() };
      const registry = buildRegistry({ commands: makeCommands(), dispatcher });
      expect(await registry.execute('run_command', { commandId: 'scene.add-node' })).toEqual({
        ok: true,
      });
      expect(dispatcher.executeById).toHaveBeenCalledWith('scene.add-node');
    });

    it('refuses a non-whitelisted command without dispatching', async () => {
      const dispatcher = { executeById: vi.fn(async () => true), execute: vi.fn() };
      const registry = buildRegistry({ commands: makeCommands(), dispatcher });
      const result = (await registry.execute('run_command', { commandId: 'project.open' })) as {
        ok: boolean;
        error?: string;
      };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not permitted/);
      expect(dispatcher.executeById).not.toHaveBeenCalled();
    });

    it('reports an unknown command id', async () => {
      const dispatcher = { executeById: vi.fn(async () => true), execute: vi.fn() };
      const registry = buildRegistry({ commands: makeCommands(), dispatcher });
      const result = (await registry.execute('run_command', { commandId: 'bogus.thing' })) as {
        ok: boolean;
        error?: string;
      };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Unknown command/);
      expect(dispatcher.executeById).not.toHaveBeenCalled();
    });

    it('list_commands marks which commands the agent may run', async () => {
      const registry = buildRegistry({ commands: makeCommands() });
      const list = (await registry.execute('list_commands')) as Array<{
        id: string;
        allowed: boolean;
      }>;
      const byId = Object.fromEntries(list.map(c => [c.id, c.allowed]));
      expect(byId['scene.add-node']).toBe(true);
      expect(byId['history.undo']).toBe(true);
      expect(byId['project.open']).toBe(false);
    });
  });

  it('set_property routes through UpdateObjectPropertyCommand on the dispatcher', async () => {
    const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
    const registry = buildRegistry({ dispatcher, sceneManager: activeSceneManager() });
    const result = await registry.execute('set_property', {
      nodeId: 'n1',
      propertyPath: 'position.x',
      value: 5,
    });
    expect(result).toEqual({ ok: true });
    // The mutation, then the durability save (agent edits must survive scene reloads).
    expect(dispatcher.execute).toHaveBeenCalledTimes(2);
    expect(dispatcher.execute.mock.calls[0][0]).toBeInstanceOf(UpdateObjectPropertyCommand);
    expect(dispatcher.execute.mock.calls[1][0]).toBeInstanceOf(SaveSceneCommand);
  });

  describe('set_property value-shape guard', () => {
    // A fake node whose schema exposes a vector2 `position`, so coercePropertyValue engages.
    const makeVectorNode = (): NodeBase => {
      const node = Object.create(NodeBase.prototype) as Record<string, unknown>;
      Object.assign(node, { nodeId: 'v1', type: 'Sprite2D', name: 'Car' });
      Object.defineProperty(node, 'constructor', {
        value: {
          getPropertySchema: () => ({
            nodeType: 'FakeNode2D',
            properties: [
              {
                name: 'position',
                type: 'vector2',
                ui: {},
                getValue: () => ({ x: 0, y: 0 }),
                setValue: () => {},
              },
            ],
          }),
        },
        configurable: true,
      });
      return node as unknown as NodeBase;
    };
    const vectorSceneManager = () => ({
      getActiveSceneGraph: () => ({ nodeMap: new Map([['v1', makeVectorNode()]]) }),
    });
    const readValue = (cmd: unknown): unknown =>
      (cmd as { params: { value: unknown } }).params.value;

    it('coerces a [x, y] array to { x, y } for a vector2 property', async () => {
      const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
      const registry = buildRegistry({ dispatcher, sceneManager: vectorSceneManager() });
      const result = await registry.execute('set_property', {
        nodeId: 'v1',
        propertyPath: 'position',
        value: [10, 350],
      });
      expect(result).toEqual({ ok: true });
      expect(readValue(dispatcher.execute.mock.calls[0][0])).toEqual({ x: 10, y: 350 });
    });

    it('passes a valid { x, y } object through unchanged', async () => {
      const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
      const registry = buildRegistry({ dispatcher, sceneManager: vectorSceneManager() });
      const result = await registry.execute('set_property', {
        nodeId: 'v1',
        propertyPath: 'position',
        value: { x: 10, y: 350 },
      });
      expect(result).toEqual({ ok: true });
      expect(readValue(dispatcher.execute.mock.calls[0][0])).toEqual({ x: 10, y: 350 });
    });

    it('rejects a bad vector shape with an error and does not dispatch', async () => {
      const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
      const registry = buildRegistry({ dispatcher, sceneManager: vectorSceneManager() });
      const result = (await registry.execute('set_property', {
        nodeId: 'v1',
        propertyPath: 'position',
        value: 42,
      })) as { ok: boolean; error?: string };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/vector2/);
      expect(dispatcher.execute).not.toHaveBeenCalled();
    });

    it('parses a stringified JSON object value for a vector2 property (provider quirk)', async () => {
      // Some OpenAI-compatible providers deliver the untyped `value` argument as a JSON string;
      // without parsing it, this exact shape failed 6× in a real session and the model gave up on
      // set_property to hand-edit the scene file.
      const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
      const registry = buildRegistry({ dispatcher, sceneManager: vectorSceneManager() });
      const result = await registry.execute('set_property', {
        nodeId: 'v1',
        propertyPath: 'position',
        value: '{"x":-300,"y":-259.8}',
      });
      expect(result).toEqual({ ok: true });
      expect(readValue(dispatcher.execute.mock.calls[0][0])).toEqual({ x: -300, y: -259.8 });
    });

    it('parses a stringified JSON array value for a vector2 property', async () => {
      const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
      const registry = buildRegistry({ dispatcher, sceneManager: vectorSceneManager() });
      const result = await registry.execute('set_property', {
        nodeId: 'v1',
        propertyPath: 'position',
        value: '[10, 350]',
      });
      expect(result).toEqual({ ok: true });
      expect(readValue(dispatcher.execute.mock.calls[0][0])).toEqual({ x: 10, y: 350 });
    });
  });

  describe('game input tools', () => {
    it('game_input forwards steps, observe, settleMs and expect to the service', async () => {
      const run = vi.fn(async () => ({ ok: true, stepsRun: 1 }));
      const registry = buildRegistry({ gameInput: { run } });
      await registry.execute('game_input', {
        steps: [{ type: 'key', code: 'KeyW', ms: 100 }],
        observe: ['Player'],
        settleMs: 50,
        expect: { Player: 'forward' },
      });
      expect(run).toHaveBeenCalledWith([{ type: 'key', code: 'KeyW', ms: 100 }], {
        observe: ['Player'],
        settleMs: 50,
        expect: { Player: 'forward' },
      });
    });

    it('game_input passes a frame-denominated step through verbatim', async () => {
      const run = vi.fn(async () => ({ ok: true, stepsRun: 1 }));
      const registry = buildRegistry({ gameInput: { run } });
      await registry.execute('game_input', {
        steps: [{ type: 'key', code: 'ArrowLeft', frames: 8 }],
      });
      expect(run).toHaveBeenCalledWith([{ type: 'key', code: 'ArrowLeft', frames: 8 }], {
        observe: undefined,
        settleMs: undefined,
        expect: undefined,
      });
    });

    it('game_observe forwards node queries and the sample window', async () => {
      const observe = vi.fn(async () => ({ ok: true }));
      const registry = buildRegistry({ gameInput: { observe } });
      await registry.execute('game_observe', { nodes: ['AICar'], sampleMs: 1000 });
      expect(observe).toHaveBeenCalledWith(['AICar'], 1000, undefined);
    });

    // The frame budget is passed positionally after `sampleMs`. Pinning the call
    // shape here is deliberate: the schema advertises `frames` to the model, so a
    // GameInputService that grew a different parameter shape must fail loudly
    // rather than quietly ignore a budget the agent believes it set.
    it('game_observe forwards a frame budget alongside sampleMs', async () => {
      const observe = vi.fn(async () => ({ ok: true }));
      const registry = buildRegistry({ gameInput: { observe } });
      await registry.execute('game_observe', { nodes: ['Player'], frames: 90 });
      expect(observe).toHaveBeenCalledWith(['Player'], 0, 90);
    });

    it('game_controls lists the live interactive nodes', async () => {
      const listControls = vi.fn(() => ({ ok: true, controls: [] }));
      const registry = buildRegistry({ gameInput: { listControls } });
      await expect(registry.execute('game_controls')).resolves.toEqual({ ok: true, controls: [] });
      expect(listControls).toHaveBeenCalledTimes(1);
    });

    // The semantic step carries two fields no other step has; a schema that dropped them would
    // leave the model writing invocations the handler silently turns into no-ops.
    it('game_input forwards an invoke step whole, interaction and args included', async () => {
      const run = vi.fn(async () => ({ ok: true }));
      const registry = buildRegistry({ gameInput: { run } });
      const step = {
        type: 'invoke',
        target: 'Volume',
        interaction: 'setValue',
        args: { value: 0.5 },
      };
      await registry.execute('game_input', { steps: [step] });
      expect(run).toHaveBeenCalledWith([step], {
        observe: undefined,
        settleMs: undefined,
        expect: undefined,
      });
      const schema = registry.list().find(tool => tool.name === 'game_input')!.inputSchema;
      const stepSchema = (
        schema.properties as { steps: { items: { properties: Record<string, unknown> } } }
      ).steps.items.properties;
      expect((stepSchema.type as { enum: string[] }).enum).toContain('invoke');
      expect(stepSchema.interaction).toBeDefined();
      expect(stepSchema.args).toBeDefined();
    });
  });

  describe('game_trace tool', () => {
    /** A GameTestService stand-in that also owns a swappable trace store. */
    const makeGameTest = (store: TraceStore = new InMemoryTraceStore()) => {
      let current = store;
      return {
        recordTrace: vi.fn(async () => ({ ok: true, tracePath: 'design/tests/x.trace.json' })),
        replayTrace: vi.fn(async () => ({ ok: true, replay: { verdict: 'REPLAY MATCH' } })),
        getTraceStore: () => current,
        setTraceStore: vi.fn((next: TraceStore) => {
          current = next;
        }),
      };
    };

    const withProject = (status: 'ready' | 'idle') => {
      appState.project.status = status;
    };

    afterEach(() => {
      appState.project.status = 'idle';
    });

    it('record forwards the run spec, name, seed and frame-denominated feed unaltered', async () => {
      const gameTest = makeGameTest();
      const registry = buildRegistry({ gameTest });
      await registry.execute('game_trace', {
        mode: 'record',
        name: 'snake-eats',
        seed: 42,
        until: [{ kind: 'gameStateChanged', path: 'score', by: 1 }],
        maxFrames: 120,
        feed: [
          { frame: 1, kind: 'key', phase: 'down', code: 'ArrowLeft' },
          { frame: 9, kind: 'key', phase: 'up', code: 'ArrowLeft' },
        ],
      });
      expect(gameTest.recordTrace).toHaveBeenCalledTimes(1);
      const [spec, options] = gameTest.recordTrace.mock.calls[0] as unknown as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(spec.until).toEqual([{ kind: 'gameStateChanged', path: 'score', by: 1 }]);
      expect(spec.maxFrames).toBe(120);
      expect(options).toEqual({
        name: 'snake-eats',
        seed: 42,
        feed: [
          { frame: 1, kind: 'key', phase: 'down', code: 'ArrowLeft' },
          { frame: 9, kind: 'key', phase: 'up', code: 'ArrowLeft' },
        ],
      });
    });

    it('replay forwards the trace name and tolerance, with no spec when none was asked for', async () => {
      const gameTest = makeGameTest();
      const registry = buildRegistry({ gameTest });
      await registry.execute('game_trace', {
        mode: 'replay',
        name: 'snake-eats',
        tolerance: { framePct: 0.1 },
      });
      expect(gameTest.replayTrace).toHaveBeenCalledWith('snake-eats', undefined, {
        tolerance: { framePct: 0.1 },
      });
    });

    it('replay passes an explicit spec through when the caller supplied one', async () => {
      const gameTest = makeGameTest();
      const registry = buildRegistry({ gameTest });
      await registry.execute('game_trace', {
        mode: 'replay',
        name: 'snake-eats',
        until: [{ kind: 'frames', n: 30 }],
      });
      const [name, spec] = gameTest.replayTrace.mock.calls[0] as unknown as [
        string,
        { until: unknown[] },
      ];
      expect(name).toBe('snake-eats');
      expect(spec.until).toEqual([{ kind: 'frames', n: 30 }]);
    });

    it('list enumerates the stored traces', async () => {
      const store = new InMemoryTraceStore();
      await store.save('design/tests/a.trace.json', makeStoredTrace('a'));
      const registry = buildRegistry({ gameTest: makeGameTest(store) });
      await expect(registry.execute('game_trace', { mode: 'list' })).resolves.toEqual({
        ok: true,
        traces: ['design/tests/a.trace.json'],
      });
    });

    it('rejects a malformed feed event before the game is touched', async () => {
      const gameTest = makeGameTest();
      const registry = buildRegistry({ gameTest });
      const result = (await registry.execute('game_trace', {
        mode: 'record',
        name: 'bad',
        until: [{ kind: 'frames', n: 10 }],
        feed: [{ frame: 0, kind: 'key', phase: 'down', code: 'KeyA' }],
      })) as { ok: boolean; error?: string };
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/`frame` must be a number >= 1/);
      expect(gameTest.recordTrace).not.toHaveBeenCalled();
    });

    it('requires a mode and a name', async () => {
      const registry = buildRegistry({ gameTest: makeGameTest() });
      await expect(registry.execute('game_trace', {})).resolves.toMatchObject({ ok: false });
      await expect(registry.execute('game_trace', { mode: 'replay' })).resolves.toMatchObject({
        ok: false,
      });
    });

    // The point of the file backend: with a project open the traces are files;
    // with none open the service keeps its in-memory default rather than writing
    // into nowhere.
    it('installs the project-file store only while a project is open', async () => {
      const gameTest = makeGameTest();
      const registry = buildRegistry({ gameTest, storage: { listDirectory: async () => [] } });
      withProject('ready');
      await registry.execute('game_trace', { mode: 'list' });
      expect(gameTest.getTraceStore()).toBeInstanceOf(ProjectTraceStore);

      withProject('idle');
      await registry.execute('game_trace', { mode: 'list' });
      expect(gameTest.getTraceStore()).toBeInstanceOf(InMemoryTraceStore);
    });

    it('leaves a store somebody else installed alone', async () => {
      const custom: TraceStore = {
        save: async () => {},
        load: async () => null,
        list: async () => ['design/tests/custom.trace.json'],
      };
      const gameTest = makeGameTest(custom);
      const registry = buildRegistry({ gameTest, storage: { listDirectory: async () => [] } });
      withProject('ready');
      await registry.execute('game_trace', { mode: 'list' });
      expect(gameTest.setTraceStore).not.toHaveBeenCalled();
      expect(gameTest.getTraceStore()).toBe(custom);
    });
  });

  describe('component tools', () => {
    const makeScriptRegistry = () => ({
      getAllComponentTypes: () => [
        {
          id: 'core:Rotate',
          displayName: 'Rotate',
          category: 'Behaviour',
          description: 'Spins a node.',
        },
      ],
      getComponentType: (id: string) => (id === 'core:Rotate' ? { id } : undefined),
      getComponentPropertySchema: (id: string) =>
        id === 'core:Rotate'
          ? { properties: [{ name: 'speed', type: 'number', ui: { label: 'Speed' } }] }
          : null,
    });

    it('list_component_types maps types with their property schema', async () => {
      const registry = buildRegistry({ scriptRegistry: makeScriptRegistry() });
      const types = (await registry.execute('list_component_types')) as Array<{
        id: string;
        properties: Array<{ name: string; type: string; label?: string }>;
      }>;
      expect(types).toEqual([
        {
          id: 'core:Rotate',
          displayName: 'Rotate',
          category: 'Behaviour',
          description: 'Spins a node.',
          properties: [{ name: 'speed', type: 'number', label: 'Speed' }],
        },
      ]);
    });

    it('add_component routes through AddComponentCommand and returns a componentId', async () => {
      const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
      const registry = buildRegistry({
        dispatcher,
        scriptRegistry: makeScriptRegistry(),
        sceneManager: activeSceneManager(),
      });
      const result = (await registry.execute('add_component', {
        nodeId: 'n1',
        componentType: 'core:Rotate',
        config: { speed: 2 },
      })) as { ok: boolean; componentId?: string };
      expect(result.ok).toBe(true);
      expect(typeof result.componentId).toBe('string');
      expect(dispatcher.execute.mock.calls[0][0]).toBeInstanceOf(AddComponentCommand);
    });

    it('add_component rejects an unknown component type without dispatching', async () => {
      const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
      const registry = buildRegistry({
        dispatcher,
        scriptRegistry: makeScriptRegistry(),
        sceneManager: activeSceneManager(),
      });
      const result = (await registry.execute('add_component', {
        nodeId: 'n1',
        componentType: 'core:Nope',
      })) as { ok: boolean; error?: string };
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/Unknown component type/);
      expect(dispatcher.execute).not.toHaveBeenCalled();
    });

    it('set_component_property routes through UpdateComponentPropertyCommand', async () => {
      const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
      const registry = buildRegistry({ dispatcher, sceneManager: activeSceneManager() });
      const result = await registry.execute('set_component_property', {
        nodeId: 'n1',
        componentId: 'c1',
        propertyName: 'speed',
        value: 3,
      });
      expect(result).toEqual({ ok: true });
      expect(dispatcher.execute.mock.calls[0][0]).toBeInstanceOf(UpdateComponentPropertyCommand);
    });

    it('remove_component routes through RemoveComponentCommand', async () => {
      const dispatcher = { execute: vi.fn(async (_cmd: unknown) => true), executeById: vi.fn() };
      const registry = buildRegistry({ dispatcher, sceneManager: activeSceneManager() });
      const result = await registry.execute('remove_component', {
        nodeId: 'n1',
        componentId: 'c1',
      });
      expect(result).toEqual({ ok: true });
      expect(dispatcher.execute.mock.calls[0][0]).toBeInstanceOf(RemoveComponentCommand);
    });

    it('node_inspect surfaces componentId / componentType / enabled', async () => {
      const node = makeNode({
        components: [{ id: 'c1', type: 'core:Rotate', enabled: true, config: { speed: 1 } }],
      });
      const sceneManager = {
        getActiveSceneGraph: () => ({ nodeMap: new Map([['n1', node]]) }),
      };
      const registry = buildRegistry({ sceneManager });
      const dto = (await registry.execute('node_inspect', { nodeId: 'n1' })) as {
        components: Array<{ componentId: string; componentType: string; enabled: boolean }>;
      };
      expect(dto.components[0]).toMatchObject({
        componentId: 'c1',
        componentType: 'core:Rotate',
        enabled: true,
      });
    });
  });

  it('auto-opens the project scene when a scene-dependent tool runs with no active scene', async () => {
    const dispatcher = { executeById: vi.fn(async () => true), execute: vi.fn() };
    let graph: unknown = null;
    const sceneManager = { getActiveSceneGraph: () => graph };
    const focusOrOpenScene = vi.fn(async () => {
      graph = { nodeMap: new Map(), rootNodes: [], version: 'v1' };
    });
    const registry = buildRegistry({ dispatcher, sceneManager, editorTabs: { focusOrOpenScene } });

    expect(await registry.execute('play_start')).toEqual({ ok: true });
    expect(focusOrOpenScene).toHaveBeenCalledWith('res://scenes/main.pix3scene');
    expect(dispatcher.executeById).toHaveBeenCalledWith('game.start');
  });

  describe('play_status renders-what triage', () => {
    /**
     * A camera looking down -Z from z = 10 and one box at the origin — the smallest scene
     * where "the camera sees the content" and "the camera is turned around" differ.
     */
    const makeScene = (turnCameraAround: boolean, withGround = false) => {
      const root = new Node3D({ id: 'root', name: 'World' });
      const camera = new Camera3D({ id: 'cam', name: 'MainCamera' });
      camera.position.set(0, 0, 10);
      if (turnCameraAround) {
        // A camera a script has aimed the wrong way: every node is present, visible and lit,
        // and the 3D pass still draws nothing.
        camera.rotation.set(0, Math.PI, 0);
      }
      const cube = new GeometryMesh({ id: 'cube', name: 'Cube', geometry: 'box', size: [1, 1, 1] });
      root.add(camera);
      root.add(cube);
      if (withGround) {
        // A wide, flat ground: its bounding SPHERE keeps clipping the frustum from a camera
        // pointed the other way, which is how the frustum count alone reads a black frame as
        // "something is visible". Measured on the real scene this was built for.
        root.add(
          new GeometryMesh({ id: 'ground', name: 'Ground', geometry: 'box', size: [40, 0.2, 40] })
        );
      }
      return { root, camera };
    };

    const makeRegistry = (turnCameraAround: boolean, withGround = false) => {
      const { root, camera } = makeScene(turnCameraAround, withGround);
      return buildRegistry({
        playSession: {
          getActiveRuntime: () => ({
            runner: {
              getLiveRootNodes: () => [root],
              getActiveCamera3D: () => camera,
            },
            // Read straight off the renderer so the answer does not depend on whether a
            // Profiler panel happens to be sampling -- it is not, in Vibe.
            renderer: {
              getStatsSnapshot: () => ({
                calls: 4,
                triangles: 18,
                geometries: 31,
                textures: 3,
              }),
            },
            canvas: document.createElement('canvas'),
            windowRef: window,
          }),
        },
      });
    };

    it('counts the meshes the active camera can see, and reports the renderer counters', async () => {
      appState.ui.isPlaying = true;
      const result = (await makeRegistry(false).execute('play_status')) as Record<string, unknown>;
      appState.ui.isPlaying = false;

      expect(result.render).toEqual({
        drawCalls: 4,
        triangles: 18,
        geometries: 31,
        textures: 3,
      });
      expect(result.visible3D).toEqual({
        camera: 'MainCamera',
        meshCount: 1,
        inFrustum: 1,
        onScreen: 1,
      });
    });

    it('reports zero in frustum and names the causes when the camera is aimed away', async () => {
      appState.ui.isPlaying = true;
      const result = (await makeRegistry(true).execute('play_status')) as Record<string, unknown>;
      appState.ui.isPlaying = false;

      const visible = result.visible3D as {
        meshCount: number;
        inFrustum: number;
        onScreen: number;
        hint: string;
      };
      // The scene still HAS its content — the reading that separates "aimed wrong" from "empty".
      expect(visible.meshCount).toBe(1);
      expect(visible.inFrustum).toBe(0);
      expect(visible.onScreen).toBe(0);
      expect(visible.hint).toMatch(/aimed away/);
      expect(visible.hint).toMatch(/forward/);
    });

    it('still calls it out when one oversized mesh keeps clipping the frustum', async () => {
      appState.ui.isPlaying = true;
      const result = (await makeRegistry(true, true).execute('play_status')) as Record<
        string,
        unknown
      >;
      appState.ui.isPlaying = false;

      const visible = result.visible3D as {
        meshCount: number;
        inFrustum: number;
        onScreen: number;
        hint: string;
      };
      expect(visible.meshCount).toBe(2);
      // The ground's bounding sphere reaches into the frustum even though the camera is turned
      // away — the exact false positive that would have silenced the hint.
      expect(visible.inFrustum).toBeGreaterThan(0);
      expect(visible.onScreen).toBe(0);
      expect(visible.hint).toMatch(/aimed away/);
    });

    it('stays the plain two-field answer when no runtime is attached', async () => {
      appState.ui.isPlaying = false;
      const registry = buildRegistry({ playSession: { getActiveRuntime: () => null } });
      expect(await registry.execute('play_status')).toEqual({
        isPlaying: false,
        playModeStatus: appState.ui.playModeStatus,
      });
    });
  });

  it('play tools drive the game.* commands and report status', async () => {
    const dispatcher = { executeById: vi.fn(async () => true), execute: vi.fn() };
    const registry = buildRegistry({ dispatcher, sceneManager: activeSceneManager() });
    expect(await registry.execute('play_start')).toEqual({ ok: true });
    expect(dispatcher.executeById).toHaveBeenCalledWith('game.start');

    appState.ui.isPlaying = true;
    appState.ui.playModeStatus = 'playing';
    expect(await registry.execute('play_status')).toEqual({
      isPlaying: true,
      playModeStatus: 'playing',
    });
    appState.ui.isPlaying = false;
  });

  describe('introspection tools', () => {
    const graph = {
      description: 'Scene',
      version: 'v1',
      rootNodes: [makeNode()],
      nodeMap: new Map<string, NodeBase>([['n1', makeNode({ name: 'Cube', type: 'Node3D' })]]),
    };
    const sceneManager = { getActiveSceneGraph: () => graph };

    it('scene_tree returns a wrapped tree with the scene version', async () => {
      const registry = buildRegistry({ sceneManager });
      const tree = (await registry.execute('scene_tree', { maxDepth: 2 })) as {
        nodeId: string;
        sceneVersion: string;
        children: unknown[];
      };
      expect(tree.nodeId).toBe('<scene-root>');
      expect(tree.sceneVersion).toBe('v1');
      expect(tree.children).toHaveLength(1);
    });

    it('find_nodes searches name and type', async () => {
      const registry = buildRegistry({ sceneManager });
      const matches = (await registry.execute('find_nodes', { text: 'cub' })) as unknown[];
      expect(matches).toEqual([{ nodeId: 'n1', type: 'Node3D', name: 'Cube' }]);
    });

    it('get_selection reads appState selection', async () => {
      appState.selection.nodeIds = ['n1', 'n2'];
      appState.selection.primaryNodeId = 'n1';
      appState.selection.hoveredNodeId = null;
      const result = await buildRegistry().execute('get_selection');
      expect(result).toEqual({ nodeIds: ['n1', 'n2'], primaryNodeId: 'n1', hoveredNodeId: null });
    });
  });

  it('compile_scripts returns a no-entry result when no Script subclasses exist', async () => {
    const storage = {
      listDirectory: vi.fn(async (dir: string) =>
        dir === 'scripts'
          ? [{ name: 'a.ts', kind: 'file' as const, path: 'scripts/a.ts', size: 1 }]
          : []
      ),
      readTextFile: vi.fn(async () => 'export const x = 1;'),
    };
    const registry = buildRegistry({ storage });
    const result = (await registry.execute('compile_scripts')) as { ok: boolean; message?: string };
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/No Script subclasses/);
  });

  it('compile_scripts re-registers scripts through the project script loader after a bundle', async () => {
    const storage = {
      listDirectory: vi.fn(async (dir: string) =>
        dir === 'scripts'
          ? [{ name: 'Car.ts', kind: 'file' as const, path: 'scripts/Car.ts', size: 1 }]
          : []
      ),
      readTextFile: vi.fn(async () => 'export class Car extends Script {}'),
    };
    const compiler = { bundle: vi.fn(async () => ({ code: 'js', warnings: [] })) };
    const projectScriptLoader = {
      syncAndBuild: vi.fn(async () => undefined),
      ensureReady: vi.fn(async () => undefined),
    };
    const registry = buildRegistry({ storage, compiler, projectScriptLoader });
    const result = (await registry.execute('compile_scripts')) as {
      ok: boolean;
      registered?: boolean;
    };
    expect(result.ok).toBe(true);
    expect(result.registered).toBe(true);
    expect(projectScriptLoader.syncAndBuild).toHaveBeenCalledTimes(1);
    expect(projectScriptLoader.ensureReady).toHaveBeenCalledTimes(1);
  });

  it('compile_scripts reports type errors from its own check instead of a bare ok', async () => {
    const storage = {
      listDirectory: vi.fn(async (dir: string) =>
        dir === 'scripts'
          ? [{ name: 'Car.ts', kind: 'file' as const, path: 'scripts/Car.ts', size: 1 }]
          : []
      ),
      readTextFile: vi.fn(async () => 'export class Car extends Script {}'),
    };
    const compiler = { bundle: vi.fn(async () => ({ code: 'js', warnings: [] })) };
    const projectScriptLoader = {
      syncAndBuild: vi.fn(async () => undefined),
      ensureReady: vi.fn(async () => undefined),
    };
    const diagnostics = {
      checkProject: vi.fn(async () => ({
        filesChecked: 1,
        errorCount: 1,
        warningCount: 0,
        diagnostics: [
          {
            file: 'scripts/Car.ts',
            line: 3,
            column: 5,
            message: "Property 'setText' does not exist on type 'Button2D'.",
            category: 'error',
            code: 2339,
          },
        ],
      })),
    };
    const registry = buildRegistry({ storage, compiler, projectScriptLoader, diagnostics });
    const result = (await registry.execute('compile_scripts')) as {
      ok: boolean;
      bundled?: boolean;
      registered?: boolean;
      errorCount?: number;
      diagnostics?: unknown[];
      message?: string;
    };
    // The bundle succeeded and registered, but types are broken: `ok` must be false so the agent
    // fixes it now instead of learning about it from a separate check_scripts three turns later.
    expect(result.ok).toBe(false);
    expect(result.bundled).toBe(true);
    expect(result.registered).toBe(true);
    expect(result.errorCount).toBe(1);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.message).toMatch(/check_scripts/);
    expect(diagnostics.checkProject).toHaveBeenCalledTimes(1);
  });

  it('compile_scripts stays green when the type-checker itself is unavailable', async () => {
    const storage = {
      listDirectory: vi.fn(async (dir: string) =>
        dir === 'scripts'
          ? [{ name: 'Car.ts', kind: 'file' as const, path: 'scripts/Car.ts', size: 1 }]
          : []
      ),
      readTextFile: vi.fn(async () => 'export class Car extends Script {}'),
    };
    const compiler = { bundle: vi.fn(async () => ({ code: 'js', warnings: [] })) };
    const projectScriptLoader = {
      syncAndBuild: vi.fn(async () => undefined),
      ensureReady: vi.fn(async () => undefined),
    };
    const diagnostics = {
      checkProject: vi.fn(async () => {
        throw new Error('monaco failed to load');
      }),
    };
    const registry = buildRegistry({ storage, compiler, projectScriptLoader, diagnostics });
    const result = (await registry.execute('compile_scripts')) as {
      ok: boolean;
      typeCheck?: string;
    };
    expect(result.ok).toBe(true);
    expect(result.typeCheck).toBe('unavailable');
  });

  /**
   * The gameplay-testing tools. What is worth pinning here is only the tool
   * layer: that the runner is reached through GamePlaySessionService, that the
   * runtime's *throwing* config validator reaches the agent as a sentence, and
   * that a spec is forwarded whole. The loop itself is GameTestService's spec.
   */
  describe('game_time', () => {
    interface FakeRunner {
      paused: boolean;
      running: boolean;
      getTimeMode: () => Record<string, unknown>;
      setTimeMode: ReturnType<typeof vi.fn>;
      stepFrames: ReturnType<typeof vi.fn>;
    }

    const makeRunner = (over: Partial<FakeRunner> = {}): FakeRunner => {
      let config: Record<string, unknown> = {
        mode: 'realtime',
        fixedDeltaSec: 1 / 60,
        ticksPerFrame: 1,
        renderEveryNTicks: 1,
        muteAudio: true,
      };
      const runner: FakeRunner = {
        paused: false,
        running: true,
        getTimeMode: () => ({ ...config }),
        setTimeMode: vi.fn((next: Record<string, unknown>) => {
          config = { ...next };
        }),
        stepFrames: vi.fn((count: number) => (runner.paused || !runner.running ? 0 : (count ?? 1))),
        ...over,
      };
      return runner;
    };

    const registryFor = (runner: FakeRunner) =>
      buildRegistry({
        playSession: {
          getActiveRuntime: () => ({ runner, canvas: {}, windowRef: {} }),
        },
      });

    beforeEach(() => {
      appState.ui.isPlaying = true;
    });

    afterEach(() => {
      appState.ui.isPlaying = false;
    });

    it('returns the RESOLVED config, not the requested one, and names what was clamped', async () => {
      const runner = makeRunner();
      const result = (await registryFor(runner).execute('game_time', {
        mode: 'fixed',
        ticksPerFrame: 1000,
      })) as { ok: boolean; time?: Record<string, unknown>; notes?: string[] };

      expect(result.ok).toBe(true);
      // 1000 is above MAX_TICKS_PER_FRAME, and renderEveryNTicks defaults to
      // ticksPerFrame in 'fixed' — neither is what the caller typed.
      expect(result.time).toMatchObject({
        mode: 'fixed',
        ticksPerFrame: 240,
        renderEveryNTicks: 240,
      });
      expect(result.notes?.join(' ')).toMatch(/ticksPerFrame 1000 was clamped to 240/);
    });

    it('reports how many ticks ACTUALLY ran', async () => {
      const runner = makeRunner();
      const result = (await registryFor(runner).execute('game_time', {
        mode: 'manual',
        step: 12,
      })) as { ok: boolean; ticksExecuted?: number; time?: Record<string, unknown> };

      expect(runner.stepFrames).toHaveBeenCalledWith(12);
      expect(result.ticksExecuted).toBe(12);
      expect(result.time).toMatchObject({ mode: 'manual' });
    });

    it('explains a short step batch instead of reporting a bare 0', async () => {
      const runner = makeRunner({ paused: true });
      const result = (await registryFor(runner).execute('game_time', {
        mode: 'manual',
        step: 5,
      })) as { ok: boolean; ticksExecuted?: number; paused?: boolean; notes?: string[] };

      expect(result.ticksExecuted).toBe(0);
      expect(result.paused).toBe(true);
      expect(result.notes?.join(' ')).toMatch(/0\/5 ticks ran.*PAUSED/);
    });

    it('turns the validator throw into a readable error and leaves the clock alone', async () => {
      const runner = makeRunner();
      const result = (await registryFor(runner).execute('game_time', { mode: 'turbo' })) as {
        ok: boolean;
        error?: string;
        time?: Record<string, unknown>;
      };

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/realtime.*fixed.*manual/);
      expect(result.error).toMatch(/left unchanged/);
      expect(runner.setTimeMode).not.toHaveBeenCalled();
      expect(result.time).toMatchObject({ mode: 'realtime' });
    });

    it('rejects a non-positive fixedDeltaSec without touching the runner', async () => {
      const runner = makeRunner();
      const result = (await registryFor(runner).execute('game_time', {
        mode: 'fixed',
        fixedDeltaSec: 0,
      })) as { ok: boolean; error?: string };

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/fixedDeltaSec must be a finite number > 0/);
      expect(runner.setTimeMode).not.toHaveBeenCalled();
    });

    it('requires `mode` when any other config field is sent (the config replaces, never merges)', async () => {
      const runner = makeRunner();
      const result = (await registryFor(runner).execute('game_time', { ticksPerFrame: 4 })) as {
        ok: boolean;
        error?: string;
      };

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/`mode` is required/);
      expect(runner.setTimeMode).not.toHaveBeenCalled();
    });

    it('refuses `step` outside manual BEFORE writing the config', async () => {
      const runner = makeRunner();
      const result = (await registryFor(runner).execute('game_time', {
        mode: 'fixed',
        step: 3,
      })) as { ok: boolean; error?: string };

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/only advances the game in 'manual'/);
      expect(runner.setTimeMode).not.toHaveBeenCalled();
      expect(runner.stepFrames).not.toHaveBeenCalled();
    });

    it('reads the current contract back when given nothing', async () => {
      const runner = makeRunner();
      const result = (await registryFor(runner).execute('game_time')) as {
        ok: boolean;
        time?: Record<string, unknown>;
      };

      expect(result.ok).toBe(true);
      expect(result.time).toMatchObject({ mode: 'realtime' });
      expect(runner.setTimeMode).not.toHaveBeenCalled();
    });

    it('says the game is not running rather than acting on nothing', async () => {
      appState.ui.isPlaying = false;
      const result = (await registryFor(makeRunner()).execute('game_time', {
        mode: 'manual',
      })) as { ok: boolean; error?: string };

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not running.*play_start/);
    });
  });

  describe('game_run', () => {
    /**
     * A GameTestService stand-in for the `game_run` handler.
     *
     * The handler installs the report backend before either branch runs
     * (`ensureProtocolStore`), so a fake with only `run` is not a lighter fake — it
     * is one the handler cannot drive at all. The two accessors mirror the service
     * exactly, `null` default included: the fallback with no project open is the
     * absence of a store, not an in-memory one, because a protocol the agent is
     * told to `fs_read` and cannot read is worse than an admitted loss.
     */
    const makeRunGameTest = <T>(run: T) => {
      let protocolStore: RunProtocolStore | null = null;
      return {
        run,
        getProtocolStore: () => protocolStore,
        setProtocolStore: vi.fn((next: RunProtocolStore | null) => {
          protocolStore = next;
        }),
      };
    };

    it('forwards the parsed spec to GameTestService and returns its report', async () => {
      const report = { ok: true, verdict: 'PASS until[0] score by +1 (frame 12)' };
      const gameTest = makeRunGameTest(vi.fn(async () => report));
      const registry = buildRegistry({ gameTest });

      const result = await registry.execute('game_run', {
        until: [{ kind: 'gameStateChanged', path: 'score', by: 1 }],
        fail: [{ kind: 'newErrors' }],
        watch: ['Player'],
        maxFrames: 300,
      });

      expect(result).toBe(report);
      expect(gameTest.run).toHaveBeenCalledWith({
        until: [{ kind: 'gameStateChanged', path: 'score', by: 1 }],
        fail: [{ kind: 'newErrors' }],
        watch: ['Player'],
        maxFrames: 300,
      });
    });

    it('forwards command `args` and signal `node` unchanged', async () => {
      // The predicates have understood both fields for a while; the schema had not
      // declared them, so a model could only ever send the degenerate forms. These
      // two assertions are what keeps the schema and the parser in step.
      const gameTest = makeRunGameTest(vi.fn(async () => ({ ok: true })));
      const registry = buildRegistry({ gameTest });

      await registry.execute('game_run', {
        until: [
          { kind: 'command', name: 'shop.buy', args: { slot: 2, item: { id: 'axe' } } },
          { kind: 'signal', name: 'toggled', node: 'MusicCheckbox' },
        ],
      });

      expect(gameTest.run).toHaveBeenCalledWith({
        until: [
          { kind: 'command', name: 'shop.buy', args: { slot: 2, item: { id: 'axe' } } },
          { kind: 'signal', name: 'toggled', node: 'MusicCheckbox' },
        ],
        fail: [],
      });
    });

    it('declares every predicate field it accepts, and nothing else', async () => {
      const registry = buildRegistry();
      const schema = registry.list().find(tool => tool.name === 'game_run')!.inputSchema;
      const predicate = (schema.properties as { until: { items: JsonSchema } }).until.items;

      expect(Object.keys(predicate.properties as Record<string, unknown>).sort()).toEqual([
        'args',
        'axis',
        'by',
        'kind',
        'max',
        'min',
        'n',
        'name',
        'node',
        'op',
        'path',
        'query',
        'value',
      ]);
      expect((predicate.properties as { kind: { enum: string[] } }).kind.enum).toEqual([
        ...GAME_ASSERTION_KINDS,
      ]);
      // The escape hatch stays shut: an invented field is a typo far more often than
      // it is a feature, and a model that gets one accepted silently never learns.
      expect(predicate.additionalProperties).toBe(false);
    });

    /**
     * The other half of "declares every field": with `additionalProperties: false`
     * AND a sanitizer that drops undeclared keys, a field the schema forgets is not a
     * cosmetic omission — the value never reaches the parser, so the predicate answers
     * "needs a name or a node type" about a payload that had one. That is exactly how
     * `nodeAppeared.query`, `nodeMoved.axis` and `nodeMoved.max` were unreachable.
     */
    it('declares the canonical field of every predicate kind, so none is unreachable', async () => {
      const canonical: Record<string, string[]> = {
        gameState: ['path', 'op', 'value'],
        gameStateChanged: ['path', 'by'],
        nodeGone: ['name'],
        nodeMoved: ['name', 'axis', 'min', 'max'],
        nodeAppeared: ['query'],
        nodeProperty: ['name', 'path', 'op', 'value'],
        axis: ['name', 'op', 'value'],
        newErrors: ['min'],
        frames: ['n'],
        command: ['name', 'args'],
        signal: ['name', 'node'],
      };
      // A new kind with no entry here fails this test rather than shipping fieldless.
      expect(Object.keys(canonical).sort()).toEqual([...GAME_ASSERTION_KINDS].sort());

      const registry = buildRegistry();
      const schema = registry.list().find(tool => tool.name === 'game_run')!.inputSchema;
      const predicate = (schema.properties as { until: { items: JsonSchema } }).until.items;
      const declared = Object.keys(predicate.properties as Record<string, unknown>);
      for (const [kind, fields] of Object.entries(canonical)) {
        for (const field of fields) {
          expect(declared, `${kind} needs "${field}" declared`).toContain(field);
        }
      }
    });

    it('passes the fields of the four scene-reading predicates through to the service', async () => {
      const gameTest = makeRunGameTest(vi.fn(async () => ({ ok: true })));
      const registry = buildRegistry({ gameTest });

      await registry.execute('game_run', {
        until: [
          { kind: 'nodeAppeared', query: 'Enemy2D' },
          { kind: 'nodeMoved', name: 'Player', axis: 'x', max: 0, min: -20 },
          { kind: 'nodeProperty', name: 'ScoreLabel', path: 'text', op: 'contains', value: '10' },
          { kind: 'axis', name: 'Horizontal', op: 'lt', value: -0.4 },
        ],
      });

      expect(gameTest.run).toHaveBeenCalledWith({
        until: [
          { kind: 'nodeAppeared', query: 'Enemy2D' },
          { kind: 'nodeMoved', name: 'Player', axis: 'x', min: -20, max: 0 },
          { kind: 'nodeProperty', name: 'ScoreLabel', path: 'text', op: 'contains', value: '10' },
          { kind: 'axis', name: 'Horizontal', op: 'lt', value: -0.4 },
        ],
        fail: [],
      });
    });

    it('drops a field no predicate declares instead of passing it to the service', async () => {
      const gameTest = makeRunGameTest(vi.fn(async () => ({ ok: true })));
      const registry = buildRegistry({ gameTest });

      await registry.execute('game_run', {
        until: [{ kind: 'command', name: 'shop.buy', payload: { slot: 2 } }],
      });

      expect(gameTest.run).toHaveBeenCalledWith({
        until: [{ kind: 'command', name: 'shop.buy' }],
        fail: [],
      });
    });

    it('answers a malformed predicate with the position and the missing field', async () => {
      const gameTest = makeRunGameTest(vi.fn());
      const registry = buildRegistry({ gameTest });

      const result = (await registry.execute('game_run', {
        until: [{ kind: 'gameState', path: 'score' }],
      })) as { ok: boolean; error?: string };

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/until\[0\].*needs "op"/);
      expect(gameTest.run).not.toHaveBeenCalled();
    });

    it('forwards `input` so the service can refuse it with the manual-time explanation', async () => {
      // The refusal is the service's, but the wiring is this file's: a registry
      // that dropped `input` here would silently run a spec the caller believes
      // drives the game.
      const gameTest = new GameTestService();
      Object.defineProperty(gameTest, 'playSession', {
        value: { getActiveRuntime: () => ({ runner: {}, canvas: {}, windowRef: {} }) },
        configurable: true,
      });
      appState.ui.isPlaying = true;
      try {
        const result = (await buildRegistry({ gameTest }).execute('game_run', {
          until: [{ kind: 'frames', n: 10 }],
          input: [{ type: 'key', code: 'ArrowLeft', frames: 8 }],
        })) as { ok: boolean; error?: string };

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/does not drive input/);
        expect(result.error).toMatch(/game_input/);
      } finally {
        appState.ui.isPlaying = false;
      }
    });

    it('forwards a monkey block and a control gesture, normalized', async () => {
      const gameTest = makeRunGameTest(vi.fn(async () => ({ ok: true })));
      const registry = buildRegistry({ gameTest });

      await registry.execute('game_run', {
        until: [{ kind: 'gameStateChanged', path: 'score', by: 1 }],
        monkey: { seed: 42, actions: ['Key_Space'] },
        control: { tap: { nx: 0.02, ny: 0.02 } },
      });

      expect(gameTest.run).toHaveBeenCalledWith({
        until: [{ kind: 'gameStateChanged', path: 'score', by: 1 }],
        fail: [],
        monkey: {
          seed: 42,
          actions: ['Key_Space'],
          everyFrames: 12,
          holdFrames: 8,
          maxActions: 200,
          invariants: {},
        },
        control: { tap: { nx: 0.02, ny: 0.02 }, holdFrames: 40 },
      });
    });

    it('installs the project report backend per call, and falls back to NO store', async () => {
      // Per call, not once at startup: a project can be opened or closed between two
      // runs, and the branch that writes the protocol is the run, not the handler.
      const gameTest = makeRunGameTest(vi.fn(async () => ({ ok: true })));
      const registry = buildRegistry({ gameTest, storage: { listDirectory: async () => [] } });
      const run = () => registry.execute('game_run', { until: [{ kind: 'frames', n: 1 }] });

      try {
        appState.project.status = 'ready';
        await run();
        expect(gameTest.getProtocolStore()).toBeInstanceOf(ProjectReportStore);
      } finally {
        appState.project.status = 'idle';
      }
      // And back to `null` — NOT to an in-memory store, unlike the trace and routine
      // seams. A reply that points at design/tests/reports/ when nothing can be
      // written there sends the agent to read a file that does not exist; the run
      // says the protocol was lost instead.
      await run();
      expect(gameTest.getProtocolStore()).toBeNull();
    });

    it('refuses a monkey run with no seed before the game is touched', async () => {
      const gameTest = makeRunGameTest(vi.fn());
      const registry = buildRegistry({ gameTest });

      const result = (await registry.execute('game_run', {
        until: [{ kind: 'frames', n: 10 }],
        monkey: { everyFrames: 6 },
      })) as { ok: boolean; error?: string };

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/monkey\.seed/);
      expect(gameTest.run).not.toHaveBeenCalled();
    });

    it('declares the two modes, and states the three things a caller must not misread', async () => {
      const registry = buildRegistry();
      const tool = registry.list().find(entry => entry.name === 'game_run')!;
      const properties = tool.inputSchema.properties as Record<string, JsonSchema>;

      // Structural: the two blocks exist and each requires the field without which
      // it means nothing.
      expect(properties.monkey.required).toEqual(['seed']);
      expect(properties.control.required).toEqual(['tap']);

      // And in words, because the schema alone does not carry the reasons. These
      // three are the ones a wrong reading turns into a false green.
      expect(properties.monkey.description).toMatch(/`?seed`? is REQUIRED/i);
      expect(tool.description).toMatch(/EMPTY INVENTORY IS NOT A PASS/i);
      expect(tool.description).toMatch(/inconclusive.*DOES NOT MEAN PASSED/i);
    });

    it('tells the caller where the full protocol lands and how to read it', async () => {
      // All three facts, because each one wrong is a different waste: not knowing the
      // file exists loses the evidence, not knowing to slice it burns the context the
      // file was written to save, and not knowing about rotation loses an old finding.
      const tool = buildRegistry()
        .list()
        .find(entry => entry.name === 'game_run')!;
      expect(tool.description).toContain('design/tests/reports');
      expect(tool.description).toMatch(/fs_read \{offset, limit\}/);
      expect(tool.description).toMatch(/newest 20 reports/);
      expect(tool.description).toMatch(/artifact\.written` is false/);
    });

    it('leaves a report store somebody else installed alone', async () => {
      // Same rule as the trace and routine seams: only a store this method recognises
      // as its own is ever replaced, so a spec's fake (or a future cloud store)
      // survives a project being opened underneath it.
      const custom: RunProtocolStore = {
        list: async () => [],
        save: async () => {},
        delete: async () => {},
      };
      const gameTest = makeRunGameTest(vi.fn(async () => ({ ok: true })));
      gameTest.setProtocolStore(custom);
      const registry = buildRegistry({ gameTest, storage: { listDirectory: async () => [] } });
      try {
        appState.project.status = 'ready';
        await registry.execute('game_run', { until: [{ kind: 'frames', n: 1 }] });
        expect(gameTest.getProtocolStore()).toBe(custom);
      } finally {
        appState.project.status = 'idle';
      }
    });
  });

  it('read_errors returns the captured ring buffer', async () => {
    const registry = buildRegistry();
    clearErrors();
    console.error('agent-tool-registry-test-error');
    const errs = (await registry.execute('read_errors')) as Array<{ message: string }>;
    expect(errs.some(e => e.message.includes('agent-tool-registry-test-error'))).toBe(true);
  });
});
