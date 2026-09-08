import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadLayout = vi.fn();
const registerComponentFactoryFunction = vi.fn();
const stackAddItem = vi.fn();
let lastActiveComponentItem: unknown;
let activeContentItemChangedHandler: ((...args: unknown[]) => void) | undefined;

class FakeGoldenLayout {
  public resizeWithContainerAutomatically = false;
  public rootItem: unknown = {
    type: 'row',
    contentItems: [
      {
        type: 'stack',
        contentItems: [
          {
            type: 'component',
            componentType: 'inspector',
            parent: null,
          },
          {
            type: 'component',
            componentType: 'profiler',
            parent: null,
          },
          {
            type: 'component',
            componentType: 'assets',
            parent: null,
          },
        ],
        setActiveComponentItem(item: unknown) {
          lastActiveComponentItem = item;
        },
        addItem(config: unknown, index?: number) {
          stackAddItem(config, index);
          return 0;
        },
      },
    ],
  };

  constructor(_container: HTMLElement) {
    const stack = (this.rootItem as { contentItems: Array<{ parent?: unknown }> }).contentItems[0];
    for (const item of (stack as { contentItems: Array<{ parent?: unknown }> }).contentItems) {
      item.parent = stack;
    }
  }

  loadLayout(config: unknown) {
    loadLayout(config);
  }

  registerComponentFactoryFunction(componentType: string, callback: unknown) {
    registerComponentFactoryFunction(componentType, callback);
  }

  on(name: string, handler: (...args: unknown[]) => void) {
    if (name === 'activeContentItemChanged') {
      activeContentItemChangedHandler = handler;
    }
  }

  destroy() {}
}

vi.mock('golden-layout', () => ({
  GoldenLayout: FakeGoldenLayout,
}));

describe('LayoutManagerService', () => {
  beforeEach(() => {
    loadLayout.mockReset();
    registerComponentFactoryFunction.mockReset();
    stackAddItem.mockReset();
    lastActiveComponentItem = undefined;
    activeContentItemChangedHandler = undefined;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('loads default layout with profiler in right sidebar stack', async () => {
    const { LayoutManagerService } = await import('./LayoutManager');

    const host = document.createElement('div');
    const service = new LayoutManagerService();

    await service.initialize(host);

    const config = loadLayout.mock.calls[0]?.[0] as {
      root: { content: Array<{ content?: Array<{ componentType?: string }> }> };
    };

    // Inspector, Profiler and Agent chat share the right sidebar stack.
    const rightSidebar = config.root.content[2];
    const componentTypes = rightSidebar.content?.map(item => item.componentType);

    expect(componentTypes).toEqual(['inspector', 'profiler', 'agent-chat']);
  });

  it('registers profiler panel component', async () => {
    const { LayoutManagerService } = await import('./LayoutManager');

    const host = document.createElement('div');
    const service = new LayoutManagerService();

    await service.initialize(host);

    expect(registerComponentFactoryFunction).toHaveBeenCalledWith('profiler', expect.any(Function));
  });

  it('can focus the profiler panel', async () => {
    const { LayoutManagerService } = await import('./LayoutManager');

    const host = document.createElement('div');
    const service = new LayoutManagerService();

    await service.initialize(host);
    service.focusPanel('profiler');

    expect(lastActiveComponentItem).toMatchObject({ componentType: 'profiler' });
  });

  it('tracks active non-editor panel in ui state', async () => {
    const { LayoutManagerService } = await import('./LayoutManager');
    const { appState, resetAppState } = await import('@/state');

    resetAppState();
    const host = document.createElement('div');
    const service = new LayoutManagerService();

    await service.initialize(host);
    activeContentItemChangedHandler?.({
      type: 'component',
      componentType: 'profiler',
      parent: (new FakeGoldenLayout(host).rootItem as { contentItems: unknown[] }).contentItems[0],
    });

    expect(appState.ui.focusedPanelId).toBe('profiler');
  });
  /**
   * `showPanel()` is the one path behind every `Window ▸ <panel>` row (and behind the
   * `reveal*Panel()` family, which now delegates to it), so these pin its three contracts:
   * idempotence, placement by neighbour, and hands off documents.
   */
  describe('showPanel', () => {
    it('only focuses a panel that is already in the layout', async () => {
      const { LayoutManagerService } = await import('./LayoutManager');

      const service = new LayoutManagerService();
      await service.initialize(document.createElement('div'));

      service.showPanel('profiler');

      expect(lastActiveComponentItem).toMatchObject({ componentType: 'profiler' });
      expect(stackAddItem).not.toHaveBeenCalled();
    });

    it('docks a closed panel into the stack that hosts one of its default neighbours', async () => {
      const { LayoutManagerService } = await import('./LayoutManager');

      const service = new LayoutManagerService();
      await service.initialize(document.createElement('div'));

      // Logs is not in the fake layout; Assets — its first default neighbour — is, so Logs must
      // land back in that stack rather than in a column of its own.
      service.showPanel('logs');

      expect(stackAddItem).toHaveBeenCalledTimes(1);
      expect(stackAddItem.mock.calls[0]?.[0]).toMatchObject({
        type: 'component',
        componentType: 'logs',
        title: 'Logs',
        isClosable: true,
      });
    });

    it('never docks a document type (viewport, game, code, …) as a panel', async () => {
      const { LayoutManagerService } = await import('./LayoutManager');

      const service = new LayoutManagerService();
      await service.initialize(document.createElement('div'));

      service.showPanel('game');

      // Documents need a tab id and a resource, which only EditorTabService can supply.
      expect(stackAddItem).not.toHaveBeenCalled();
    });
  });
});
