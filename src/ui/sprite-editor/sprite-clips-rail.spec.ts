import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAppState } from '@/state';
import type { AnimationResource } from '@pix3/runtime';

import {
  AnimationDocumentController,
  type AnimationDocumentControllerDeps,
} from './animation-document-controller';
import { SpriteClipsRail } from './sprite-clips-rail';

/**
 * The rail takes a controller reference and emits no data events, so every
 * assertion below goes through controller state or a controller spy — exactly how
 * the shell (and the Inspector, which renders the same affordances) observes it.
 */
interface ControllerInternals {
  _assetPath: string | null;
  _resource: AnimationResource | null;
  _activeClipName: string;
  animationId: string | null;
}

function createDeps(): AnimationDocumentControllerDeps {
  return {
    operations: { invokeAndPush: vi.fn().mockResolvedValue(true) },
    commandDispatcher: { execute: vi.fn().mockResolvedValue(true) },
    // Reads never resolve to a decodable blob here: the texture-preview loader
    // swallows the failure, and no detached promise is left hanging.
    projectStorage: {
      readBlob: vi.fn().mockRejectedValue(new Error('no project storage in tests')),
      writeBinaryFile: vi.fn().mockResolvedValue(undefined),
    },
    animationEditorService: {
      getActiveController: vi.fn().mockReturnValue(null),
      setActiveController: vi.fn(),
    },
    autoSliceDialog: { showDialog: vi.fn().mockResolvedValue(null) },
    dialogService: { showConfirmation: vi.fn().mockResolvedValue(true) },
    sceneManager: { getActiveSceneGraph: () => ({ nodeMap: new Map() }) },
  } as unknown as AnimationDocumentControllerDeps;
}

function createController(clipFrameCounts: Record<string, number> = { idle: 2, run: 3 }) {
  const controller = new AnimationDocumentController(createDeps(), '');
  const resource: AnimationResource = {
    version: '1.0.0',
    texturePath: '',
    clips: Object.entries(clipFrameCounts).map(([name, frameCount]) => ({
      name,
      fps: 12,
      loop: true,
      playbackMode: 'normal',
      frames: Array.from({ length: frameCount }, (_unused, index) => ({
        textureIndex: 0,
        offset: { x: 0, y: 0 },
        repeat: { x: 1, y: 1 },
        durationMultiplier: 1,
        anchor: { x: 0.5, y: 1 },
        texturePath: `res://${name}-${index}.png`,
        boundingBox: { x: 0, y: 0, width: 0, height: 0 },
        collisionPolygon: [],
      })),
    })),
  };

  const internals = controller as unknown as ControllerInternals;
  internals._assetPath = 'res://animations/walk/walk.pix3anim';
  internals.animationId = 'animations-walk';
  internals._resource = resource;
  internals._activeClipName = Object.keys(clipFrameCounts)[0] ?? '';
  return controller;
}

async function mountRail(controller: AnimationDocumentController): Promise<SpriteClipsRail> {
  const rail = new SpriteClipsRail();
  rail.controller = controller;
  document.body.appendChild(rail);
  await rail.updateComplete;
  return rail;
}

function getClipEntries(rail: SpriteClipsRail): HTMLButtonElement[] {
  return Array.from(rail.querySelectorAll<HTMLButtonElement>('.clip-entry'));
}

function getRailAction(rail: SpriteClipsRail, label: string): HTMLButtonElement {
  const action = rail.querySelector<HTMLButtonElement>(`.clips-rail-action[aria-label="${label}"]`);
  if (!action) {
    throw new Error(`No rail action labelled "${label}"`);
  }
  return action;
}

