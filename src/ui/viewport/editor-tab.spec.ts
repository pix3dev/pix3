import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import { ASSET_RESOURCE_MIME } from '@/ui/shared/asset-drag-drop';
import { CreateAnimatedSprite2DCommand } from '@/features/scene/CreateAnimatedSprite2DCommand';
import { CreateSprite2DCommand } from '@/features/scene/CreateSprite2DCommand';
import type { CreateSprite2DOperationParams } from '@/features/scene/CreateSprite2DOperation';
import { Group2D, Sprite2D, type NodeBase, type SceneGraph } from '@pix3/runtime';
import { Vector2 } from 'three';

const { EditorTabComponent } = await import('./editor-tab');

describe('EditorTabComponent', () => {
  beforeEach(() => {
    resetAppState();

    if (!globalThis.ResizeObserver) {
      globalThis.ResizeObserver = class {
        disconnect(): void {}
        observe(): void {}
        unobserve(): void {}
      } as typeof ResizeObserver;
    }
  });

  afterEach(() => {
    resetAppState();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('accepts asset drags on the internal shadow DOM panel surface', async () => {
    const panel = new EditorTabComponent();
    stubPanelServices(panel);

    document.body.appendChild(panel);
    await panel.updateComplete;

    const dropSurface = panel.shadowRoot?.querySelector<HTMLElement>('.panel');
    expect(dropSurface).not.toBeNull();

    const dataTransfer = createDataTransfer([ASSET_RESOURCE_MIME]);
    const dragOverEvent = new Event('dragover', {
      bubbles: true,
      cancelable: true,
    }) as DragEvent;
    Object.defineProperty(dragOverEvent, 'dataTransfer', {
      value: dataTransfer,
      configurable: true,
    });

    dropSurface?.dispatchEvent(dragOverEvent);
    await panel.updateComplete;

    expect(dragOverEvent.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe('copy');
    expect(
      panel.shadowRoot?.querySelector('.panel')?.classList.contains('panel--asset-dragover')
    ).toBe(true);
  });

  it('accepts uri-list asset drags on the internal shadow DOM panel surface', async () => {
    const panel = new EditorTabComponent();
    stubPanelServices(panel);

    document.body.appendChild(panel);
    await panel.updateComplete;

    const dropSurface = panel.shadowRoot?.querySelector<HTMLElement>('.panel');
    expect(dropSurface).not.toBeNull();

    const dataTransfer = createDataTransfer(['text/uri-list']);
    const dragOverEvent = new Event('dragover', {
      bubbles: true,
      cancelable: true,
    }) as DragEvent;
    Object.defineProperty(dragOverEvent, 'dataTransfer', {
      value: dataTransfer,
      configurable: true,
    });

    dropSurface?.dispatchEvent(dragOverEvent);
    await panel.updateComplete;

    expect(dragOverEvent.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe('copy');
    expect(
      panel.shadowRoot?.querySelector('.panel')?.classList.contains('panel--asset-dragover')
    ).toBe(true);
  });

  it('creates a sprite command on image drop in the editor tab', async () => {
    const panel = new EditorTabComponent();
    const services = stubPanelServices(panel);

    document.body.appendChild(panel);
    await panel.updateComplete;

    const dropSurface = panel.shadowRoot?.querySelector<HTMLElement>('.panel');
    expect(dropSurface).not.toBeNull();

    const dropEvent = new Event('drop', {
      bubbles: true,
      cancelable: true,
    }) as DragEvent;
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: createDataTransfer(['text/uri-list'], {
        'text/uri-list': 'res://assets/hero.png',
      }),
      configurable: true,
    });
    Object.defineProperty(dropEvent, 'clientX', { value: 160, configurable: true });
    Object.defineProperty(dropEvent, 'clientY', { value: 120, configurable: true });

    dropSurface?.dispatchEvent(dropEvent);

    expect(dropEvent.defaultPrevented).toBe(true);
    expect(services.commandDispatcher.execute).toHaveBeenCalledTimes(1);
    expect(services.commandDispatcher.execute).toHaveBeenCalledWith(
      expect.any(CreateSprite2DCommand)
    );
  });

  it('creates a sprite command when the image is dropped on the viewport host', async () => {
    const panel = new EditorTabComponent();
    const services = stubPanelServices(panel);

    document.body.appendChild(panel);
    await panel.updateComplete;

    const host = panel.shadowRoot?.querySelector<HTMLElement>('.viewport-host');
    expect(host).not.toBeNull();

    const dropEvent = new Event('drop', {
      bubbles: true,
      cancelable: true,
    }) as DragEvent;
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: createDataTransfer(['text/uri-list'], {
        'text/uri-list': 'res://assets/hero.png',
      }),
      configurable: true,
    });
    Object.defineProperty(dropEvent, 'clientX', { value: 160, configurable: true });
    Object.defineProperty(dropEvent, 'clientY', { value: 120, configurable: true });

    host?.dispatchEvent(dropEvent);

    expect(dropEvent.defaultPrevented).toBe(true);
    expect(services.commandDispatcher.execute).toHaveBeenCalledTimes(1);
    expect(services.commandDispatcher.execute).toHaveBeenCalledWith(
      expect.any(CreateSprite2DCommand)
    );
  });

  it('creates an animated sprite command when a .pix3anim asset is dropped on the viewport host', async () => {
    const panel = new EditorTabComponent();
    const services = stubPanelServices(panel);

    document.body.appendChild(panel);
    await panel.updateComplete;

    const host = panel.shadowRoot?.querySelector<HTMLElement>('.viewport-host');
    expect(host).not.toBeNull();

    const dropEvent = new Event('drop', {
      bubbles: true,
      cancelable: true,
    }) as DragEvent;
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: createDataTransfer(['text/uri-list'], {
        'text/uri-list': 'res://animations/walk.pix3anim',
      }),
      configurable: true,
    });
    Object.defineProperty(dropEvent, 'clientX', { value: 160, configurable: true });
    Object.defineProperty(dropEvent, 'clientY', { value: 120, configurable: true });

    host?.dispatchEvent(dropEvent);

    expect(dropEvent.defaultPrevented).toBe(true);
    expect(services.commandDispatcher.execute).toHaveBeenCalledTimes(1);
    expect(services.commandDispatcher.execute).toHaveBeenCalledWith(
      expect.any(CreateAnimatedSprite2DCommand)
    );
  });

  it('switches keyboard shortcut context to the viewport when the viewport host is clicked', async () => {
    appState.tabs.activeTabId = 'tab-1';
    appState.editorContext.focusedArea = 'scene-tree';

    const panel = new EditorTabComponent();
    panel.tabId = 'tab-1';
    stubPanelServices(panel);

    document.body.appendChild(panel);
    await panel.updateComplete;

    const host = panel.shadowRoot?.querySelector<HTMLElement>('.viewport-host');
    expect(host).not.toBeNull();

    host?.dispatchEvent(createPointerEvent('pointerdown', { clientX: 120, clientY: 90 }));

    expect(appState.editorContext.focusedArea).toBe('viewport');
  });

  it('parents dropped sprites into the compatible 2D container under the cursor', async () => {
    appState.scenes.activeSceneId = 'scene-1';

    const panel = new EditorTabComponent();
    const services = stubPanelServices(panel);
    const containerNode = new Group2D({
      id: 'container-node',
      name: 'UI Layer',
      position: new Vector2(50, 60),
    });
    const childNode = new Sprite2D({
      id: 'child-node',
      name: 'Existing Sprite',
      texturePath: 'res://assets/existing.png',
      position: new Vector2(10, 15),
      width: 32,
      height: 32,
    });
    containerNode.add(childNode);
    containerNode.updateWorldMatrix(true, true);

    services.viewportRenderer.raycastObject.mockReturnValue(childNode as NodeBase);
    services.viewportRenderer.resolve2DAssetDropPosition.mockReturnValue(new Vector2(110, 220));
    services.sceneManager.getSceneGraph.mockReturnValue({
      rootNodes: [containerNode],
      nodeMap: new Map<string, NodeBase>([
        [containerNode.nodeId, containerNode],
        [childNode.nodeId, childNode],
      ]),
    } as unknown as SceneGraph);

    document.body.appendChild(panel);
    await panel.updateComplete;

    const host = panel.shadowRoot?.querySelector<HTMLElement>('.viewport-host');
    expect(host).not.toBeNull();

    const dropEvent = new Event('drop', {
      bubbles: true,
      cancelable: true,
    }) as DragEvent;
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: createDataTransfer(['text/uri-list'], {
        'text/uri-list': 'res://assets/hero.png',
      }),
      configurable: true,
    });
    Object.defineProperty(dropEvent, 'clientX', { value: 160, configurable: true });
    Object.defineProperty(dropEvent, 'clientY', { value: 120, configurable: true });

    host?.dispatchEvent(dropEvent);

    const command = services.commandDispatcher.execute.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(CreateSprite2DCommand);
    const params = (command as unknown as { params: CreateSprite2DOperationParams }).params;
    expect(params.parentNodeId).toBe('container-node');
    expect(params.position?.x).toBeCloseTo(60);
    expect(params.position?.y).toBeCloseTo(160);
  });

  it('toggles viewport selection on ctrl click', async () => {
    appState.tabs.activeTabId = 'tab-1';

    const panel = new EditorTabComponent();
    panel.tabId = 'tab-1';
    const services = stubPanelServices(panel);
    const hitNode = new Sprite2D({
      id: 'sprite-toggle',
      name: 'Toggle Sprite',
      texturePath: 'res://assets/toggle.png',
      width: 32,
      height: 32,
    });
    services.viewportRenderer.raycastObject.mockReturnValue(hitNode as NodeBase);

    document.body.appendChild(panel);
    await panel.updateComplete;

    panel.dispatchEvent(
      createPointerEvent('pointerdown', { clientX: 120, clientY: 90, buttons: 1, ctrlKey: true })
    );
    panel.dispatchEvent(
      createPointerEvent('pointerup', { clientX: 120, clientY: 90, ctrlKey: true })
    );

    expect(services.commandDispatcher.execute).toHaveBeenCalledTimes(1);
    const command = services.commandDispatcher.execute.mock.calls[0]?.[0] as {
      params?: {
        nodeId?: string | null;
        additive?: boolean;
      };
    };
    expect(command.params).toEqual({ nodeId: 'sprite-toggle', additive: true });
  });

  it('toggles a selected 2d node on ctrl click instead of starting move transform', async () => {
    appState.tabs.activeTabId = 'tab-1';
    appState.ui.navigationMode = '2d';

    const panel = new EditorTabComponent();
    panel.tabId = 'tab-1';
    const services = stubPanelServices(panel);
    const hitNode = new Sprite2D({
      id: 'sprite-selected-toggle',
      name: 'Selected Sprite',
      texturePath: 'res://assets/selected-toggle.png',
      width: 32,
      height: 32,
    });
    services.viewportRenderer.get2DHandleAt.mockReturnValue('move');
    services.viewportRenderer.raycastObject.mockReturnValue(hitNode as NodeBase);

    document.body.appendChild(panel);
    await panel.updateComplete;

    panel.dispatchEvent(
      createPointerEvent('pointerdown', { clientX: 120, clientY: 90, buttons: 1, ctrlKey: true })
    );
    panel.dispatchEvent(
      createPointerEvent('pointerup', { clientX: 120, clientY: 90, ctrlKey: true })
    );

    expect(services.viewportRenderer.start2DTransform).not.toHaveBeenCalled();
    expect(services.commandDispatcher.execute).toHaveBeenCalledTimes(1);
    const command = services.commandDispatcher.execute.mock.calls[0]?.[0] as {
      params?: {
        nodeId?: string | null;
        additive?: boolean;
      };
    };
    expect(command.params).toEqual({ nodeId: 'sprite-selected-toggle', additive: true });
  });

  it('keeps selection unchanged on ctrl click in empty viewport space', async () => {
    appState.tabs.activeTabId = 'tab-1';
    appState.selection.nodeIds = ['selected-node'];
    appState.selection.primaryNodeId = 'selected-node';

    const panel = new EditorTabComponent();
    panel.tabId = 'tab-1';
    const services = stubPanelServices(panel);

    document.body.appendChild(panel);
    await panel.updateComplete;

    panel.dispatchEvent(
      createPointerEvent('pointerdown', { clientX: 80, clientY: 60, buttons: 1, metaKey: true })
    );
    panel.dispatchEvent(
      createPointerEvent('pointerup', { clientX: 80, clientY: 60, metaKey: true })
    );

    expect(services.commandDispatcher.execute).not.toHaveBeenCalled();
    expect(appState.selection.nodeIds).toEqual(['selected-node']);
    expect(appState.selection.primaryNodeId).toBe('selected-node');
  });

  it('selects intersecting 2D nodes with a marquee drag in 2d navigation mode', async () => {
    appState.tabs.activeTabId = 'tab-1';
    appState.ui.navigationMode = '2d';

    const panel = new EditorTabComponent();
    panel.tabId = 'tab-1';
    const services = stubPanelServices(panel);
    services.viewportRenderer.getSelectable2DNodeIdsInScreenRect.mockReturnValue([
      'node-1',
      'node-2',
    ]);

    document.body.appendChild(panel);
    await panel.updateComplete;

    panel.dispatchEvent(
      createPointerEvent('pointerdown', { clientX: 20, clientY: 30, buttons: 1 })
    );
    panel.dispatchEvent(
      createPointerEvent('pointermove', { clientX: 70, clientY: 90, buttons: 1 })
    );
    await panel.updateComplete;

    const marquee = panel.shadowRoot?.querySelector('.viewport-marquee-selection');
    expect(marquee).not.toBeNull();
    expect(services.viewportRenderer.set2DMarqueePreviewNodeIds).toHaveBeenCalledWith([
      'node-1',
      'node-2',
    ]);

    panel.dispatchEvent(createPointerEvent('pointerup', { clientX: 70, clientY: 90 }));

    expect(services.viewportRenderer.getSelectable2DNodeIdsInScreenRect).toHaveBeenCalledWith(
      20,
      30,
      70,
      90
    );
    expect(services.commandDispatcher.execute).toHaveBeenCalledTimes(1);
    const command = services.commandDispatcher.execute.mock.calls[0]?.[0] as {
      params?: {
        nodeIds?: string[];
        primaryNodeId?: string | null;
      };
    };
    expect(command.params).toEqual({ nodeIds: ['node-1', 'node-2'], primaryNodeId: 'node-1' });
    expect(services.viewportRenderer.clear2DMarqueePreview).toHaveBeenCalled();

    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector('.viewport-marquee-selection')).toBeNull();
  });
});

