import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AmbientLightNode,
  AudioPlayer,
  Camera3D,
  Group2D,
  type NodeBase,
  PlaySoundBehavior,
  type PropertyDefinition,
} from '@pix3/runtime';

type DragLike = Pick<DragEvent, 'dataTransfer'>;
let InspectorPanel: typeof import('./inspector-panel').InspectorPanel;

function createDragEvent(resourcePath: string): DragLike {
  const transfer = {
    getData: (type: string): string => {
      if (type === 'application/x-pix3-asset-resource') {
        return resourcePath;
      }
      return '';
    },
  };

  return { dataTransfer: transfer as unknown as DataTransfer };
}

function getAudioTrackProperty(schemaOwner: {
  getPropertySchema: () => { properties: PropertyDefinition[] };
}) {
  const prop = schemaOwner
    .getPropertySchema()
    .properties.find(property => property.name === 'audioTrack');
  expect(prop).toBeDefined();
  return prop as PropertyDefinition;
}

class ModelConsumer {
  static getPropertySchema() {
    return {
      properties: [
        {
          name: 'modelPath',
          type: 'string' as const,
          ui: { editor: 'model-resource' as const },
          getValue: () => '',
          setValue: () => {},
        },
      ],
    };
  }
}

beforeAll(async () => {
  vi.mock('golden-layout', () => ({}));
  ({ InspectorPanel } = await import('./inspector-panel'));
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function createAudioBufferMock(): AudioBuffer {
  const channelA = new Float32Array([0, 0.2, -0.4, 0.8, -0.6, 0.1]);
  const channelB = new Float32Array([0.1, -0.3, 0.5, -0.7, 0.4, -0.2]);

  return {
    duration: 2.4,
    numberOfChannels: 2,
    sampleRate: 44100,
    getChannelData(index: number) {
      return index === 0 ? channelA : channelB;
    },
  } as unknown as AudioBuffer;
}

describe('InspectorPanel audio resource handling', () => {
  it('marks AudioPlayer and PlaySoundBehavior audioTrack with the audio editor', () => {
    const nodeProp = getAudioTrackProperty(AudioPlayer);
    const componentProp = getAudioTrackProperty(PlaySoundBehavior);

    expect(nodeProp.ui?.editor).toBe('audio-resource');
    expect(componentProp.ui?.editor).toBe('audio-resource');
  });

  it('updates AudioPlayer audioTrack from internal audio asset drops and ignores non-audio assets', async () => {
    const panel = new InspectorPanel();
    const execute = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(panel, 'commandDispatcher', {
      value: { execute },
      configurable: true,
    });

    (panel as unknown as { primaryNode: AudioPlayer | null }).primaryNode = new AudioPlayer({
      id: 'audio-player',
      name: 'Audio Player',
    });
    (
      panel as unknown as {
        propertySchema: ReturnType<typeof AudioPlayer.getPropertySchema> | null;
      }
    ).propertySchema = AudioPlayer.getPropertySchema();

    (
      panel as unknown as { onAudioResourceDrop: (propertyName: string, event: DragEvent) => void }
    ).onAudioResourceDrop('audioTrack', createDragEvent('res://assets/sfx/click.wav') as DragEvent);
    await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(1);
    const objectCommand = execute.mock.calls[0]?.[0] as {
      params?: { propertyPath: string; value: string };
    };
    expect(objectCommand.params?.propertyPath).toBe('audioTrack');
    expect(objectCommand.params?.value).toBe('res://assets/sfx/click.wav');

    execute.mockClear();

    (
      panel as unknown as { onAudioResourceDrop: (propertyName: string, event: DragEvent) => void }
    ).onAudioResourceDrop(
      'audioTrack',
      createDragEvent('res://assets/images/icon.png') as DragEvent
    );
    await Promise.resolve();

    expect(execute).not.toHaveBeenCalled();
  });

  it('updates component audioTrack from internal audio asset drops', async () => {
    const panel = new InspectorPanel();
    const execute = vi.fn().mockResolvedValue(undefined);
    const node = new AudioPlayer({
      id: 'audio-player',
      name: 'Audio Player',
    });
    const component = new PlaySoundBehavior('behavior-1', 'core:PlaySound');
    node.addComponent(component);

    Object.defineProperty(panel, 'commandDispatcher', {
      value: { execute },
      configurable: true,
    });

    (panel as unknown as { primaryNode: AudioPlayer | null }).primaryNode = node;

    const prop = getAudioTrackProperty(PlaySoundBehavior);

    (
      panel as unknown as {
        onComponentAudioResourceDrop: (
          componentId: string,
          prop: PropertyDefinition,
          event: DragEvent
        ) => void;
      }
    ).onComponentAudioResourceDrop(
      component.id,
      prop,
      createDragEvent('res://assets/sfx/ui.ogg') as DragEvent
    );
    await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(1);
    const componentCommand = execute.mock.calls[0]?.[0] as {
      params?: { componentId: string; propertyName: string; value: string };
    };
    expect(componentCommand.params?.componentId).toBe(component.id);
    expect(componentCommand.params?.propertyName).toBe('audioTrack');
    expect(componentCommand.params?.value).toBe('res://assets/sfx/ui.ogg');
  });
});

describe('InspectorPanel model resource handling', () => {
  it('marks modelPath with the model editor', () => {
    const prop = ModelConsumer.getPropertySchema().properties.find(
      property => property.name === 'modelPath'
    );

    expect(prop).toBeDefined();
    expect(prop?.ui?.editor).toBe('model-resource');
  });

  it('updates node modelPath from internal model asset drops and ignores non-model assets', async () => {
    const panel = new InspectorPanel();
    const execute = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(panel, 'commandDispatcher', {
      value: { execute },
      configurable: true,
    });

    (panel as unknown as { primaryNode: AudioPlayer | null }).primaryNode = new AudioPlayer({
      id: 'audio-player',
      name: 'Audio Player',
    });
    (
      panel as unknown as {
        propertySchema: ReturnType<typeof ModelConsumer.getPropertySchema> | null;
      }
    ).propertySchema = ModelConsumer.getPropertySchema();

    (
      panel as unknown as { onModelResourceDrop: (propertyName: string, event: DragEvent) => void }
    ).onModelResourceDrop(
      'modelPath',
      createDragEvent('res://assets/models/wall.glb') as DragEvent
    );
    await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(1);
    const objectCommand = execute.mock.calls[0]?.[0] as {
      params?: { propertyPath: string; value: string };
    };
    expect(objectCommand.params?.propertyPath).toBe('modelPath');
    expect(objectCommand.params?.value).toBe('res://assets/models/wall.glb');

    execute.mockClear();

    (
      panel as unknown as { onModelResourceDrop: (propertyName: string, event: DragEvent) => void }
    ).onModelResourceDrop(
      'modelPath',
      createDragEvent('res://assets/audio/click.wav') as DragEvent
    );
    await Promise.resolve();

    expect(execute).not.toHaveBeenCalled();
  });
});

describe('InspectorPanel color property editor', () => {
  it('renders a color picker and a text input for color properties', async () => {
    const node = new AmbientLightNode({
      id: 'ambient-light',
      name: 'Ambient Light',
      color: '#336699',
    });
    const { panel } = await setupInspectorForNode(node);

    const colorInput = panel.querySelector('input[type="color"]') as HTMLInputElement | null;
    const textInput = panel.querySelector(
      '.property-color-editor input[type="text"]'
    ) as HTMLInputElement | null;
    const expectedColor = `#${node.light.color.getHexString()}`;

    expect(colorInput).not.toBeNull();
    expect(textInput).not.toBeNull();
    expect(colorInput?.value).toBe(expectedColor);
    expect(textInput?.value).toBe(expectedColor);
    expect(textInput?.classList.contains('property-input--color-text')).toBe(true);
  });

  it('dispatches UpdateObjectPropertyCommand when the color picker changes', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const { panel } = await setupInspectorForNode(
      new AmbientLightNode({
        id: 'ambient-light',
        name: 'Ambient Light',
        color: '#336699',
      }),
      execute
    );

    const colorInput = panel.querySelector('input[type="color"]') as HTMLInputElement;
    colorInput.value = '#ff8800';
    colorInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(1);
    const command = execute.mock.calls[0]?.[0] as {
      params?: { propertyPath: string; value: string };
    };
    expect(command.params?.propertyPath).toBe('color');
    expect(command.params?.value).toBe('#ff8800');
  });

  it('dispatches UpdateObjectPropertyCommand when typing a valid hex color', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const { panel } = await setupInspectorForNode(
      new AmbientLightNode({
        id: 'ambient-light',
        name: 'Ambient Light',
        color: '#336699',
      }),
      execute
    );

    const textInput = panel.querySelector(
      '.property-color-editor input[type="text"]'
    ) as HTMLInputElement;
    textInput.value = '#123abc';
    textInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(1);
    const command = execute.mock.calls[0]?.[0] as {
      params?: { propertyPath: string; value: string };
    };
    expect(command.params?.propertyPath).toBe('color');
    expect(command.params?.value).toBe('#123abc');
  });
});

