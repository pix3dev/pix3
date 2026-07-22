import { vi, describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { ViewportRendererService } from './ViewportRenderService';
import {
  AnimatedSprite2D,
  AmbientLightNode,
  Camera3D,
  DirectionalLightNode,
  Group2D,
  Node3D,
  Script,
  Sprite2D,
} from '@pix3/runtime';
import { appState, resetAppState } from '@/state';

describe('ViewportRendererService', () => {
  const expectedDefault2DZoom = 1 / 1.25;

  afterEach(() => {
    resetAppState();
    vi.restoreAllMocks();
  });

  it('should offset Sprite2D mesh by anchor point', () => {
    const service = new ViewportRendererService();

    const svc = service as unknown as {
      proxyRegistry: { createSprite2DVisual: (s: Sprite2D) => THREE.Group };
    };

    const sprite = new Sprite2D({
      id: 'sprite-anchor-test',
      width: 100,
      height: 50,
      anchor: { x: 0, y: 1 },
    });

    const visualRoot = svc.proxyRegistry.createSprite2DVisual(sprite);
    expect(visualRoot).toBeDefined();

    const mesh = visualRoot?.userData.spriteMesh as THREE.Mesh;
    expect(mesh.position.x).toBe(0.5);
    expect(mesh.position.y).toBe(-0.5);
  });

  it('should create an editor anchor marker for Sprite2D visuals', () => {
    const service = new ViewportRendererService();

    const svc = service as unknown as {
      proxyRegistry: { createSprite2DVisual: (s: Sprite2D) => THREE.Group };
    };

    const sprite = new Sprite2D({
      id: 'sprite-anchor-marker-test',
      width: 120,
      height: 80,
      anchor: { x: 0.25, y: 0.75 },
    });

    const visualRoot = svc.proxyRegistry.createSprite2DVisual(sprite);
    expect(visualRoot).toBeDefined();

    const anchorMarker = visualRoot?.userData.anchorMarker as THREE.Group;
    const mesh = visualRoot?.userData.spriteMesh as THREE.Mesh;
    expect(anchorMarker).toBeInstanceOf(THREE.Group);
    expect(anchorMarker.position.x).toBe(0);
    expect(anchorMarker.position.y).toBe(0);
    expect(mesh.position.x).toBe(0.25);
    expect(mesh.position.y).toBe(-0.25);

    const markerParts = anchorMarker.children.filter(child => child instanceof THREE.Mesh);
    expect(markerParts).toHaveLength(3);
  });

  it('creates AnimatedSprite2D visuals with authored bounds', () => {
    const service = new ViewportRendererService();

    const svc = service as unknown as {
      proxyRegistry: { createAnimatedSprite2DVisual: (s: AnimatedSprite2D) => THREE.Group };
      getNodeOnlyBounds?: (s: AnimatedSprite2D) => THREE.Box3;
    };

    const sprite = new AnimatedSprite2D({
      id: 'animated-sprite-test',
      width: 120,
      height: 80,
      color: '#ffffff',
    });

    const visualRoot = svc.proxyRegistry.createAnimatedSprite2DVisual(sprite);
    expect(visualRoot).toBeDefined();

    const sizeGroup = visualRoot?.userData.sizeGroup as THREE.Group;
    expect(sizeGroup.scale.x).toBe(120);
    expect(sizeGroup.scale.y).toBe(80);

    const bounds = svc.getNodeOnlyBounds?.(sprite);
    expect(bounds?.max.x).toBe(60);
    expect(bounds?.min.x).toBe(-60);
    expect(bounds?.max.y).toBe(40);
    expect(bounds?.min.y).toBe(-40);
  });

  it('should use ResourceManager.readBlob for templ:// sprite textures', async () => {
    const service = new ViewportRendererService();

    // Create a fake resource manager
    const readBlobSpy = vi.fn().mockResolvedValue(new Blob(['fake']));
    Object.defineProperty(service, 'resourceManager', {
      value: { readBlob: readBlobSpy },
      configurable: true,
    });

    // Minimal stubs for dependencies used by createSprite2DVisual
    const svc = service as unknown as {
      scene?: { add: (...args: unknown[]) => void };
      proxyRegistry: { createSprite2DVisual: (s: Sprite2D) => unknown };
    };
    svc.scene = { add: vi.fn() };

    // Create a sprite with templ scheme
    const sprite = new Sprite2D({ id: 'test-sprite', texturePath: 'templ://pix3-logo.png' });

    // Call private method reflectively
    const mesh = svc.proxyRegistry.createSprite2DVisual(sprite);

    expect(mesh).toBeDefined();

    // Wait a tick for the async fetch to be invoked
    await Promise.resolve();

    expect(readBlobSpy).toHaveBeenCalledWith('templ://pix3-logo.png');
  });

  it('should not attempt direct load for templ:// when readBlob fails', async () => {
    const service = new ViewportRendererService();

    // readBlob rejects to simulate missing mapping
    const readBlobSpy = vi.fn().mockRejectedValue(new Error('Not found'));
    Object.defineProperty(service, 'resourceManager', {
      value: { readBlob: readBlobSpy },
      configurable: true,
    });

    // stub the TextureLoader to observe direct load attempts
    const loadSpy = vi.fn();
    const three = THREE as unknown as {
      TextureLoader: {
        prototype: { load: (...args: unknown[]) => void };
      };
    };
    vi.spyOn(three.TextureLoader.prototype, 'load').mockImplementation(loadSpy);

    const svc = service as unknown as {
      scene?: { add: (...args: unknown[]) => void };
      proxyRegistry: { createSprite2DVisual: (s: Sprite2D) => unknown };
    };
    svc.scene = { add: vi.fn() };

    const sprite = new Sprite2D({ id: 'test-sprite-2', texturePath: 'templ://pix3-logo.png' });
    svc.proxyRegistry.createSprite2DVisual(sprite);

    // Wait a tick to run async failure handler
    await Promise.resolve();

    // Ensure direct loader wasn't invoked for templ:// fallback
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('returns selectable 2D node ids in scene order for a screen rectangle', () => {
    resetAppState();
    appState.ui.showLayer2D = true;
    appState.scenes.activeSceneId = 'scene-1';

    const service = new ViewportRendererService();
    const frontSprite = new Sprite2D({
      id: 'sprite-front',
      name: 'Front',
      width: 100,
      height: 80,
    });
    frontSprite.position.set(0, 0, 0);

    const leftSprite = new Sprite2D({
      id: 'sprite-left',
      name: 'Left',
      width: 80,
      height: 40,
    });
    leftSprite.position.set(-120, 40, 0);

    const hiddenSprite = new Sprite2D({
      id: 'sprite-hidden',
      name: 'Hidden',
      width: 90,
      height: 40,
    });
    hiddenSprite.position.set(-40, 0, 0);
    hiddenSprite.visible = false;

    const lockedSprite = new Sprite2D({
      id: 'sprite-locked',
      name: 'Locked',
      width: 90,
      height: 40,
    });
    lockedSprite.position.set(90, 0, 0);
    lockedSprite.properties.locked = true;

    const rootNodes = [frontSprite, hiddenSprite, leftSprite, lockedSprite];
    const nodeMap = new Map(rootNodes.map(node => [node.nodeId, node]));

    Object.defineProperty(service, 'sceneManager', {
      value: {
        getSceneGraph: () => ({ rootNodes, nodeMap }),
        getActiveSceneGraph: () => ({ rootNodes, nodeMap }),
      },
      configurable: true,
    });
    Object.defineProperty(service, 'orthographicCamera', {
      value: new THREE.OrthographicCamera(-200, 200, 150, -150, 0.1, 1000),
      configurable: true,
    });
    Object.defineProperty(service, 'viewportSize', {
      value: { width: 400, height: 300 },
      configurable: true,
      writable: true,
    });

    (service as unknown as { proxyRegistry: { sprite2DVisuals: Map<string, THREE.Group> } }).proxyRegistry.sprite2DVisuals = new Map(
      rootNodes.map(node => [node.nodeId, new THREE.Group()])
    );

    const hitNodeIds = service.getSelectable2DNodeIdsInScreenRect(90, 90, 240, 175);

    expect(hitNodeIds).toEqual(['sprite-front', 'sprite-left']);
  });

  it('matches rotated 2D nodes when their projected bounds intersect the marquee rectangle', () => {
    resetAppState();
    appState.ui.showLayer2D = true;
    appState.scenes.activeSceneId = 'scene-1';

    const service = new ViewportRendererService();
    const rotatedSprite = new Sprite2D({
      id: 'sprite-rotated',
      name: 'Rotated',
      width: 80,
      height: 40,
    });
    rotatedSprite.position.set(70, 45, 0);
    rotatedSprite.rotation.set(0, 0, Math.PI / 4);

    Object.defineProperty(service, 'sceneManager', {
      value: {
        getSceneGraph: () => ({
          rootNodes: [rotatedSprite],
          nodeMap: new Map([[rotatedSprite.nodeId, rotatedSprite]]),
        }),
        getActiveSceneGraph: () => ({
          rootNodes: [rotatedSprite],
          nodeMap: new Map([[rotatedSprite.nodeId, rotatedSprite]]),
        }),
      },
      configurable: true,
    });
    Object.defineProperty(service, 'orthographicCamera', {
      value: new THREE.OrthographicCamera(-200, 200, 150, -150, 0.1, 1000),
      configurable: true,
    });
    Object.defineProperty(service, 'viewportSize', {
      value: { width: 400, height: 300 },
      configurable: true,
      writable: true,
    });

    (service as unknown as { proxyRegistry: { sprite2DVisuals: Map<string, THREE.Group> } }).proxyRegistry.sprite2DVisuals = new Map(
      [[rotatedSprite.nodeId, new THREE.Group()]]
    );

    const hitNodeIds = service.getSelectable2DNodeIdsInScreenRect(230, 65, 300, 140);

    expect(hitNodeIds).toEqual(['sprite-rotated']);
  });

  it('creates and clears marquee preview frames for intersecting 2D nodes', () => {
    resetAppState();
    appState.ui.showLayer2D = true;
    appState.scenes.activeSceneId = 'scene-1';

    const service = new ViewportRendererService();
    const scene = new THREE.Scene();
    const firstSprite = new Sprite2D({ id: 'sprite-preview-1', width: 80, height: 50 });
    const secondSprite = new Sprite2D({ id: 'sprite-preview-2', width: 60, height: 40 });
    secondSprite.position.set(80, 0, 0);

    const rootNodes = [firstSprite, secondSprite];
    const nodeMap = new Map(rootNodes.map(node => [node.nodeId, node]));

    Object.defineProperty(service, 'scene', {
      value: scene,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(service, 'sceneManager', {
      value: {
        getSceneGraph: () => ({ rootNodes, nodeMap }),
      },
      configurable: true,
    });

    (service as unknown as { proxyRegistry: { sprite2DVisuals: Map<string, THREE.Group> } }).proxyRegistry.sprite2DVisuals = new Map(
      rootNodes.map(node => [node.nodeId, new THREE.Group()])
    );

    expect(service.set2DMarqueePreviewNodeIds([firstSprite.nodeId, secondSprite.nodeId])).toBe(
      true
    );
    expect(
      (service as unknown as { marqueePreview2DFrames: Map<string, THREE.Group> })
        .marqueePreview2DFrames.size
    ).toBe(2);

    expect(service.set2DMarqueePreviewNodeIds([secondSprite.nodeId])).toBe(true);
    expect(
      (service as unknown as { marqueePreview2DFrames: Map<string, THREE.Group> })
        .marqueePreview2DFrames.size
    ).toBe(1);

    expect(service.clear2DMarqueePreview()).toBe(true);
    expect(
      (service as unknown as { marqueePreview2DFrames: Map<string, THREE.Group> })
        .marqueePreview2DFrames.size
    ).toBe(0);
  });

  it('keeps selected camera icons visible with reduced opacity', () => {
    resetAppState();
    appState.ui.showLayer3D = true;

    const service = new ViewportRendererService();
    const cameraNode = new Camera3D({ id: 'camera-test', name: 'Camera' });
    const icon = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, opacity: 0.95 }));

    Object.defineProperty(service, 'sceneManager', {
      value: {
        getActiveSceneGraph: () => ({
          nodeMap: new Map([[cameraNode.nodeId, cameraNode]]),
        }),
      },
      configurable: true,
    });

    const adornments = (
      service as unknown as {
        adornments: {
          nodeIcons: Map<string, THREE.Sprite>;
          updateNodeIconVisibility: () => void;
        };
      }
    ).adornments;
    adornments.nodeIcons.set(cameraNode.nodeId, icon);
    appState.selection.nodeIds = [cameraNode.nodeId];

    adornments.updateNodeIconVisibility();

    expect(icon.visible).toBe(true);
    expect((icon.material as THREE.SpriteMaterial).opacity).toBeLessThan(0.95);
  });

  it('skips selection bounds for ambient lights', () => {
    const service = new ViewportRendererService();
    const ambientLight = new AmbientLightNode({ id: 'ambient-test', name: 'Ambient' });

    const result = (
      service as unknown as {
        shouldSkipSelectionBounds: (node: AmbientLightNode) => boolean;
      }
    ).shouldSkipSelectionBounds(ambientLight);

    expect(result).toBe(true);
  });

  it('keeps fallback editor lighting enabled when the active scene has no explicit lights', () => {
    resetAppState();
    appState.ui.showLighting = true;

    const service = new ViewportRendererService();
    const renderer = { shadowMap: { enabled: false } } as THREE.WebGLRenderer;
    const editorAmbientLight = new THREE.AmbientLight();
    const editorDirectionalLight = new THREE.DirectionalLight();

    Object.defineProperty(service, 'renderer', { value: renderer, configurable: true });
    Object.defineProperty(service, 'editorAmbientLight', {
      value: editorAmbientLight,
      configurable: true,
    });
    Object.defineProperty(service, 'editorDirectionalLight', {
      value: editorDirectionalLight,
      configurable: true,
    });
    Object.defineProperty(service, 'sceneManager', {
      value: {
        getActiveSceneGraph: () => ({ rootNodes: [new Group2D({ id: 'group', name: 'Group' })] }),
      },
      configurable: true,
    });

    (service as unknown as { syncLighting: () => void }).syncLighting();

    expect(renderer.shadowMap.enabled).toBe(true);
    expect(editorAmbientLight.visible).toBe(true);
    expect(editorDirectionalLight.visible).toBe(true);
  });

  it('only requires full scene sync when the active scene id changes', () => {
    const service = new ViewportRendererService();

    const shouldSyncSceneContent = (
      service as unknown as {
        shouldSyncSceneContent: (sceneId: string | null) => boolean;
      }
    ).shouldSyncSceneContent.bind(service);

    expect(shouldSyncSceneContent('scene-1')).toBe(true);
    expect(shouldSyncSceneContent('scene-1')).toBe(false);
    expect(shouldSyncSceneContent('scene-2')).toBe(true);
    expect(shouldSyncSceneContent('scene-2')).toBe(false);
  });

  it('tracks node data updates without requiring a full scene rebuild', () => {
    const service = new ViewportRendererService();

    const shouldRefreshSceneNodeData = (
      service as unknown as {
        shouldRefreshSceneNodeData: (nodeDataChangeSignal: number) => boolean;
      }
    ).shouldRefreshSceneNodeData.bind(service);

    expect(shouldRefreshSceneNodeData(0)).toBe(false);
    expect(shouldRefreshSceneNodeData(1)).toBe(true);
    expect(shouldRefreshSceneNodeData(1)).toBe(false);
    expect(shouldRefreshSceneNodeData(2)).toBe(true);
  });

  it('renders 2D overlay HUD badges for a single selected node', () => {
    const service = new ViewportRendererService();
    const sprite = new Sprite2D({
      id: 'sprite-hud-test',
      name: 'Player',
      width: 100,
      height: 50,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);

    Object.defineProperty(service, 'canvasHost', {
      value: host,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(service, 'iconService', {
      value: { getIconSvg: vi.fn(() => '<svg viewBox="0 0 12 12"></svg>') },
      configurable: true,
    });
    Object.defineProperty(service, 'sceneManager', {
      value: {
        getSceneGraph: () => ({
          nodeMap: new Map([[sprite.nodeId, sprite]]),
        }),
      },
      configurable: true,
    });
    Object.defineProperty(service, 'orthographicCamera', {
      value: new THREE.OrthographicCamera(-200, 200, 150, -150, 0.1, 1000),
      configurable: true,
    });
    Object.defineProperty(service, 'viewportSize', {
      value: { width: 400, height: 300 },
      configurable: true,
      writable: true,
    });
    const rotationHandle = new THREE.Group();
    rotationHandle.position.set(0, 60, 0);
    Object.defineProperty(service, 'selection2DOverlay', {
      value: {
        group: new THREE.Group(),
        handles: [],
        frame: new THREE.Group(),
        nodeIds: [sprite.nodeId],
        combinedBounds: new THREE.Box3(
          new THREE.Vector3(-50, -25, 0),
          new THREE.Vector3(129.4, 154.3, 0)
        ),
        centerWorld: new THREE.Vector3(0, 0, 0),
        localBounds: new THREE.Box3(new THREE.Vector3(-50, -25, 0), new THREE.Vector3(50, 25, 0)),
        worldRotationZ: 0,
        rotationHandle,
      },
      configurable: true,
      writable: true,
    });
    appState.scenes.activeSceneId = 'scene-1';

    (service as unknown as { selection2DHud: { update: () => void } }).selection2DHud.update();

    const hud = (
      service as unknown as {
        selection2DHud: { badges?: { top: HTMLDivElement; bottom: HTMLDivElement } };
      }
    ).selection2DHud.badges;

    expect(hud?.top.textContent).toContain('Player');
    expect(hud?.top.title).toBe('Player · Sprite2D');
    expect(hud?.bottom.textContent).toBe('100 x 50');
    expect(hud?.top.style.display).toBe('inline-flex');
    expect(hud?.bottom.style.display).toBe('inline-flex');
    expect(Number.parseFloat(hud?.top.style.top ?? '0')).toBeLessThan(90);
    expect(hud?.top.style.transform).toContain('rotate(0deg)');
    expect(hud?.bottom.style.transform).toContain('rotate(0deg)');
  });

  it('moves the size badge farther when the rotation handle is visually below the selection', () => {
    const service = new ViewportRendererService();
    const sprite = new Sprite2D({
      id: 'sprite-hud-bottom-clearance',
      name: 'Player',
      width: 100,
      height: 50,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);

    Object.defineProperty(service, 'canvasHost', {
      value: host,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(service, 'iconService', {
      value: { getIconSvg: vi.fn(() => '<svg viewBox="0 0 12 12"></svg>') },
      configurable: true,
    });
    Object.defineProperty(service, 'sceneManager', {
      value: {
        getSceneGraph: () => ({
          nodeMap: new Map([[sprite.nodeId, sprite]]),
        }),
      },
      configurable: true,
    });
    Object.defineProperty(service, 'orthographicCamera', {
      value: new THREE.OrthographicCamera(-200, 200, 150, -150, 0.1, 1000),
      configurable: true,
    });
    Object.defineProperty(service, 'viewportSize', {
      value: { width: 400, height: 300 },
      configurable: true,
      writable: true,
    });
    const rotationHandle = new THREE.Group();
    rotationHandle.position.set(0, -60, 0);
    Object.defineProperty(service, 'selection2DOverlay', {
      value: {
        group: new THREE.Group(),
        handles: [],
        frame: new THREE.Group(),
        nodeIds: [sprite.nodeId],
        combinedBounds: new THREE.Box3(
          new THREE.Vector3(-50, -25, 0),
          new THREE.Vector3(50, 25, 0)
        ),
        centerWorld: new THREE.Vector3(0, 0, 0),
        localBounds: new THREE.Box3(new THREE.Vector3(-50, -25, 0), new THREE.Vector3(50, 25, 0)),
        worldRotationZ: 0,
        rotationHandle,
      },
      configurable: true,
      writable: true,
    });
    appState.scenes.activeSceneId = 'scene-1';

    (service as unknown as { selection2DHud: { update: () => void } }).selection2DHud.update();

    const hud = (
      service as unknown as {
        selection2DHud: { badges?: { top: HTMLDivElement; bottom: HTMLDivElement } };
      }
    ).selection2DHud.badges;

    expect(Number.parseFloat(hud?.bottom.style.top ?? '0')).toBeGreaterThan(215);
  });

  it('rotates and reanchors 2D overlay HUD badges to the current overlay angle', () => {
    const service = new ViewportRendererService();
    const sprite = new Sprite2D({
      id: 'sprite-hud-rotated',
      name: 'Player',
      width: 100,
      height: 50,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);

    Object.defineProperty(service, 'canvasHost', {
      value: host,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(service, 'iconService', {
      value: { getIconSvg: vi.fn(() => '<svg viewBox="0 0 12 12"></svg>') },
      configurable: true,
    });
    Object.defineProperty(service, 'sceneManager', {
      value: {
        getSceneGraph: () => ({
          nodeMap: new Map([[sprite.nodeId, sprite]]),
        }),
      },
      configurable: true,
    });
    Object.defineProperty(service, 'orthographicCamera', {
      value: new THREE.OrthographicCamera(-200, 200, 150, -150, 0.1, 1000),
      configurable: true,
    });
    Object.defineProperty(service, 'viewportSize', {
      value: { width: 400, height: 300 },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(service, 'selection2DOverlay', {
      value: {
        group: new THREE.Group(),
        handles: [],
        frame: new THREE.Group(),
        nodeIds: [sprite.nodeId],
        combinedBounds: new THREE.Box3(
          new THREE.Vector3(-25, -50, 0),
          new THREE.Vector3(25, 50, 0)
        ),
        centerWorld: new THREE.Vector3(0, 0, 0),
        localBounds: new THREE.Box3(new THREE.Vector3(-50, -25, 0), new THREE.Vector3(50, 25, 0)),
        worldRotationZ: Math.PI / 2,
      },
      configurable: true,
      writable: true,
    });
    appState.scenes.activeSceneId = 'scene-1';

    (service as unknown as { selection2DHud: { update: () => void } }).selection2DHud.update();

    const hud = (
      service as unknown as {
        selection2DHud: { badges?: { top: HTMLDivElement; bottom: HTMLDivElement } };
      }
    ).selection2DHud.badges;

    expect(Number.parseFloat(hud?.top.style.left ?? '0')).toBeCloseTo(200, 0);
    expect(Number.parseFloat(hud?.bottom.style.left ?? '0')).toBeCloseTo(200, 0);
    expect(Number.parseFloat(hud?.top.style.top ?? '0')).toBeLessThan(120);
    expect(Number.parseFloat(hud?.bottom.style.top ?? '0')).toBeGreaterThan(180);
    expect(hud?.top.style.transform).toContain('rotate(0deg)');
    expect(hud?.bottom.style.transform).toContain('rotate(0deg)');
  });

  it('keeps HUD badges readable and swaps them to the visual top and bottom edges', () => {
    const service = new ViewportRendererService();
    const sprite = new Sprite2D({
      id: 'sprite-hud-readable',
      name: 'Player',
      width: 100,
      height: 50,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);

    Object.defineProperty(service, 'canvasHost', {
      value: host,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(service, 'iconService', {
      value: { getIconSvg: vi.fn(() => '<svg viewBox="0 0 12 12"></svg>') },
      configurable: true,
    });
    Object.defineProperty(service, 'sceneManager', {
      value: {
        getSceneGraph: () => ({
          nodeMap: new Map([[sprite.nodeId, sprite]]),
        }),
      },
      configurable: true,
    });
    Object.defineProperty(service, 'orthographicCamera', {
      value: new THREE.OrthographicCamera(-200, 200, 150, -150, 0.1, 1000),
      configurable: true,
    });
    Object.defineProperty(service, 'viewportSize', {
      value: { width: 400, height: 300 },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(service, 'selection2DOverlay', {
      value: {
        group: new THREE.Group(),
        handles: [],
        frame: new THREE.Group(),
        nodeIds: [sprite.nodeId],
        combinedBounds: new THREE.Box3(
          new THREE.Vector3(-53.1, -53.1, 0),
          new THREE.Vector3(53.1, 53.1, 0)
        ),
        centerWorld: new THREE.Vector3(0, 0, 0),
        localBounds: new THREE.Box3(new THREE.Vector3(-50, -25, 0), new THREE.Vector3(50, 25, 0)),
        worldRotationZ: (3 * Math.PI) / 4,
      },
      configurable: true,
      writable: true,
    });
    appState.scenes.activeSceneId = 'scene-1';

    (service as unknown as { selection2DHud: { update: () => void } }).selection2DHud.update();

    const hud = (
      service as unknown as {
        selection2DHud: { badges?: { top: HTMLDivElement; bottom: HTMLDivElement } };
      }
    ).selection2DHud.badges;

    expect(Number.parseFloat(hud?.top.style.left ?? '0')).toBeLessThan(190);
    expect(Number.parseFloat(hud?.bottom.style.left ?? '0')).toBeGreaterThan(210);
    expect(Number.parseFloat(hud?.top.style.top ?? '0')).toBeLessThan(130);
    expect(Number.parseFloat(hud?.bottom.style.top ?? '0')).toBeGreaterThan(170);
    expect(hud?.top.style.transform).toContain('rotate(-45deg)');
    expect(hud?.bottom.style.transform).toContain('rotate(-45deg)');
  });

  const setupSelection2DOverlayHud = (
    overrides: { active2DTransform?: unknown; rotationRadians?: number } = {}
  ): { top: HTMLDivElement; bottom: HTMLDivElement } | undefined => {
    const service = new ViewportRendererService();
    const sprite = new Sprite2D({
      id: 'sprite-hud-transform',
      name: 'Player',
      width: 100,
      height: 50,
    });
    if (typeof overrides.rotationRadians === 'number') {
      sprite.rotation.z = overrides.rotationRadians;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);

    Object.defineProperty(service, 'canvasHost', {
      value: host,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(service, 'iconService', {
      value: { getIconSvg: vi.fn(() => '<svg viewBox="0 0 12 12"></svg>') },
      configurable: true,
    });
    Object.defineProperty(service, 'sceneManager', {
      value: {
        getSceneGraph: () => ({
          nodeMap: new Map([[sprite.nodeId, sprite]]),
        }),
      },
      configurable: true,
    });
    Object.defineProperty(service, 'orthographicCamera', {
      value: new THREE.OrthographicCamera(-200, 200, 150, -150, 0.1, 1000),
      configurable: true,
    });
    Object.defineProperty(service, 'viewportSize', {
      value: { width: 400, height: 300 },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(service, 'selection2DOverlay', {
      value: {
        group: new THREE.Group(),
        handles: [],
        frame: new THREE.Group(),
        nodeIds: [sprite.nodeId],
        combinedBounds: new THREE.Box3(
          new THREE.Vector3(-50, -25, 0),
          new THREE.Vector3(50, 25, 0)
        ),
        centerWorld: new THREE.Vector3(0, 0, 0),
        localBounds: new THREE.Box3(new THREE.Vector3(-50, -25, 0), new THREE.Vector3(50, 25, 0)),
        worldRotationZ: overrides.rotationRadians ?? 0,
      },
      configurable: true,
      writable: true,
    });
    (
      service as unknown as { transformSession: { active2DTransform: unknown } }
    ).transformSession.active2DTransform = overrides.active2DTransform;
    appState.scenes.activeSceneId = 'scene-1';

    (service as unknown as { selection2DHud: { update: () => void } }).selection2DHud.update();

    return (
      service as unknown as {
        selection2DHud: { badges?: { top: HTMLDivElement; bottom: HTMLDivElement } };
      }
    ).selection2DHud.badges;
  };

  it('hides 2D overlay HUD badges while moving a 2D node', () => {
    const hud = setupSelection2DOverlayHud({ active2DTransform: { handle: 'move' } });

    expect(hud?.top.style.display).toBe('none');
    expect(hud?.bottom.style.display).toBe('none');
  });

  it('keeps the live size badge visible while resizing a 2D node', () => {
    const hud = setupSelection2DOverlayHud({ active2DTransform: { handle: 'scale-e' } });

    expect(hud?.bottom.style.display).toBe('inline-flex');
    expect(hud?.bottom.textContent).toBe('100 x 50');
  });

  it('shows a live angle badge in place of the size badge while rotating a 2D node', () => {
    const hud = setupSelection2DOverlayHud({
      active2DTransform: { handle: 'rotate' },
      rotationRadians: Math.PI / 4,
    });

    expect(hud?.bottom.style.display).toBe('inline-flex');
    expect(hud?.bottom.textContent).toBe('45°');
    // The size readout is replaced by the angle while the identity stays on top.
    expect(hud?.bottom.textContent).not.toContain('x');
    expect(hud?.top.textContent).toContain('Player');
  });

  it('repositions the 2D overlay HUD badges when the camera pans (no content rebuild)', () => {
    const service = new ViewportRendererService();
    const sprite = new Sprite2D({
      id: 'sprite-hud-pan',
      name: 'Player',
      width: 100,
      height: 50,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);

    Object.defineProperty(service, 'canvasHost', {
      value: host,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(service, 'iconService', {
      value: { getIconSvg: vi.fn(() => '<svg viewBox="0 0 12 12"></svg>') },
      configurable: true,
    });
    Object.defineProperty(service, 'sceneManager', {
      value: {
        getSceneGraph: () => ({
          nodeMap: new Map([[sprite.nodeId, sprite]]),
        }),
      },
      configurable: true,
    });
    const camera = new THREE.OrthographicCamera(-200, 200, 150, -150, 0.1, 1000);
    Object.defineProperty(service, 'orthographicCamera', { value: camera, configurable: true });
    Object.defineProperty(service, 'viewportSize', {
      value: { width: 400, height: 300 },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(service, 'selection2DOverlay', {
      value: {
        group: new THREE.Group(),
        handles: [],
        frame: new THREE.Group(),
        nodeIds: [sprite.nodeId],
        combinedBounds: new THREE.Box3(
          new THREE.Vector3(-50, -25, 0),
          new THREE.Vector3(50, 25, 0)
        ),
        centerWorld: new THREE.Vector3(0, 0, 0),
        localBounds: new THREE.Box3(new THREE.Vector3(-50, -25, 0), new THREE.Vector3(50, 25, 0)),
        worldRotationZ: 0,
      },
      configurable: true,
      writable: true,
    });
    appState.scenes.activeSceneId = 'scene-1';

    const api = service as unknown as {
      selection2DHud: {
        update: () => void;
        reposition: () => void;
        badges?: { top: HTMLDivElement; bottom: HTMLDivElement };
      };
    };

    api.selection2DHud.update();
    const hud = api.selection2DHud.badges;
    const topLeftBefore = Number.parseFloat(hud?.top.style.left ?? '0');
    const bottomLeftBefore = Number.parseFloat(hud?.bottom.style.left ?? '0');
    const labelBefore = hud?.top.textContent;

    // At 1 world unit per screen pixel the object center sits at the screen center.
    expect(topLeftBefore).toBeCloseTo(200, 0);
    expect(bottomLeftBefore).toBeCloseTo(200, 0);

    // Pan the camera right by 100 world units: the object shifts 100px left on
    // screen, and the reposition pass must carry the badges along with it.
    camera.position.x += 100;
    camera.updateMatrixWorld(true);
    api.selection2DHud.reposition();

    expect(Number.parseFloat(hud?.top.style.left ?? '0')).toBeCloseTo(topLeftBefore - 100, 0);
    expect(Number.parseFloat(hud?.bottom.style.left ?? '0')).toBeCloseTo(bottomLeftBefore - 100, 0);
    // Repositioning must not rebuild badge content or toggle visibility.
    expect(hud?.top.textContent).toBe(labelBefore);
    expect(hud?.top.style.display).toBe('inline-flex');
    expect(hud?.bottom.style.display).toBe('inline-flex');
  });

  it('refreshes existing node visuals when node data changes', () => {
    const service = new ViewportRendererService();
    const sprite = new Sprite2D({ id: 'sprite-refresh-test', width: 64, height: 64 });

    Object.defineProperty(service, 'sceneManager', {
      value: {
        getActiveSceneGraph: () => ({ rootNodes: [sprite] }),
      },
      configurable: true,
    });

    const updateNodeTransform = vi.spyOn(service, 'updateNodeTransform');
    const adornments = (
      service as unknown as {
        adornments: {
          updateNodeIconPositions: () => void;
          updateNodeIconVisibility: () => void;
        };
      }
    ).adornments;
    const updateNodeIconPositions = vi.spyOn(adornments, 'updateNodeIconPositions');
    const updateNodeIconVisibility = vi.spyOn(adornments, 'updateNodeIconVisibility');

    (
      service as unknown as {
        refreshSceneNodeData: () => void;
      }
    ).refreshSceneNodeData();

    expect(updateNodeTransform).toHaveBeenCalledWith(sprite);
    expect(updateNodeIconPositions).toHaveBeenCalledOnce();
    expect(updateNodeIconVisibility).toHaveBeenCalledOnce();
  });

  it('disables fallback editor lighting when the active scene contains explicit lights', () => {
    resetAppState();
    appState.ui.showLighting = true;

    const service = new ViewportRendererService();
    const renderer = { shadowMap: { enabled: false } } as THREE.WebGLRenderer;
    const editorAmbientLight = new THREE.AmbientLight();
    const editorDirectionalLight = new THREE.DirectionalLight();
    const lightNode = new DirectionalLightNode({ id: 'dir-light', name: 'Sun' });

    Object.defineProperty(service, 'renderer', { value: renderer, configurable: true });
    Object.defineProperty(service, 'editorAmbientLight', {
      value: editorAmbientLight,
      configurable: true,
    });
    Object.defineProperty(service, 'editorDirectionalLight', {
      value: editorDirectionalLight,
      configurable: true,
    });
    Object.defineProperty(service, 'sceneManager', {
      value: {
        getActiveSceneGraph: () => ({ rootNodes: [lightNode] }),
      },
      configurable: true,
    });

    (service as unknown as { syncLighting: () => void }).syncLighting();

    expect(renderer.shadowMap.enabled).toBe(true);
    expect(editorAmbientLight.visible).toBe(false);
    expect(editorDirectionalLight.visible).toBe(false);
  });

  it('detects explicit lights in nested scene nodes', () => {
    const service = new ViewportRendererService();
    const nestedLight = new DirectionalLightNode({ id: 'nested-light', name: 'Nested Light' });
    const root = new Group2D({ id: 'root-group', name: 'Root Group' });

    root.adoptChild(nestedLight);

    const result = (
      service as unknown as {
        containsExplicitLights: (
          nodes: readonly AmbientLightNode[] | readonly Group2D[]
        ) => boolean;
      }
    ).containsExplicitLights([root]);

    expect(result).toBe(true);
  });

  it('resets the 2D camera without touching 3D orbit controls', () => {
    resetAppState();
    appState.ui.navigationMode = '2d';

    const service = new ViewportRendererService();
    const perspectiveCamera = new THREE.PerspectiveCamera();
    perspectiveCamera.position.set(11, 12, 13);
    const orthographicCamera = new THREE.OrthographicCamera(-960, 960, 540, -540, 0.1, 1000);
    orthographicCamera.position.set(25, -40, 100);
    orthographicCamera.zoom = 2.5;
    const orbitControls = { reset: vi.fn(), target: new THREE.Vector3(), update: vi.fn() };
    const orthographicControls = {
      target: new THREE.Vector3(10, -10, 0),
      update: vi.fn(),
    };

    Object.defineProperty(service, 'camera', { value: perspectiveCamera, configurable: true });
    Object.defineProperty(service, 'orthographicCamera', {
      value: orthographicCamera,
      configurable: true,
    });
    Object.defineProperty(service, 'orbitControls', { value: orbitControls, configurable: true });
    Object.defineProperty(service, 'orthographicControls', {
      value: orthographicControls,
      configurable: true,
    });
    Object.defineProperty(service, 'requestRender', { value: vi.fn(), configurable: true });

    service.zoomDefault();

    expect(orbitControls.reset).not.toHaveBeenCalled();
    expect(orthographicCamera.position.x).toBe(0);
    expect(orthographicCamera.position.y).toBe(0);
    expect(orthographicCamera.zoom).toBeCloseTo(expectedDefault2DZoom);
    expect(orthographicControls.target.x).toBe(0);
    expect(orthographicControls.target.y).toBe(0);
    expect(perspectiveCamera.position.x).toBe(11);
  });

  it('falls back to 2D reset when zoom-all has no 2D content', () => {
    resetAppState();
    appState.ui.navigationMode = '2d';

    const service = new ViewportRendererService();
    const orthographicCamera = new THREE.OrthographicCamera(-960, 960, 540, -540, 0.1, 1000);
    orthographicCamera.position.set(20, 30, 100);
    orthographicCamera.zoom = 2;
    const orbitControls = { reset: vi.fn(), target: new THREE.Vector3(), update: vi.fn() };
    const orthographicControls = {
      target: new THREE.Vector3(10, 12, 0),
      update: vi.fn(),
    };

    Object.defineProperty(service, 'orthographicCamera', {
      value: orthographicCamera,
      configurable: true,
    });
    Object.defineProperty(service, 'orthographicControls', {
      value: orthographicControls,
      configurable: true,
    });
    Object.defineProperty(service, 'orbitControls', { value: orbitControls, configurable: true });
    Object.defineProperty(service, 'sceneManager', {
      value: {
        getActiveSceneGraph: () => ({
          rootNodes: [new Group2D({ id: 'empty-group', name: 'Group', width: 0, height: 0 })],
        }),
      },
      configurable: true,
    });
    Object.defineProperty(service, 'requestRender', { value: vi.fn(), configurable: true });

    service.zoomAll();

    expect(orbitControls.reset).not.toHaveBeenCalled();
    expect(orthographicCamera.position.x).toBe(0);
    expect(orthographicCamera.position.y).toBe(0);
    expect(orthographicCamera.zoom).toBeCloseTo(expectedDefault2DZoom);
  });

  it('restores the padded default 2D view when entering 2D without saved camera state', () => {
    resetAppState();
    appState.scenes.activeSceneId = 'scene-2d';

    const service = new ViewportRendererService();
    const orthographicCamera = new THREE.OrthographicCamera(-960, 960, 540, -540, 0.1, 1000);
    orthographicCamera.position.set(40, -25, 100);
    orthographicCamera.zoom = 2;
    const orthographicControls = {
      enabled: true,
      enableZoom: true,
      enablePan: true,
      target: new THREE.Vector3(15, -10, 0),
      update: vi.fn(),
    };
    const requestRender = vi.fn();

    Object.defineProperty(service, 'orthographicCamera', {
      value: orthographicCamera,
      configurable: true,
    });
    Object.defineProperty(service, 'orthographicControls', {
      value: orthographicControls,
      configurable: true,
    });
    Object.defineProperty(service, 'requestRender', { value: requestRender, configurable: true });

    appState.ui.navigationMode = '2d';

    (
      service as unknown as {
        syncNavigationMode: () => void;
      }
    ).syncNavigationMode();

    expect(orthographicCamera.position.x).toBe(0);
    expect(orthographicCamera.position.y).toBe(0);
    expect(orthographicCamera.zoom).toBeCloseTo(expectedDefault2DZoom);
    expect(orthographicControls.target.x).toBe(0);
    expect(orthographicControls.target.y).toBe(0);
    expect(orthographicControls.enableZoom).toBe(false);
    expect(orthographicControls.enablePan).toBe(false);
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it('resets orbit state around 2D interactions so 3D orbit recovers after dragging 2D nodes', () => {
    resetAppState();
    appState.ui.navigationMode = '3d';

    const service = new ViewportRendererService();
    const orbitControls: {
      enabled: boolean;
      state: number;
      _pointers: Array<{ pointerId: number }>;
      _pointerPositions: Record<number, THREE.Vector2>;
    } = {
      enabled: true,
      state: 0,
      _pointers: [{ pointerId: 1 }],
      _pointerPositions: { 1: new THREE.Vector2(10, 20) },
    };
    const orthographicControls = {
      enabled: true,
      enableZoom: true,
      enablePan: true,
      target: new THREE.Vector3(),
      update: vi.fn(),
    };

    Object.defineProperty(service, 'orbitControls', {
      value: orbitControls,
      configurable: true,
    });
    Object.defineProperty(service, 'orthographicControls', {
      value: orthographicControls,
      configurable: true,
    });

    (
      service as unknown as {
        begin2DInteraction: () => void;
        end2DInteraction: () => void;
      }
    ).begin2DInteraction();

    expect(orbitControls.enabled).toBe(false);
    expect(orbitControls.state).toBe(-1);
    expect(orbitControls._pointers).toHaveLength(0);
    expect(Object.keys(orbitControls._pointerPositions)).toHaveLength(0);

    orbitControls.state = 2;
    orbitControls._pointers.push({ pointerId: 2 });
    orbitControls._pointerPositions = { 2: new THREE.Vector2(30, 40) };

    (
      service as unknown as {
        end2DInteraction: () => void;
      }
    ).end2DInteraction();

    expect(orbitControls.enabled).toBe(true);
    expect(orbitControls.state).toBe(-1);
    expect(orbitControls._pointers).toHaveLength(0);
    expect(Object.keys(orbitControls._pointerPositions)).toHaveLength(0);
  });

  it('applies the padded 2D default on first resize even before entering 2D navigation', () => {
    resetAppState();
    appState.ui.navigationMode = '3d';
    appState.scenes.activeSceneId = 'scene-open';

    const service = new ViewportRendererService();
    const perspectiveCamera = new THREE.PerspectiveCamera();
    const orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    orthographicCamera.position.set(60, -35, 100);
    const orthographicControls = {
      target: new THREE.Vector3(15, -10, 0),
      update: vi.fn(),
    };

    Object.defineProperty(service, 'renderer', {
      value: { setSize: vi.fn() },
      configurable: true,
    });
    Object.defineProperty(service, 'camera', { value: perspectiveCamera, configurable: true });
    Object.defineProperty(service, 'perspectiveCamera', {
      value: perspectiveCamera,
      configurable: true,
    });
    Object.defineProperty(service, 'orthographicCamera', {
      value: orthographicCamera,
      configurable: true,
    });
    Object.defineProperty(service, 'orthographicControls', {
      value: orthographicControls,
      configurable: true,
    });
    Object.defineProperty(service, 'sceneManager', {
      value: { resizeRoot: vi.fn() },
      configurable: true,
    });
    Object.defineProperty(service, 'syncAll2DVisuals', { value: vi.fn(), configurable: true });
    Object.defineProperty(service, 'syncBaseViewportFrame', { value: vi.fn(), configurable: true });
    Object.defineProperty(service, 'requestRender', { value: vi.fn(), configurable: true });

    service.resize(1280, 720);

    expect(orthographicCamera.position.x).toBe(0);
    expect(orthographicCamera.position.y).toBe(0);
    expect(orthographicCamera.zoom).toBeCloseTo(expectedDefault2DZoom);
    expect(orthographicControls.target.x).toBe(0);
    expect(orthographicControls.target.y).toBe(0);
    expect(appState.scenes.navigation2DCameraStates['scene-open']?.zoom).toBeCloseTo(
      expectedDefault2DZoom
    );
  });

  it('maps drag pan deltas to exact 2D world offsets', () => {
    resetAppState();
    appState.ui.navigationMode = '2d';

    const service = new ViewportRendererService();
    const orthographicCamera = new THREE.OrthographicCamera(-1000, 1000, 500, -500, 0.1, 1000);
    orthographicCamera.position.set(10, 20, 100);
    orthographicCamera.zoom = 2;
    const orthographicControls = {
      target: new THREE.Vector3(3, 4, 0),
    };

    Object.defineProperty(service, 'orthographicCamera', {
      value: orthographicCamera,
      configurable: true,
    });
    Object.defineProperty(service, 'orthographicControls', {
      value: orthographicControls,
      configurable: true,
    });
    Object.defineProperty(service, 'viewportSize', {
      value: { width: 500, height: 250 },
      configurable: true,
    });

    service.pan2DByDrag(40, 30);

    expect(orthographicCamera.position.x).toBeCloseTo(90);
    expect(orthographicCamera.position.y).toBeCloseTo(-40);
    expect(orthographicControls.target.x).toBeCloseTo(83);
    expect(orthographicControls.target.y).toBeCloseTo(-56);
  });

  it('persists and restores the full 2D camera state after direct zoom changes', () => {
    resetAppState();
    appState.ui.navigationMode = '2d';
    appState.scenes.activeSceneId = 'scene-2d';

    const service = new ViewportRendererService();
    const orthographicCamera = new THREE.OrthographicCamera(-960, 960, 540, -540, 0.1, 1000);
    orthographicCamera.position.set(140, -80, 100);
    orthographicCamera.zoom = 1.75;
    const orthographicControls = {
      target: new THREE.Vector3(140, -80, 0),
    };

    Object.defineProperty(service, 'orthographicCamera', {
      value: orthographicCamera,
      configurable: true,
    });
    Object.defineProperty(service, 'orthographicControls', {
      value: orthographicControls,
      configurable: true,
    });
    Object.defineProperty(service, 'viewportSize', {
      value: { width: 1280, height: 720 },
      configurable: true,
    });

    service.zoom2D(1.2);

    const savedState = appState.scenes.navigation2DCameraStates['scene-2d'];
    expect(savedState?.zoom).toBeCloseTo(2.1);
    expect(savedState?.position.x).toBeCloseTo(140);
    expect(savedState?.position.y).toBeCloseTo(-80);

    orthographicCamera.position.set(-25, 60, 100);
    orthographicControls.target.set(-25, 60, 0);
    orthographicCamera.zoom = 1;

    service.restoreZoomFromState();

    expect(orthographicCamera.position.x).toBeCloseTo(140);
    expect(orthographicCamera.position.y).toBeCloseTo(-80);
    expect(orthographicControls.target.x).toBeCloseTo(140);
    expect(orthographicControls.target.y).toBeCloseTo(-80);
    expect(orthographicCamera.zoom).toBeCloseTo(2.1);
  });

  it('ignores saved editor camera state when entering 2d navigation', () => {
    resetAppState();
    appState.scenes.activeSceneId = 'scene-2d';
    appState.scenes.editorCameraStates['scene-2d'] = {
      position: { x: 55, y: -35, z: 240 },
      target: { x: 12, y: -9, z: 18 },
      zoom: 0.4,
    };

    const service = new ViewportRendererService();
    const orthographicCamera = new THREE.OrthographicCamera(-960, 960, 540, -540, 0.1, 1000);
    orthographicCamera.position.set(40, -25, 100);
    orthographicCamera.zoom = 2;
    const orthographicControls = {
      enabled: true,
      enableZoom: true,
      enablePan: true,
      target: new THREE.Vector3(15, -10, 0),
      update: vi.fn(),
    };

    Object.defineProperty(service, 'orthographicCamera', {
      value: orthographicCamera,
      configurable: true,
    });
    Object.defineProperty(service, 'orthographicControls', {
      value: orthographicControls,
      configurable: true,
    });
    Object.defineProperty(service, 'requestRender', { value: vi.fn(), configurable: true });

    appState.ui.navigationMode = '2d';

    (
      service as unknown as {
        syncNavigationMode: () => void;
      }
    ).syncNavigationMode();

    expect(orthographicCamera.position.x).toBe(0);
    expect(orthographicCamera.position.y).toBe(0);
    expect(orthographicCamera.zoom).toBeCloseTo(expectedDefault2DZoom);
    expect(orthographicControls.target.x).toBe(0);
    expect(orthographicControls.target.y).toBe(0);
    expect(appState.scenes.navigation2DCameraStates['scene-2d']?.zoom).toBeCloseTo(
      expectedDefault2DZoom
    );
  });

  it('ticks previewable components in editor mode', () => {
    resetAppState();
    appState.ui.isPlaying = false;

    class PreviewScript extends Script {
      readonly tickSpy = vi.fn();

      override tickEditorPreview(dt: number): void {
        this.tickSpy(dt);
      }
    }

    const service = new ViewportRendererService();
    const node = new Node3D({ id: 'preview-root', name: 'Preview Root' });
    const component = new PreviewScript('preview-script', 'user:PreviewScript');
    const assetLoader = { loadInstancingModel: vi.fn() };

    node.addComponent(component);

    Object.defineProperty(service, 'sceneManager', {
      value: {
        getActiveSceneGraph: () => ({ rootNodes: [node] }),
      },
      configurable: true,
    });
    Object.defineProperty(service, 'assetLoader', {
      value: assetLoader,
      configurable: true,
    });

    (
      service as unknown as {
        previewTicker: { tickComponents: (dt: number) => void };
      }
    ).previewTicker.tickComponents(0.25);

    expect(component.tickSpy).toHaveBeenCalledTimes(1);
    expect(component.tickSpy).toHaveBeenCalledWith(0.25);
  });

  it('skips previewable components while play mode is active', () => {
    resetAppState();
    appState.ui.isPlaying = true;

    class PreviewScript extends Script {
      readonly tickSpy = vi.fn();

      override tickEditorPreview(dt: number): void {
        this.tickSpy(dt);
      }
    }

    const service = new ViewportRendererService();
    const node = new Node3D({ id: 'preview-root-play', name: 'Preview Root Play' });
    const component = new PreviewScript('preview-script-play', 'user:PreviewScript');

    node.addComponent(component);

    Object.defineProperty(service, 'sceneManager', {
      value: {
        getActiveSceneGraph: () => ({ rootNodes: [node] }),
      },
      configurable: true,
    });
    Object.defineProperty(service, 'assetLoader', {
      value: { loadInstancingModel: vi.fn() },
      configurable: true,
    });

    (
      service as unknown as {
        previewTicker: { tickComponents: (dt: number) => void };
      }
    ).previewTicker.tickComponents(0.25);

    expect(component.tickSpy).not.toHaveBeenCalled();
  });
});