describe('SpriteClipsRail', () => {
  beforeEach(() => {
    resetAppState();
  });

  afterEach(() => {
    resetAppState();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders one entry per clip with its frame count and marks the active one', async () => {
    const controller = createController({ idle: 2, run: 3 });
    const rail = await mountRail(controller);
    const entries = getClipEntries(rail);

    expect(entries).toHaveLength(2);
    expect(entries.map(entry => entry.querySelector('.clip-entry-name')?.textContent)).toEqual([
      'idle',
      'run',
    ]);
    expect(entries.map(entry => entry.querySelector('.clip-entry-count')?.textContent)).toEqual([
      '2',
      '3',
    ]);
    expect(entries[0].classList.contains('is-active')).toBe(true);
    expect(entries[1].classList.contains('is-active')).toBe(false);
  });

  it('renders an empty state for a document without clips', async () => {
    const controller = createController({});
    const rail = await mountRail(controller);

    expect(getClipEntries(rail)).toHaveLength(0);
    expect(rail.textContent).toContain('No clips yet');
  });

  it('selects a clip through the controller when its entry is clicked', async () => {
    const controller = createController();
    const rail = await mountRail(controller);

    getClipEntries(rail)[1].click();
    await rail.updateComplete;

    expect(controller.activeClipName).toBe('run');
    expect(getClipEntries(rail)[1].classList.contains('is-active')).toBe(true);
  });

  it('routes add and remove to the controller', async () => {
    const controller = createController();
    const addClip = vi.spyOn(controller, 'addClip').mockResolvedValue(undefined);
    const removeClip = vi.spyOn(controller, 'removeClip').mockResolvedValue(undefined);
    const rail = await mountRail(controller);

    getRailAction(rail, 'Add clip').click();
    getRailAction(rail, 'Remove the active clip').click();

    expect(addClip).toHaveBeenCalledOnce();
    expect(removeClip).toHaveBeenCalledOnce();
  });

  it('disables removal when the document has no active clip', async () => {
    const controller = createController({});
    const rail = await mountRail(controller);

    expect(getRailAction(rail, 'Remove the active clip').disabled).toBe(true);
  });

  it('renames a clip inline on double-click, committing on Enter', async () => {
    const controller = createController();
    const renameClip = vi.spyOn(controller, 'renameClip');
    const rail = await mountRail(controller);

    getClipEntries(rail)[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await rail.updateComplete;

    const input = rail.querySelector<HTMLInputElement>('.clip-rename-input');
    expect(input).not.toBeNull();

    input!.value = 'idle-left';
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(renameClip).toHaveBeenCalledWith('idle-left');
    });
    await vi.waitFor(() => {
      expect(controller.resource?.clips.map(clip => clip.name)).toEqual(['idle-left', 'run']);
    });

    await rail.updateComplete;
    expect(rail.querySelector('.clip-rename-input')).toBeNull();
  });

  it('selects the clip first when renaming one that is not active', async () => {
    const controller = createController();
    const rail = await mountRail(controller);

    getClipEntries(rail)[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await rail.updateComplete;

    // `renameClip` always targets the active clip, so the rail must have made the
    // double-clicked one active before it opened the editor.
    expect(controller.activeClipName).toBe('run');

    const input = rail.querySelector<HTMLInputElement>('.clip-rename-input');
    input!.value = 'sprint';
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(controller.resource?.clips.map(clip => clip.name)).toEqual(['idle', 'sprint']);
    });
  });

  it('abandons an inline rename on Escape', async () => {
    const controller = createController();
    const renameClip = vi.spyOn(controller, 'renameClip');
    const rail = await mountRail(controller);

    getClipEntries(rail)[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'F2' }));
    await rail.updateComplete;

    const input = rail.querySelector<HTMLInputElement>('.clip-rename-input');
    expect(input).not.toBeNull();

    input!.value = 'discarded';
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await rail.updateComplete;

    expect(renameClip).not.toHaveBeenCalled();
    expect(rail.querySelector('.clip-rename-input')).toBeNull();
    expect(controller.resource?.clips.map(clip => clip.name)).toEqual(['idle', 'run']);
  });

  it('stops observing its controller once disconnected', async () => {
    const controller = createController();
    const unsubscribe = vi.fn();
    const subscribe = vi.spyOn(controller, 'subscribe').mockReturnValue(unsubscribe);
    const rail = await mountRail(controller);

    expect(subscribe).toHaveBeenCalledOnce();

    rail.remove();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
