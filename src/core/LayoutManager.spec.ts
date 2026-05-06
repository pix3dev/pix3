import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadLayout = vi.fn();
const registerComponentFactoryFunction = vi.fn();
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
        ],
        setActiveComponentItem(item: unknown) {
          lastActiveComponentItem = item;
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
    const rightSidebar = config.root.content[2];
    const componentTypes = rightSidebar.content?.map(item => item.componentType);

    expect(componentTypes).toEqual(['inspector', 'profiler']);
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
});
