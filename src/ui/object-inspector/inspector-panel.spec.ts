import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AmbientLightNode,
  AudioPlayer,
  Camera3D,
  Group2D,
  NodeBase,
  PlaySoundBehavior,
  type PropertyDefinition,
  type PropertySchema,
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
    // Matched by the disclosure state rather than the variant class: the trigger keeps a text
    // label (no conventional icon means no icon-only variant), and that is not what this asserts.
    const trigger = panel.querySelector(
      '.inspector-summary-actions .inspector-btn[aria-expanded]'
    ) as HTMLButtonElement | null;

    expect(chips).toEqual(['hud', 'ui']);
    expect(panel.querySelector('.groups-popover')).toBeNull();

    trigger?.click();
    await panel.updateComplete;

    expect(panel.querySelector('.groups-popover')).not.toBeNull();
  });

  it('merges Size, Anchors and Flow into one Layout section after Transform', async () => {
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
    const subsections = Array.from(panel.querySelectorAll('.inspector-subsection__title')).map(
      title => title.textContent?.trim()
    );

    expect(titles).toContain('Transform');
    expect(titles).toContain('Layout');
    // Size / Anchors / Flow are sub-blocks of Layout now, not sections of their own.
    expect(titles).not.toContain('Anchor');
    // Style holds two rows (Opacity + Blend Mode), so it keeps its heading; the
    // titleless treatment is only for a group that renders a single control.
    expect(titles).toContain('Style');
    expect(titles).not.toContain('Anchors');
    expect(titles).not.toContain('Align');
    expect(titles).not.toContain('Flow');
    expect(titles.filter(title => title === 'Layout')).toHaveLength(1);
    expect(titles.indexOf('Transform')).toBeLessThan(titles.indexOf('Layout'));
    // Reading order inside the section: how big am I, where do I sit, how do I place my children.
    expect(subsections).toEqual(['Anchors', 'Flow']);
    expect(panel.querySelector('.layout-section__body .layout-size-block')).not.toBeNull();
    expect(panel.textContent).toContain('Opacity');
    expect(panel.textContent).toContain('Blend Mode');
    expect(panel.querySelector('.property-group--opacity')).not.toBeNull();
  });

  it('gives Anchors and Flow the same switch affordance and hint while they are off', async () => {
    const { panel, execute } = await setupInspectorForNode(
      new Group2D({
        id: 'group-root',
        name: 'HUD Root',
        width: 320,
        height: 180,
      })
    );

    const anchors = getSubsection(panel, 'Anchors');
    const flow = getSubsection(panel, 'Flow');

    // Same component, same slot, same role — that identity IS the step.
    for (const block of [anchors, flow]) {
      const toggle = block?.querySelector('.inspector-subsection__actions .inspector-switch');
      expect(toggle?.getAttribute('role')).toBe('switch');
      expect(toggle?.getAttribute('aria-checked')).toBe('false');
      expect(toggle?.getAttribute('aria-label')?.trim()).toBeTruthy();
      expect(toggle?.getAttribute('title')?.trim()).toBeTruthy();
      // Off: one hint line, no property rows and no body.
      expect(block?.querySelector('.inspector-subsection__body')).toBeNull();
      expect(block?.querySelectorAll('.property-group')).toHaveLength(0);
    }

    expect(anchors?.querySelector('.inspector-subsection__hint')?.textContent?.trim()).toBe(
      "Position this node against its parent's edges."
    );
    expect(flow?.querySelector('.inspector-subsection__hint')?.textContent?.trim()).toBe(
      "Stack this node's children in a row or column."
    );
    expect(panel.querySelector('.anchor-visual-editor')).toBeNull();

    // Clicking the hint flips the switch on — same handler as the switch itself.
    flow
      ?.querySelector<HTMLButtonElement>('.inspector-subsection__hint')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    await vi.waitFor(() => {
      const lastCommand = execute.mock.calls.at(-1)?.[0] as {
        params?: { propertyPath: string; value: unknown };
      };
      expect(lastCommand.params?.propertyPath).toBe('flowEnabled');
      expect(lastCommand.params?.value).toBe(true);
    });
  });

  it('produces exactly one undoable command per sub-block switch toggle', async () => {
    const node = new Group2D({ id: 'group-root', name: 'HUD Root', width: 320, height: 180 });
    const { panel, execute } = await setupInspectorForNode(node);

    for (const [title, propertyPath] of [
      ['Anchors', 'layoutEnabled'],
      ['Flow', 'flowEnabled'],
    ] as const) {
      execute.mockClear();
      getSubsection(panel, title)
        ?.querySelector<HTMLButtonElement>('.inspector-switch')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

      await vi.waitFor(() => {
        expect(execute).toHaveBeenCalledTimes(1);
      });
      const command = execute.mock.calls[0]?.[0] as {
        params?: { propertyPath: string; value: unknown; historyMode?: string };
      };
      expect(command.params?.propertyPath).toBe(propertyPath);
      expect(command.params?.value).toBe(true);
      expect(command.params?.historyMode).toBe('commit');
    }
  });

  it('lists the Flow properties in reading order and drops the flowEnabled row', async () => {
    const node = new Group2D({ id: 'group-root', name: 'HUD Root', width: 320, height: 180 });
    node.setFlow({ enabled: true, direction: 'vertical' });

    const { panel } = await setupInspectorForNode(node);
    const flowBody = getSubsection(panel, 'Flow')?.querySelector('.inspector-subsection__body');
    // A checkbox row carries BOTH `.property-label` and `.property-label-text`,
    // so read one label per row rather than every matching element.
    const labels = Array.from(flowBody?.querySelectorAll('.property-group') ?? []).map(row =>
      row.querySelector('.property-label-text, .property-label')?.textContent?.trim()
    );

    expect(labels).toEqual([
      'Direction',
      'Gap',
      'Padding X',
      'Padding Y',
      'Cross Axis',
      'Auto Size',
    ]);
    // `flowEnabled` became the header switch; repeating it as a checkbox row was the old idiom.
    expect(labels).not.toContain('Flow');
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
    // The anchor modes are one radio group per axis, not four loose buttons.
    const horizontalOptions = getAnchorModeOptions(panel, 'horizontal');
    const horizontalLeftButton = horizontalOptions[0];
    const leftButtonIcon = horizontalLeftButton?.querySelector('svg');

    expect(anchorEditor).not.toBeNull();
    expect(leftButtonIcon).not.toBeNull();
    expect(horizontalOptions).toHaveLength(4);
    // Exactly one option is checked, and only that one is in the tab order
    // (roving tabindex) — that is what makes it a radio group and not four
    // independent buttons.
    expect(
      horizontalOptions.filter(option => option.getAttribute('aria-checked') === 'true')
    ).toHaveLength(1);
    expect(horizontalOptions.map(option => option.getAttribute('tabindex'))).toEqual(
      horizontalOptions.map(option => (option.getAttribute('aria-checked') === 'true' ? '0' : '-1'))
    );

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

  it('renders components as a flat section with an enabled switch and no foldout button', async () => {
    const node = new AudioPlayer({
      id: 'audio-player',
      name: 'Audio Player',
    });
    const component = new PlaySoundBehavior('behavior-1', 'core:PlaySound');
    component.enabled = false;
    node.addComponent(component);

    const { panel, execute } = await setupInspectorForNode(node);

    const sectionTitle = Array.from(panel.querySelectorAll('.group-title')).find(
      title => title.textContent?.trim() === 'Components'
    );
    const foldout = panel.querySelector('.script-foldout-btn');
    // Enable/disable is the permanent state of an entity, so it is a switch —
    // not a button labelled with its own current state.
    const enableSwitch = panel.querySelector<HTMLButtonElement>('.script-actions [role="switch"]');
    const removeButton = panel.querySelector<HTMLButtonElement>(
      '.script-actions .inspector-btn--danger'
    );
    const disabledName = panel.querySelector('.component-block--disabled .script-name');

    expect(sectionTitle).not.toBeUndefined();
    expect(foldout).toBeNull();
    expect(enableSwitch).not.toBeNull();
    expect(enableSwitch?.getAttribute('aria-checked')).toBe('false');
    expect(enableSwitch?.getAttribute('aria-label')).toBe('Enable core:PlaySound');
    expect(removeButton?.getAttribute('aria-label')).toBe('Remove core:PlaySound');
    expect(disabledName?.textContent).toContain('core:PlaySound');

    enableSwitch?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await vi.waitFor(() => {
      const lastCommand = execute.mock.calls.at(-1)?.[0] as {
        params?: { componentId?: string; enabled?: boolean };
      };
      expect(lastCommand.params?.componentId).toBe('behavior-1');
      expect(lastCommand.params?.enabled).toBe(true);
    });
  });

  it('gives every icon-only inspector control a non-empty aria-label and title', async () => {
    const node = new AudioPlayer({
      id: 'audio-player',
      name: 'Audio Player',
    });
    node.addComponent(new PlaySoundBehavior('behavior-1', 'core:PlaySound'));

    const { panel } = await setupInspectorForNode(node);

    const iconOnly = Array.from(
      panel.querySelectorAll<HTMLElement>('.inspector-btn--icon, .inspector-switch')
    );
    expect(iconOnly.length).toBeGreaterThan(0);

    const unlabelled = iconOnly.filter(
      el => !el.getAttribute('aria-label')?.trim() || !el.getAttribute('title')?.trim()
    );
    expect(unlabelled.map(el => el.className)).toEqual([]);
  });

  it('reflects the editor flags as aria-pressed toggle buttons', async () => {
    const node = new AudioPlayer({
      id: 'audio-player',
      name: 'Audio Player',
    });

    const { panel } = await setupInspectorForNode(node);

    const flags = Array.from(
      panel.querySelectorAll<HTMLButtonElement>('.editor-flags-row .inspector-btn--toggle')
    );

    expect(flags.map(flag => flag.getAttribute('aria-label'))).toEqual(['Visible', 'Locked']);
    expect(flags.map(flag => flag.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
  });

  it('labels every icon-only control on a Node2D and keeps no pre-primitive class', async () => {
    const node = new Group2D({ id: 'group-root', name: 'HUD Root', width: 320, height: 180 });
    node.layoutEnabled = true;

    const { panel } = await setupInspectorForNode(node);

    const iconOnly = Array.from(
      panel.querySelectorAll<HTMLElement>('.inspector-btn--icon, .inspector-switch')
    );
    expect(iconOnly.length).toBeGreaterThan(0);
    expect(
      iconOnly
        .filter(el => !el.getAttribute('aria-label')?.trim() || !el.getAttribute('title')?.trim())
        .map(el => el.className)
    ).toEqual([]);

    // Every idiom the button pass replaced. A survivor here means a control was
    // migrated in one place and left behind in another.
    const retired = [
      'inspector-button',
      'summary-toolbar-button',
      'btn-icon',
      'btn-add-behavior',
      'btn-add-group',
      'btn-copy-resource',
      'size-lock-button',
      'size-reset-button',
      'property-revert-button',
      'group-fit-button',
      'localization-extract-button',
      'anchor-mode-button',
      'animation-preview-btn',
      'animation-default-btn',
      'component-action-link',
      'editor-flag-button',
      // G11: Anchors and Flow are one `.inspector-subsection` shape now.
      'anchor-section-header',
      'anchor-toggle-button',
      'anchor-toggle-row',
      'anchor-fields',
    ];
    const survivors = retired.filter(name => panel.querySelector(`.${name}`) !== null);
    expect(survivors).toEqual([]);
  });

  it('moves the anchor mode with the arrow keys inside the radio group', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const node = new Group2D({ id: 'group-root', name: 'HUD Root', width: 320, height: 180 });
    node.layoutEnabled = true;

    const { panel } = await setupInspectorForNode(node, execute);

    const modes = ['left', 'center', 'right', 'stretch'];
    const options = getAnchorModeOptions(panel, 'horizontal');
    expect(options).toHaveLength(modes.length);

    const checkedIndex = options.findIndex(
      option => option.getAttribute('aria-checked') === 'true'
    );
    expect(checkedIndex).toBeGreaterThanOrEqual(0);
    const expectedMode = modes[(checkedIndex + 1) % modes.length];

    options[checkedIndex]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, composed: true })
    );

    await vi.waitFor(() => {
      const lastCommand = execute.mock.calls.at(-1)?.[0] as {
        params?: { propertyPath: string; value: unknown };
      };
      expect(lastCommand.params?.propertyPath).toBe('horizontalAlign');
      expect(lastCommand.params?.value).toBe(expectedMode);
    });
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
    expect(panel.querySelectorAll('.inspector-btn').length).toBeGreaterThan(0);
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

    (
      panel.querySelector('.animation-clip-actions .inspector-btn--primary') as HTMLButtonElement
    ).click();
    expect(controller.addClip).toHaveBeenCalledTimes(1);

    const otherClip = Array.from(
      panel.querySelectorAll('.animation-clip-button')
    )[1] as HTMLButtonElement;
    otherClip.click();
    expect(controller.selectClip).toHaveBeenCalledWith('run');

    const buttons = Array.from(panel.querySelectorAll('.inspector-btn')) as HTMLButtonElement[];
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

/** The `role="radio"` options of one anchor axis, in render order. */
function getAnchorModeOptions(panel: HTMLElement, axis: 'horizontal' | 'vertical') {
  const rows = Array.from(panel.querySelectorAll('.anchor-control-row'));
  const row = rows[axis === 'horizontal' ? 0 : 1];
  return Array.from(row?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []);
}

/** One Layout sub-block (`Anchors` / `Flow`) by title. */
function getSubsection(panel: HTMLElement, title: string): HTMLElement | null {
  return panel.querySelector<HTMLElement>(`.inspector-subsection[data-subsection="${title}"]`);
}

/** The two `pix3-number-field`s of the Transform Position row, in x/y order. */
async function getPositionAxisFields(panel: HTMLElement): Promise<HTMLElement[]> {
  const group = Array.from(panel.querySelectorAll('.transform-section .property-group')).find(
    row => row.querySelector('.property-label')?.textContent?.trim() === 'Position'
  );
  const editor = group?.querySelector<
    HTMLElement & { shadowRoot: ShadowRoot | null; updateComplete?: Promise<unknown> }
  >('pix3-vector2-editor');
  await editor?.updateComplete;
  return Array.from(editor?.shadowRoot?.querySelectorAll<HTMLElement>('pix3-number-field') ?? []);
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

/**
 * G10 section spine (`.plans/ui-consistency-pass.md` §3.1). The probe node owns
 * its whole schema (a static `getPropertySchema` REPLACES the base class one),
 * so each test states exactly the group names and `groups` metadata it is about.
 */
let probeSchema: PropertySchema = { nodeType: 'ProbeNode', properties: [] };

class ProbeNode extends NodeBase {
  static getPropertySchema(): PropertySchema {
    return probeSchema;
  }
}

function probeProperty(name: string, group: string): PropertyDefinition {
  return {
    name,
    type: 'string',
    ui: { label: name, group },
    getValue: () => '',
    setValue: () => {},
  };
}

function setProbeSchema(
  properties: [name: string, group: string][],
  groups?: PropertySchema['groups']
): void {
  probeSchema = {
    nodeType: 'ProbeNode',
    properties: properties.map(([name, group]) => probeProperty(name, group)),
    ...(groups ? { groups } : {}),
  };
}

async function setupProbeInspector() {
  return setupInspectorForNode(new ProbeNode({ id: 'probe-1', name: 'Probe', type: 'ProbeNode' }));
}

function getSectionTitles(panel: HTMLElement): string[] {
  return Array.from(panel.querySelectorAll('.group-title')).map(
    title => title.textContent?.trim() ?? ''
  );
}

function getSectionToggle(panel: HTMLElement, sectionName: string): HTMLButtonElement | null {
  return panel.querySelector<HTMLButtonElement>(`[data-section="${sectionName}"] .group-toggle`);
}

describe('InspectorPanel section spine', () => {
  beforeEach(() => {
    localStorage.clear();
    probeSchema = { nodeType: 'ProbeNode', properties: [] };
  });

  it('folds aliased groups into Transform instead of rendering them as their own sections', async () => {
    setProbeSchema([
      ['positionValue', 'Position'],
      ['orderingValue', 'Ordering'],
      ['zebraValue', 'Zebra'],
    ]);

    const { panel } = await setupProbeInspector();
    const titles = getSectionTitles(panel);
    const transformBody = panel.querySelector('[data-section="Transform"]');

    expect(titles).toContain('Transform');
    expect(titles).not.toContain('Position');
    expect(titles).not.toContain('Ordering');
    expect(transformBody?.textContent).toContain('positionValue');
    expect(transformBody?.textContent).toContain('orderingValue');
    // The unaliased group keeps its own name, after the spine.
    expect(titles.indexOf('Transform')).toBeLessThan(titles.indexOf('Zebra'));
  });

  it('renders unaliased groups in declaration order and never alphabetically', async () => {
    setProbeSchema([
      ['zebraValue', 'Zebra'],
      ['alphaValue', 'Alpha'],
    ]);

    const { panel } = await setupProbeInspector();
    const titles = getSectionTitles(panel);

    expect(titles.indexOf('Zebra')).toBeLessThan(titles.indexOf('Alpha'));
  });

  it('collapses a section the schema marks `expanded: false` and keeps the spine expanded', async () => {
    setProbeSchema(
      [
        ['transformValue', 'Transform'],
        ['debugValue', 'Debug Info'],
      ],
      {
        'Debug Info': { label: 'Debug Info', expanded: false },
        Transform: { label: 'Transform', expanded: false },
      }
    );

    const { panel } = await setupProbeInspector();
    const debugToggle = getSectionToggle(panel, 'Debug Info');
    const debugBody = panel.querySelector<HTMLElement>(
      '[data-section="Debug Info"] .property-group-section__body'
    );

    expect(debugToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(debugToggle?.getAttribute('aria-controls')).toBe(debugBody?.id);
    expect(debugBody?.hasAttribute('hidden')).toBe(true);
    // Node/Transform/Layout never start collapsed, whatever the schema says.
    expect(getSectionToggle(panel, 'Transform')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('persists a collapsed section per node type and restores it on the next mount', async () => {
    setProbeSchema([['transformValue', 'Transform']]);

    const first = await setupProbeInspector();
    getSectionToggle(first.panel, 'Transform')?.click();
    await first.panel.updateComplete;

    expect(getSectionToggle(first.panel, 'Transform')?.getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(localStorage.getItem('pix3.inspector.collapsed') ?? '{}')).toEqual({
      'ProbeNode::Transform': true,
    });

    document.body.innerHTML = '';
    const second = await setupProbeInspector();

    expect(getSectionToggle(second.panel, 'Transform')?.getAttribute('aria-expanded')).toBe(
      'false'
    );
  });

  it('renders every section expanded when the stored collapse state is absent or malformed', async () => {
    setProbeSchema([
      ['transformValue', 'Transform'],
      ['zebraValue', 'Zebra'],
    ]);

    const absent = await setupProbeInspector();
    expect(
      Array.from(absent.panel.querySelectorAll('.group-toggle')).map(toggle =>
        toggle.getAttribute('aria-expanded')
      )
    ).toEqual(['true', 'true']);

    document.body.innerHTML = '';
    localStorage.setItem('pix3.inspector.collapsed', '{not json');
    const malformed = await setupProbeInspector();
    expect(
      Array.from(malformed.panel.querySelectorAll('.group-toggle')).map(toggle =>
        toggle.getAttribute('aria-expanded')
      )
    ).toEqual(['true', 'true']);

    document.body.innerHTML = '';
    localStorage.setItem('pix3.inspector.collapsed', '["ProbeNode::Zebra"]');
    const wrongShape = await setupProbeInspector();
    expect(
      Array.from(wrongShape.panel.querySelectorAll('.group-toggle')).map(toggle =>
        toggle.getAttribute('aria-expanded')
      )
    ).toEqual(['true', 'true']);
  });
});

/**
 * The verified axis table of `.plans/ui-consistency-pass.md` §3.2. The runtime does NOT
 * ignore anchors under a flow parent: `Node2D.applyFlowLayout()` claims the MAIN axis
 * (per `flow.direction`) and hands the CROSS axis to the child's own anchor when
 * `layoutEnabled`, else places it by the parent's `Cross Axis`. So exactly one Position
 * field is driven when the child anchors itself, and both when it does not.
 */
describe('InspectorPanel Layout under a flow parent', () => {
  function makeFlowChild(direction: 'vertical' | 'horizontal', anchored: boolean) {
    const parent = new Group2D({ id: 'hud', name: 'HUD', width: 320, height: 180 });
    const child = new Group2D({ id: 'row', name: 'Row', width: 120, height: 32 });
    parent.add(child);
    child.layoutEnabled = anchored;
    parent.setFlow({ enabled: true, direction });
    return { parent, child };
  }

  it('disables only the axis a vertical flow drives and keeps the anchored cross axis editable', async () => {
    const { child } = makeFlowChild('vertical', true);
    const { panel } = await setupInspectorForNode(child);

    const [x, y] = await getPositionAxisFields(panel);

    expect(y?.hasAttribute('disabled')).toBe(true);
    expect(y?.getAttribute('title')).toBe('Driven by Flow on HUD');
    expect(x?.hasAttribute('disabled')).toBe(false);
    expect(x?.hasAttribute('title')).toBe(false);
  });

  it('disables both axes when the child does not anchor itself', async () => {
    const { child } = makeFlowChild('vertical', false);
    const { panel } = await setupInspectorForNode(child);

    const [x, y] = await getPositionAxisFields(panel);

    expect(y?.hasAttribute('disabled')).toBe(true);
    expect(x?.hasAttribute('disabled')).toBe(true);
    expect(x?.getAttribute('title')).toBe('Driven by Flow on HUD');
  });

  it('mirrors the table for a horizontal flow — X driven, anchored Y editable', async () => {
    const { child } = makeFlowChild('horizontal', true);
    const { panel } = await setupInspectorForNode(child);

    const [x, y] = await getPositionAxisFields(panel);

    expect(x?.hasAttribute('disabled')).toBe(true);
    expect(x?.getAttribute('title')).toBe('Driven by Flow on HUD');
    expect(y?.hasAttribute('disabled')).toBe(false);
  });

  it('leaves Position fully editable when no parent flow drives the node', async () => {
    const node = new Group2D({ id: 'row', name: 'Row', width: 120, height: 32 });
    node.layoutEnabled = true;
    const { panel } = await setupInspectorForNode(node);

    const fields = await getPositionAxisFields(panel);

    expect(fields).toHaveLength(2);
    expect(fields.map(field => field.hasAttribute('disabled'))).toEqual([false, false]);
    expect(panel.querySelector('.inspector-callout')).toBeNull();
  });

  it('explains who owns which axis and offers to select the flow parent', async () => {
    const { parent, child } = makeFlowChild('vertical', true);
    const { panel, execute } = await setupInspectorForNode(child);

    const callout = panel.querySelector('.inspector-callout');
    const selectParent = callout?.querySelector<HTMLButtonElement>('.inspector-btn');

    expect(callout?.getAttribute('role')).toBe('note');
    expect(callout?.querySelector('.inspector-callout__title')?.textContent?.trim()).toBe(
      'Position driven by Flow on HUD'
    );
    expect(callout?.querySelector('.inspector-callout__detail')?.textContent?.trim()).toBe(
      "Flow sets Y; this node's Anchors set X."
    );
    expect(selectParent?.getAttribute('aria-label')).toBe('Select HUD');
    expect(selectParent?.getAttribute('title')).toBe('Select HUD');
    // The Anchors sub-block stays live: the runtime still honours the cross axis.
    expect(getSubsection(panel, 'Anchors')?.querySelector('.anchor-visual-editor')).not.toBeNull();

    selectParent?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    await vi.waitFor(() => {
      const lastCommand = execute.mock.calls.at(-1)?.[0] as {
        params?: { nodeId?: string | null };
      };
      expect(lastCommand.params?.nodeId).toBe(parent.nodeId);
    });
  });

  it('points an un-anchored child at the parent Cross Axis instead', async () => {
    const { child } = makeFlowChild('horizontal', false);
    const { panel } = await setupInspectorForNode(child);

    expect(
      panel.querySelector('.inspector-callout__detail')?.textContent?.replace(/\s+/g, ' ').trim()
    ).toBe("Flow sets X; the parent's Cross Axis sets Y. Turn Anchors on to author Y.");
  });

  it('removes `stretch` from the anchor axis the flow drives and says why', async () => {
    const { child } = makeFlowChild('vertical', true);
    const { panel } = await setupInspectorForNode(child);

    const horizontal = getAnchorModeOptions(panel, 'horizontal').map(option =>
      option.getAttribute('aria-label')
    );
    const vertical = getAnchorModeOptions(panel, 'vertical').map(option =>
      option.getAttribute('aria-label')
    );

    // Cross axis keeps all four modes; the main axis loses `stretch` entirely —
    // removed rather than disabled, because it fights how the flow measures the child.
    expect(horizontal).toEqual([
      'horizontal left',
      'horizontal center',
      'horizontal right',
      'horizontal stretch',
    ]);
    expect(vertical).toEqual(['vertical top', 'vertical center', 'vertical bottom']);
    expect(
      getSubsection(panel, 'Anchors')
        ?.querySelector('.inspector-subsection__note')
        ?.textContent?.replace(/\s+/g, ' ')
        .trim()
    ).toBe('Stretch is unavailable on the V axis while Flow drives it.');
  });

  it('mirrors the removal onto the horizontal axis for a horizontal flow', async () => {
    const { child } = makeFlowChild('horizontal', true);
    const { panel } = await setupInspectorForNode(child);

    expect(
      getAnchorModeOptions(panel, 'horizontal').map(option => option.getAttribute('aria-label'))
    ).toEqual(['horizontal left', 'horizontal center', 'horizontal right']);
    expect(
      getAnchorModeOptions(panel, 'vertical').map(option => option.getAttribute('aria-label'))
    ).toEqual(['vertical top', 'vertical center', 'vertical bottom', 'vertical stretch']);
  });
});