function stubPanelServices(panel: InstanceType<typeof EditorTabComponent>) {
  const stubCanvas = document.createElement('canvas');
  vi.spyOn(stubCanvas, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 240,
    right: 320,
    width: 320,
    height: 240,
    toJSON: () => ({}),
  });

  const commandDispatcher = {
    execute: vi.fn<(command: unknown) => Promise<boolean>>(async () => false),
    executeById: vi.fn<(id: string) => Promise<boolean>>(async () => false),
  };
  const viewportRenderer = {
    initialize: vi.fn(),
    attachToHost: vi.fn(),
    pause: vi.fn(),
    requestRender: vi.fn(),
    resize: vi.fn(),
    raycastObject: vi.fn<(x: number, y: number) => NodeBase | null>(() => null),
    resolve2DAssetDropPosition: vi.fn<(x: number, y: number) => Vector2 | null>(
      () => new Vector2(10, 20)
    ),
    setTransformMode: vi.fn(),
    updateSelection: vi.fn(),
    getCanvasElement: vi.fn(() => stubCanvas),
    get2DHandleAt: vi.fn(() => 'idle'),
    start2DTransform: vi.fn(),
    getSelectable2DNodeIdsInScreenRect: vi.fn<
      (x1: number, y1: number, x2: number, y2: number) => string[]
    >(() => []),
    set2DMarqueePreviewNodeIds: vi.fn<(nodeIds: string[]) => boolean>(() => false),
    clear2DMarqueePreview: vi.fn<() => boolean>(() => false),
    has2DTransform: vi.fn(() => false),
  };
  const sceneManager = {
    getSceneGraph: vi.fn<(sceneId: string) => SceneGraph | null>(() => null),
  };

  Object.defineProperty(panel, 'viewportRenderer', {
    value: viewportRenderer,
    configurable: true,
  });

  Object.defineProperty(panel, 'commandDispatcher', {
    value: commandDispatcher,
    configurable: true,
  });

  Object.defineProperty(panel, 'iconService', {
    value: {
      getIcon: vi.fn(() => 'icon'),
    },
    configurable: true,
  });

  Object.defineProperty(panel, 'navigation2D', {
    value: {
      startPan: vi.fn(),
      endPan: vi.fn(),
      updatePan: vi.fn(),
      clearTouchState: vi.fn(),
      handleWheel: vi.fn(),
      isTouchGestureActive: vi.fn(() => false),
      isTouchPointerTracked: vi.fn(() => false),
      startTouchPointer: vi.fn(),
      updateTouchPointer: vi.fn(() => false),
      endTouchPointer: vi.fn(() => false),
      updateTouchPan: vi.fn(),
    },
    configurable: true,
  });

  Object.defineProperty(panel, 'sceneManager', {
    value: sceneManager,
    configurable: true,
  });

  return {
    commandDispatcher,
    viewportRenderer,
    sceneManager,
  };
}

function createDataTransfer(types: string[], values: Record<string, string> = {}): DataTransfer {
  return {
    dropEffect: 'none',
    getData: vi.fn((type: string) => values[type] ?? ''),
    types,
  } as unknown as DataTransfer;
}

function createPointerEvent(
  type: string,
  init: {
    clientX: number;
    clientY: number;
    button?: number;
    buttons?: number;
    ctrlKey?: boolean;
    metaKey?: boolean;
  }
): PointerEvent {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
  }) as PointerEvent;

  Object.defineProperties(event, {
    clientX: { value: init.clientX, configurable: true },
    clientY: { value: init.clientY, configurable: true },
    button: { value: init.button ?? 0, configurable: true },
    buttons: { value: init.buttons ?? 0, configurable: true },
    ctrlKey: { value: init.ctrlKey ?? false, configurable: true },
    metaKey: { value: init.metaKey ?? false, configurable: true },
    pointerType: { value: 'mouse', configurable: true },
    pointerId: { value: 1, configurable: true },
  });

  return event;
}