describe('InspectorPanel camera projection editor', () => {
  it('renders projection select and disables fov for orthographic cameras', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const { panel } = await setupInspectorForNode(
      new Camera3D({
        id: 'camera-ortho',
        name: 'Camera',
        projection: 'orthographic',
        orthographicSize: 6,
      }),
      execute
    );

    const selects = Array.from(
      panel.querySelectorAll('select.property-select')
    ) as HTMLSelectElement[];
    const projectionSelect = selects.find(select =>
      Array.from(select.options).some(option => option.value === 'orthographic')
    );
    // Scalar numbers render as the drag-to-scrub field, not a raw <input type=number>.
    const numberFields = Array.from(panel.querySelectorAll('pix3-number-field')) as Array<
      HTMLElement & { value: number; disabled: boolean }
    >;
    const fovField = numberFields.find(field => field.value === 60);

    expect(projectionSelect).toBeInstanceOf(HTMLSelectElement);
    expect((projectionSelect as HTMLSelectElement).value).toBe('orthographic');
    expect(panel.querySelector('input[type="number"]')).toBeNull();
    expect(fovField).toBeDefined();
    expect(fovField?.disabled).toBe(true);
  });
});

describe('InspectorPanel compact object layout', () => {
  it('renders object identity in a compact summary without the old inspector title', async () => {
    const { panel } = await setupInspectorForNode(
      new Group2D({
        id: 'group-root',
        name: 'HUD Root',
        width: 320,
        height: 180,
      })
    );

    const nameInput = panel.querySelector('.inspector-name-input') as HTMLInputElement | null;
    const summaryType = panel.querySelector('.inspector-summary-type');
    const summaryId = panel.querySelector('.inspector-summary-id');
    const summaryGroups = panel.querySelector('.group-chip-list--summary');

    expect(panel.textContent).not.toContain('Object Inspector');
    expect(nameInput?.value).toBe('HUD Root');
    expect(summaryType?.textContent).toContain('Group2D');
    expect(summaryId?.textContent).toContain('group-root');
    expect(summaryGroups).toBeNull();
  });

  it('shows groups as compact chips and opens the groups popover from the summary toolbar', async () => {
    const node = new Group2D({
      id: 'group-root',
      name: 'HUD Root',
      width: 320,
      height: 180,
    });
    node.addToGroup('ui');
    node.addToGroup('hud');

    const { panel } = await setupInspectorForNode(node);
    const chips = Array.from(panel.querySelectorAll('.group-chip-list--summary .group-chip')).map(
      chip => chip.textContent?.trim()
    );
    const trigger = panel.querySelector('.summary-toolbar-button') as HTMLButtonElement | null;

    expect(chips).toEqual(['hud', 'ui']);
    expect(panel.querySelector('.groups-popover')).toBeNull();

    trigger?.click();
    await panel.updateComplete;

    expect(panel.querySelector('.groups-popover')).not.toBeNull();
  });

  it('orders object sections with Transform before Anchor and hides the standalone Style title', async () => {
    const { panel } = await setupInspectorForNode(
      new Group2D({
        id: 'group-root',
        name: 'HUD Root',
        width: 320,
        height: 180,
      })
    );

    const titles = Array.from(panel.querySelectorAll('.group-title')).map(title =>
      title.textContent?.trim()
    );

    expect(titles).toContain('Transform');
    expect(titles).toContain('Align');
    expect(titles).not.toContain('Anchor');
    expect(titles).not.toContain('Style');
    expect(titles.indexOf('Transform')).toBeLessThan(titles.indexOf('Align'));
    expect(panel.textContent).toContain('Opacity');
    expect(panel.querySelector('.property-group--opacity')).not.toBeNull();
  });

  it('hides anchor controls until anchor layout is enabled', async () => {
    const { panel } = await setupInspectorForNode(
      new Group2D({
        id: 'group-root',
        name: 'HUD Root',
        width: 320,
        height: 180,
      })
    );

    expect(panel.querySelector('.anchor-visual-editor')).toBeNull();
  });

  it('renders the visual anchor editor with icon buttons and dispatches anchor updates', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const node = new Group2D({
      id: 'group-root',
      name: 'HUD Root',
      width: 320,
      height: 180,
    });
    node.layoutEnabled = true;

    const { panel } = await setupInspectorForNode(node, execute);

    const anchorEditor = panel.querySelector('.anchor-visual-editor');
    const horizontalLeftButton = panel.querySelector('.anchor-control-row .anchor-mode-button');
    const leftButtonIcon = horizontalLeftButton?.querySelector('svg');

    expect(anchorEditor).not.toBeNull();
    expect(leftButtonIcon).not.toBeNull();

    horizontalLeftButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await vi.waitFor(() => {
      const lastCommand = execute.mock.calls.at(-1)?.[0] as {
        params?: { propertyPath: string; value: unknown };
      };
      expect(lastCommand.params?.propertyPath).toBe('horizontalAlign');
    });

    const firstCommand = execute.mock.calls[0]?.[0] as {
      params?: { propertyPath: string; value: unknown };
    };
    const lastCommand = execute.mock.calls.at(-1)?.[0] as {
      params?: { propertyPath: string; value: unknown };
    };

    expect(firstCommand.params?.propertyPath).not.toBe('layoutEnabled');

    expect(lastCommand.params?.propertyPath).toBe('horizontalAlign');
    expect(lastCommand.params?.value).toBe('left');
  });

  it('renders components as a flat section with text enable actions and no foldout button', async () => {
    const node = new AudioPlayer({
      id: 'audio-player',
      name: 'Audio Player',
    });
    const component = new PlaySoundBehavior('behavior-1', 'core:PlaySound');
    component.enabled = false;
    node.addComponent(component);

    const { panel } = await setupInspectorForNode(node);

    const sectionTitle = Array.from(panel.querySelectorAll('.group-title')).find(
      title => title.textContent?.trim() === 'Components'
    );
    const foldout = panel.querySelector('.script-foldout-btn');
    const enableAction = Array.from(panel.querySelectorAll('.component-action-link')).find(
      action => action.textContent?.trim() === 'Enable'
    );
    const disabledName = panel.querySelector('.component-block--disabled .script-name');

    expect(sectionTitle).not.toBeUndefined();
    expect(foldout).toBeNull();
    expect(enableAction).not.toBeUndefined();
    expect(disabledName?.textContent).toContain('core:PlaySound');
  });
});

describe('InspectorPanel asset preview rendering', () => {
  it('renders interactive model preview for selected 3D assets', async () => {
    const panel = document.createElement('pix3-inspector-panel') as InstanceType<
      typeof InspectorPanel
    >;

    Object.defineProperty(panel, 'sceneManager', {
      value: { getSceneGraph: vi.fn(() => null), getActiveSceneGraph: vi.fn(() => null) },
      configurable: true,
    });
    Object.defineProperty(panel, 'commandDispatcher', {
      value: { execute: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    Object.defineProperty(panel, 'behaviorPickerService', {
      value: { showPicker: vi.fn() },
      configurable: true,
    });
    Object.defineProperty(panel, 'scriptCreatorService', {
      value: { showCreator: vi.fn(), createScript: vi.fn(), checkIfScriptExists: vi.fn() },
      configurable: true,
    });
    Object.defineProperty(panel, 'scriptRegistry', {
      value: { getComponentPropertySchema: vi.fn(() => null), getComponentType: vi.fn(() => null) },
      configurable: true,
    });
    Object.defineProperty(panel, 'iconService', {
      value: { getIcon: vi.fn(() => 'icon') },
      configurable: true,
    });
    Object.defineProperty(panel, 'dialogService', {
      value: { showConfirmation: vi.fn() },
      configurable: true,
    });
    Object.defineProperty(panel, 'fileSystemAPI', {
      value: { readBlob: vi.fn(), listDirectory: vi.fn(async () => []) },
      configurable: true,
    });
    Object.defineProperty(panel, 'projectStorage', {
      value: { readTextFile: vi.fn(async () => '') },
      configurable: true,
    });
    Object.defineProperty(panel, 'assetsPreviewService', {
      value: {
        requestThumbnail: vi.fn(),
        subscribe: (listener: (snapshot: { selectedItem: unknown }) => void) => {
          listener({
            selectedItem: {
              name: 'crate.glb',
              path: 'assets/models/crate.glb',
              kind: 'file',
              previewType: 'model',
              thumbnailUrl: 'data:image/webp;base64,thumb',
              previewUrl: null,
              thumbnailStatus: 'ready',
              iconName: 'box',
              extension: 'glb',
              sizeBytes: 1024,
              width: null,
              height: null,
              durationSeconds: null,
              channelCount: null,
              sampleRate: null,
              lastModified: 10,
            },
          });
          return () => undefined;
        },
      },
      configurable: true,
    });
    Object.defineProperty(panel, 'viewportService', {
      value: { setPreviewAnimation: vi.fn() },
      configurable: true,
    });

    document.body.appendChild(panel);
    await panel.updateComplete;

    const preview = panel.querySelector('pix3-model-asset-preview');
    expect(preview).not.toBeNull();
    expect(preview?.getAttribute('resourcepath')).toBeNull();
    expect((preview as { resourcePath?: string }).resourcePath).toBe(
      'res://assets/models/crate.glb'
    );
  });

  it('renders playable audio preview for selected audio assets', async () => {
    const panel = document.createElement('pix3-inspector-panel') as InstanceType<
      typeof InspectorPanel
    >;

    Object.defineProperty(panel, 'sceneManager', {
      value: { getSceneGraph: vi.fn(() => null), getActiveSceneGraph: vi.fn(() => null) },
      configurable: true,
    });
    Object.defineProperty(panel, 'commandDispatcher', {
      value: { execute: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    Object.defineProperty(panel, 'behaviorPickerService', {
      value: { showPicker: vi.fn() },
      configurable: true,
    });
    Object.defineProperty(panel, 'scriptCreatorService', {
      value: { showCreator: vi.fn(), createScript: vi.fn(), checkIfScriptExists: vi.fn() },
      configurable: true,
    });
    Object.defineProperty(panel, 'scriptRegistry', {
      value: { getComponentPropertySchema: vi.fn(() => null), getComponentType: vi.fn(() => null) },
      configurable: true,
    });
    Object.defineProperty(panel, 'iconService', {
      value: { getIcon: vi.fn(() => 'icon') },
      configurable: true,
    });
    Object.defineProperty(panel, 'dialogService', {
      value: { showConfirmation: vi.fn() },
      configurable: true,
    });
    Object.defineProperty(panel, 'fileSystemAPI', {
      value: { readBlob: vi.fn(), listDirectory: vi.fn(async () => []) },
      configurable: true,
    });
    Object.defineProperty(panel, 'projectStorage', {
      value: { readTextFile: vi.fn(async () => '') },
      configurable: true,
    });
    Object.defineProperty(panel, 'assetsPreviewService', {
      value: {
        subscribe: (listener: (snapshot: { selectedItem: unknown }) => void) => {
          listener({
            selectedItem: {
              name: 'click.wav',
              path: 'assets/audio/click.wav',
              kind: 'file',
              previewType: 'audio',
              thumbnailUrl: 'data:image/svg+xml;charset=utf-8,waveform',
              previewUrl: 'blob:audio-preview',
              thumbnailStatus: 'ready',
              iconName: 'music',
              extension: 'wav',
              sizeBytes: 2048,
              width: null,
              height: null,
              durationSeconds: 2.4,
              channelCount: 2,
              sampleRate: 44100,
              lastModified: 10,
            },
          });
          return () => undefined;
        },
      },
      configurable: true,
    });
    Object.defineProperty(panel, 'viewportService', {
      value: { setPreviewAnimation: vi.fn() },
      configurable: true,
    });

    document.body.appendChild(panel);
    await panel.updateComplete;

    const preview = panel.querySelector('pix3-audio-resource-editor') as
      | (HTMLElement & {
          updateComplete?: Promise<unknown>;
          shadowRoot: ShadowRoot | null;
          showResourceControls?: boolean;
        })
      | null;
    expect(preview).not.toBeNull();
    expect(preview?.showResourceControls).toBe(false);
    await preview?.updateComplete;
    expect(preview?.shadowRoot?.querySelector('audio')).not.toBeNull();
    expect(preview?.shadowRoot?.querySelector('.waveform')).not.toBeNull();
  });

  it('renders text content for selected text assets', async () => {
    const panel = document.createElement('pix3-inspector-panel') as InstanceType<
      typeof InspectorPanel
    >;
    const readTextFile = vi.fn(async () => 'title: Demo\nmode: editor\nenabled: true');

    Object.defineProperty(panel, 'sceneManager', {
      value: { getSceneGraph: vi.fn(() => null), getActiveSceneGraph: vi.fn(() => null) },
      configurable: true,
    });
    Object.defineProperty(panel, 'commandDispatcher', {
      value: { execute: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    Object.defineProperty(panel, 'behaviorPickerService', {
      value: { showPicker: vi.fn() },
      configurable: true,
    });
    Object.defineProperty(panel, 'scriptCreatorService', {
      value: { showCreator: vi.fn(), createScript: vi.fn(), checkIfScriptExists: vi.fn() },
      configurable: true,
    });
    Object.defineProperty(panel, 'scriptRegistry', {
      value: { getComponentPropertySchema: vi.fn(() => null), getComponentType: vi.fn(() => null) },
      configurable: true,
    });
    Object.defineProperty(panel, 'iconService', {
      value: { getIcon: vi.fn(() => 'icon') },
      configurable: true,
    });
    Object.defineProperty(panel, 'dialogService', {
      value: { showConfirmation: vi.fn() },
      configurable: true,
    });
    Object.defineProperty(panel, 'fileSystemAPI', {
      value: { readBlob: vi.fn(), listDirectory: vi.fn(async () => []) },
      configurable: true,
    });
    Object.defineProperty(panel, 'projectStorage', {
      value: { readTextFile },
      configurable: true,
    });
    Object.defineProperty(panel, 'assetsPreviewService', {
      value: {
        subscribe: (listener: (snapshot: { selectedItem: unknown }) => void) => {
          listener({
            selectedItem: {
              name: 'config.yaml',
              path: 'assets/config.yaml',
              kind: 'file',
              previewType: 'text',
              thumbnailUrl: null,
              previewUrl: null,
              previewText: 'title: Demo',
              thumbnailStatus: 'ready',
              iconName: 'file-text',
              extension: 'yaml',
              sizeBytes: 120,
              width: null,
              height: null,
              durationSeconds: null,
              channelCount: null,
              sampleRate: null,
              lastModified: 10,
            },
          });
          return () => undefined;
        },
      },
      configurable: true,
    });
    Object.defineProperty(panel, 'viewportService', {
      value: { setPreviewAnimation: vi.fn() },
      configurable: true,
    });

    document.body.appendChild(panel);
    await panel.updateComplete;

    await vi.waitFor(() => {
      const textPreview = panel.querySelector('.asset-text-preview');
      expect(textPreview?.textContent).toContain('mode: editor');
      expect(textPreview?.textContent).toContain('enabled: true');
    });

    expect(readTextFile).toHaveBeenCalledWith('assets/config.yaml');
  });

  it('loads playable audio previews for object inspector audio properties', async () => {
    const decodeAudioData = vi.fn().mockResolvedValue(createAudioBufferMock());
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData;
      } as unknown as typeof AudioContext
    );
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:loaded-audio'),
      revokeObjectURL: vi.fn(),
    });

    const panel = document.createElement('pix3-inspector-panel') as InstanceType<
      typeof InspectorPanel
    >;
    const readBlob = vi
      .fn()
      .mockResolvedValue(new File(['audio-data'], 'click.wav', { type: 'audio/wav' }));
    const node = new AudioPlayer({
      id: 'audio-player',
      name: 'Audio Player',
      audioTrack: 'res://assets/sfx/click.wav',
    });

    Object.defineProperty(panel, 'fileSystemAPI', {
      value: { readBlob, listDirectory: vi.fn(async () => []) },
      configurable: true,
    });
    Object.defineProperty(panel, 'sceneManager', {
      value: { getSceneGraph: vi.fn(() => null), getActiveSceneGraph: vi.fn(() => null) },
      configurable: true,
    });
    Object.defineProperty(panel, 'commandDispatcher', {
      value: { execute: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    Object.defineProperty(panel, 'behaviorPickerService', {
      value: { showPicker: vi.fn() },
      configurable: true,
    });
    Object.defineProperty(panel, 'scriptCreatorService', {
      value: { showCreator: vi.fn(), createScript: vi.fn(), checkIfScriptExists: vi.fn() },
      configurable: true,
    });
    Object.defineProperty(panel, 'scriptRegistry', {
      value: { getComponentPropertySchema: vi.fn(() => null), getComponentType: vi.fn(() => null) },
      configurable: true,
    });
    Object.defineProperty(panel, 'iconService', {
      value: { getIcon: vi.fn(() => 'icon') },
      configurable: true,
    });
    Object.defineProperty(panel, 'dialogService', {
      value: { showConfirmation: vi.fn() },
      configurable: true,
    });
    Object.defineProperty(panel, 'assetsPreviewService', {
      value: {
        subscribe: (listener: (snapshot: { selectedItem: null }) => void) => {
          listener({ selectedItem: null });
          return () => undefined;
        },
      },
      configurable: true,
    });
    Object.defineProperty(panel, 'viewportService', {
      value: { setPreviewAnimation: vi.fn() },
      configurable: true,
    });

    document.body.appendChild(panel);
    (
      panel as unknown as {
        selectedNodes: NodeBase[];
        primaryNode: NodeBase;
        syncValuesFromNode: () => void;
      }
    ).selectedNodes = [node];
    (panel as unknown as { primaryNode: NodeBase }).primaryNode = node;
    (
      panel as unknown as {
        syncValuesFromNode: () => void;
      }
    ).syncValuesFromNode();

    panel.requestUpdate();
    await panel.updateComplete;

    await vi.waitFor(async () => {
      const preview = panel.querySelector('pix3-audio-resource-editor') as
        | (HTMLElement & { updateComplete?: Promise<unknown>; shadowRoot: ShadowRoot | null })
        | null;
      await preview?.updateComplete;
      expect(preview?.shadowRoot?.querySelector('audio')).not.toBeNull();
      expect(preview?.shadowRoot?.querySelector('.waveform')).not.toBeNull();
    });

    expect(readBlob).toHaveBeenCalledWith('res://assets/sfx/click.wav');
    expect(decodeAudioData).toHaveBeenCalledOnce();
  });
});

describe('InspectorPanel animation section', () => {
  it('renders clip and frame editors as standard property rows', async () => {
    const { panel } = await setupInspectorForAnimation();

    const labels = Array.from(panel.querySelectorAll('.property-group .property-label')).map(
      label => label.textContent?.trim()
    );

    expect(labels).toContain('Name');
    expect(labels).toContain('FPS');
    expect(labels).toContain('Playback');
    expect(labels).toContain('Duration (x)');
    expect(labels).toContain('Texture');
    expect(labels).toContain('Anchor');
    expect(labels).toContain('Box Position');
    expect(labels).toContain('Box Size');
    // Loop is a checkbox row, whose label lives in .property-label-text.
    expect(
      Array.from(panel.querySelectorAll('.property-group--checkbox .property-label-text')).map(
        text => text.textContent?.trim()
      )
    ).toContain('Loop');

    // Standard editors, not hand-rolled inputs.
    expect(panel.querySelector('pix3-vector2-editor')).not.toBeNull();
    expect(panel.querySelectorAll('pix3-number-field').length).toBeGreaterThan(0);
    expect(panel.querySelector('select.property-select--enum')).not.toBeNull();
    expect(panel.querySelector('input[type="number"]')).toBeNull();
    expect(panel.querySelector('.field-grid')).toBeNull();
    expect(panel.querySelector('.mini-button')).toBeNull();
    expect(panel.querySelector('.primary-button')).toBeNull();
    expect(panel.querySelectorAll('.inspector-button').length).toBeGreaterThan(0);
  });

  it('marks the active clip as selected and follows the selected frame index', async () => {
    const { panel, controller } = await setupInspectorForAnimation();

    const clipButtons = Array.from(
      panel.querySelectorAll('.animation-clip-button')
    ) as HTMLButtonElement[];
    const selected = clipButtons.filter(button => button.classList.contains('is-selected'));

    expect(clipButtons).toHaveLength(2);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.dataset.clipName).toBe('walk');
    expect(selected[0]?.getAttribute('aria-current')).toBe('true');
    expect(clipButtons[1]?.getAttribute('aria-current')).toBe('false');

    expect(panel.querySelector('.animation-frame-indicator-title')?.textContent?.trim()).toBe(
      'Frame 2 of 3'
    );
    // The number lives in the title only — the decorative badge used to repeat it.
    expect(panel.querySelector('.animation-frame-badge')).toBeNull();

    controller.setSelectedFrameIndex(2);
    await panel.updateComplete;

    expect(panel.querySelector('.animation-frame-indicator-title')?.textContent?.trim()).toBe(
      'Frame 3 of 3'
    );
  });

  it('scrolls the frame section into view only when the editor moves the selection', async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;

    try {
      const { panel, controller } = await setupInspectorForAnimation();
      scrollIntoView.mockClear();

      // Re-rendering with the same selection must not scroll.
      panel.requestUpdate();
      await panel.updateComplete;
      expect(scrollIntoView).not.toHaveBeenCalled();

      controller.setSelectedFrameIndex(0);
      await panel.updateComplete;
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('routes clip and frame edits back to the controller', async () => {
    const { panel, controller } = await setupInspectorForAnimation();

    (panel.querySelector('.animation-clip-actions .btn-icon') as HTMLButtonElement).click();
    expect(controller.addClip).toHaveBeenCalledTimes(1);

    const otherClip = Array.from(
      panel.querySelectorAll('.animation-clip-button')
    )[1] as HTMLButtonElement;
    otherClip.click();
    expect(controller.selectClip).toHaveBeenCalledWith('run');

    const buttons = Array.from(panel.querySelectorAll('.inspector-button')) as HTMLButtonElement[];
    const byLabel = (label: string) =>
      buttons.find(button => button.textContent?.trim() === label) as HTMLButtonElement;

    byLabel('Clear Texture').click();
    expect(controller.updateTexturePath).toHaveBeenCalledWith('');

    byLabel('Add Vertex').click();
    expect(controller.addPolygonVertex).toHaveBeenCalledTimes(1);

    byLabel('Reset Box').click();
    expect(controller.resetBoundingBox).toHaveBeenCalledTimes(1);

    const playbackSelect = panel.querySelector('select.property-select--enum') as HTMLSelectElement;
    playbackSelect.value = 'ping-pong';
    playbackSelect.dispatchEvent(new Event('change', { bubbles: true }));
    expect(controller.updateClipPlaybackMode).toHaveBeenCalledWith('ping-pong');

    const anchorEditor = panel.querySelector('pix3-vector2-editor') as HTMLElement;
    anchorEditor.dispatchEvent(
      new CustomEvent('commit-change', { detail: { x: 0.25, y: 0.5 }, bubbles: false })
    );
    expect(controller.updateSelectedFrameAnchor).toHaveBeenCalledWith('x', 0.25);
  });
});

function createAnimationFrame(texturePath: string) {
  return {
    textureIndex: 0,
    offset: { x: 0, y: 0 },
    repeat: { x: 1, y: 1 },
    durationMultiplier: 1,
    anchor: { x: 0.5, y: 0.5 },
    texturePath,
    boundingBox: { x: 0, y: 0, width: 32, height: 32 },
    collisionPolygon: [],
  };
}

type FakeAnimationController = {
  getInspectorSnapshot: () => unknown;
  subscribeInspector: (listener: () => void) => () => void;
  setSelectedFrameIndex: (index: number) => void;
  updateTexturePath: ReturnType<typeof vi.fn>;
  openTextureSlicer: ReturnType<typeof vi.fn>;
  selectClip: ReturnType<typeof vi.fn>;
  addClip: ReturnType<typeof vi.fn>;
  removeClip: ReturnType<typeof vi.fn>;
  renameClip: ReturnType<typeof vi.fn>;
  updateClipFps: ReturnType<typeof vi.fn>;
  updateClipPlaybackMode: ReturnType<typeof vi.fn>;
  updateClipLoop: ReturnType<typeof vi.fn>;
  updateSelectedFrameDurationMultiplier: ReturnType<typeof vi.fn>;
  updateSelectedFrameTexturePath: ReturnType<typeof vi.fn>;
  updateSelectedFrameAnchor: ReturnType<typeof vi.fn>;
  updateSelectedFrameBoundingBox: ReturnType<typeof vi.fn>;
  addPolygonVertex: ReturnType<typeof vi.fn>;
  clearPolygon: ReturnType<typeof vi.fn>;
  resetBoundingBox: ReturnType<typeof vi.fn>;
};

function createFakeAnimationController(): FakeAnimationController {
  const clips = [
    {
      name: 'walk',
      fps: 12,
      loop: true,
      playbackMode: 'normal' as const,
      frames: [
        createAnimationFrame('res://anim/walk_0.png'),
        createAnimationFrame('res://anim/walk_1.png'),
        createAnimationFrame('res://anim/walk_2.png'),
      ],
    },
    {
      name: 'run',
      fps: 18,
      loop: false,
      playbackMode: 'ping-pong' as const,
      frames: [createAnimationFrame('res://anim/run_0.png')],
    },
  ];
  const resource = { version: '1.0', texturePath: 'res://anim/sheet.png', clips };
  const listeners = new Set<() => void>();
  let selectedFrameIndex = 1;

  const controller: FakeAnimationController = {
    getInspectorSnapshot: () => ({
      assetPath: 'res://anim/hero.pix3anim',
      resource,
      clips,
      activeClip: clips[0],
      activeClipName: 'walk',
      selectedFrame: clips[0].frames[selectedFrameIndex] ?? null,
      selectedFrameIndex,
    }),
    subscribeInspector: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setSelectedFrameIndex: (index: number) => {
      selectedFrameIndex = index;
      for (const listener of listeners) {
        listener();
      }
    },
    updateTexturePath: vi.fn().mockResolvedValue(undefined),
    openTextureSlicer: vi.fn().mockResolvedValue(undefined),
    selectClip: vi.fn().mockResolvedValue(undefined),
    addClip: vi.fn().mockResolvedValue(undefined),
    removeClip: vi.fn().mockResolvedValue(undefined),
    renameClip: vi.fn().mockResolvedValue(undefined),
    updateClipFps: vi.fn().mockResolvedValue(undefined),
    updateClipPlaybackMode: vi.fn().mockResolvedValue(undefined),
    updateClipLoop: vi.fn().mockResolvedValue(undefined),
    updateSelectedFrameDurationMultiplier: vi.fn().mockResolvedValue(undefined),
    updateSelectedFrameTexturePath: vi.fn().mockResolvedValue(undefined),
    updateSelectedFrameAnchor: vi.fn().mockResolvedValue(undefined),
    updateSelectedFrameBoundingBox: vi.fn().mockResolvedValue(undefined),
    addPolygonVertex: vi.fn().mockResolvedValue(undefined),
    clearPolygon: vi.fn().mockResolvedValue(undefined),
    resetBoundingBox: vi.fn().mockResolvedValue(undefined),
  };

  return controller;
}

async function setupInspectorForAnimation(): Promise<{
  panel: InstanceType<typeof InspectorPanel>;
  controller: FakeAnimationController;
}> {
  const controller = createFakeAnimationController();
  const panel = document.createElement('pix3-inspector-panel') as InstanceType<
    typeof InspectorPanel
  >;

  Object.defineProperty(panel, 'sceneManager', {
    value: { getSceneGraph: vi.fn(() => null), getActiveSceneGraph: vi.fn(() => null) },
    configurable: true,
  });
  Object.defineProperty(panel, 'commandDispatcher', {
    value: { execute: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
  Object.defineProperty(panel, 'iconService', {
    value: { getIcon: vi.fn(() => '') },
    configurable: true,
  });
  Object.defineProperty(panel, 'assetsPreviewService', {
    value: {
      subscribe: (listener: (snapshot: { selectedItem: null }) => void) => {
        listener({ selectedItem: null });
        return () => undefined;
      },
    },
    configurable: true,
  });
  Object.defineProperty(panel, 'animationEditorService', {
    value: {
      getActiveController: () => controller,
      getActiveAssetPath: () => 'res://anim/hero.pix3anim',
      subscribe: (listener: (snapshot: unknown) => void) => {
        listener({ assetPath: 'res://anim/hero.pix3anim', controller });
        return () => undefined;
      },
    },
    configurable: true,
  });
  Object.defineProperty(panel, 'viewportService', {
    value: { setPreviewAnimation: vi.fn() },
    configurable: true,
  });

  document.body.appendChild(panel);
  await panel.updateComplete;

  return { panel, controller };
}

async function setupInspectorForNode(
  node: NodeBase,
  execute = vi.fn().mockResolvedValue(undefined)
): Promise<{ panel: InstanceType<typeof InspectorPanel>; execute: typeof execute }> {
  const panel = document.createElement('pix3-inspector-panel') as InstanceType<
    typeof InspectorPanel
  >;

  Object.defineProperty(panel, 'sceneManager', {
    value: { getSceneGraph: vi.fn(() => null), getActiveSceneGraph: vi.fn(() => null) },
    configurable: true,
  });
  Object.defineProperty(panel, 'commandDispatcher', {
    value: { execute },
    configurable: true,
  });
  Object.defineProperty(panel, 'behaviorPickerService', {
    value: { showPicker: vi.fn() },
    configurable: true,
  });
  Object.defineProperty(panel, 'scriptCreatorService', {
    value: { showCreator: vi.fn(), createScript: vi.fn(), checkIfScriptExists: vi.fn() },
    configurable: true,
  });
  Object.defineProperty(panel, 'scriptRegistry', {
    value: { getComponentPropertySchema: vi.fn(() => null), getComponentType: vi.fn(() => null) },
    configurable: true,
  });
  Object.defineProperty(panel, 'iconService', {
    value: { getIcon: vi.fn(() => 'icon') },
    configurable: true,
  });
  Object.defineProperty(panel, 'dialogService', {
    value: { showConfirmation: vi.fn() },
    configurable: true,
  });
  Object.defineProperty(panel, 'fileSystemAPI', {
    value: { readBlob: vi.fn(), listDirectory: vi.fn(async () => []) },
    configurable: true,
  });
  Object.defineProperty(panel, 'projectStorage', {
    value: { readTextFile: vi.fn(async () => '') },
    configurable: true,
  });
  Object.defineProperty(panel, 'assetsPreviewService', {
    value: {
      subscribe: (listener: (snapshot: { selectedItem: null }) => void) => {
        listener({ selectedItem: null });
        return () => undefined;
      },
    },
    configurable: true,
  });
  Object.defineProperty(panel, 'viewportService', {
    value: { setPreviewAnimation: vi.fn() },
    configurable: true,
  });

  document.body.appendChild(panel);

  (
    panel as unknown as {
      selectedNodes: NodeBase[];
      primaryNode: NodeBase;
      syncValuesFromNode: () => void;
    }
  ).selectedNodes = [node];
  (panel as unknown as { primaryNode: NodeBase }).primaryNode = node;
  (
    panel as unknown as {
      syncValuesFromNode: () => void;
    }
  ).syncValuesFromNode();

  panel.requestUpdate();
  await panel.updateComplete;

  return { panel, execute };
}
