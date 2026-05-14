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
      createSprite2DVisual?: (s: Sprite2D) => THREE.Group;
    };

    const sprite = new Sprite2D({
      id: 'sprite-anchor-test',
      width: 100,
      height: 50,
      anchor: { x: 0, y: 1 },
    });

    const visualRoot = svc.createSprite2DVisual?.(sprite);
    expect(visualRoot).toBeDefined();

    const mesh = visualRoot?.userData.spriteMesh as THREE.Mesh;
    expect(mesh.position.x).toBe(0.5);
    expect(mesh.position.y).toBe(-0.5);
  });

  it('should create an editor anchor marker for Sprite2D visuals', () => {
    const service = new ViewportRendererService();

    const svc = service as unknown as {
      createSprite2DVisual?: (s: Sprite2D) => THREE.Group;
    };

    const sprite = new Sprite2D({
      id: 'sprite-anchor-marker-test',
      width: 120,
      height: 80,
      anchor: { x: 0.25, y: 0.75 },
    });

    const visualRoot = svc.createSprite2DVisual?.(sprite);
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
      createAnimatedSprite2DVisual?: (s: AnimatedSprite2D) => THREE.Group;
      getNodeOnlyBounds?: (s: AnimatedSprite2D) => THREE.Box3;
    };

    const sprite = new AnimatedSprite2D({
      id: 'animated-sprite-test',
      width: 120,
      height: 80,
      color: '#ffffff',
    });

    const visualRoot = svc.createAnimatedSprite2DVisual?.(sprite);
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
      createSprite2DVisual?: (s: Sprite2D) => unknown;
    };
    svc.scene = { add: vi.fn() };

    // Create a sprite with templ scheme
    const sprite = new Sprite2D({ id: 'test-sprite', texturePath: 'templ://pix3-logo.png' });

    // Call private method reflectively
    const mesh = svc.createSprite2DVisual?.(sprite);

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
      createSprite2DVisual?: (s: Sprite2D) => unknown;
    };
    svc.scene = { add: vi.fn() };

    const sprite = new Sprite2D({ id: 'test-sprite-2', texturePath: 'templ://pix3-logo.png' });
    svc.createSprite2DVisual?.(sprite);

    // Wait a tick to run async failure handler
    await Promise.resolve();

    // Ensure direct loader wasn't invoked for templ:// fallback
    expect(loadSpy).not.toHaveBeenCalled();
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

    (service as unknown as { nodeIcons: Map<string, THREE.Sprite> }).nodeIcons.set(
      cameraNode.nodeId,
      icon
    );
    appState.selection.nodeIds = [cameraNode.nodeId];

    (
      service as unknown as {
        updateNodeIconVisibility: () => void;
      }
    ).updateNodeIconVisibility();

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
        rotationHandle,
      },
      configurable: true,
      writable: true,
    });
    appState.scenes.activeSceneId = 'scene-1';

    (
      service as unknown as {
        updateSelection2DOverlayHud: () => void;
        selection2DOverlayHud?: { top: HTMLDivElement; bottom: HTMLDivElement };
      }
    ).updateSelection2DOverlayHud();

    const hud = (
      service as unknown as {
        selection2DOverlayHud?: { top: HTMLDivElement; bottom: HTMLDivElement };
      }
    ).selection2DOverlayHud;

    expect(hud?.top.textContent).toContain('Player');
    expect(hud?.top.title).toBe('Player · Sprite2D');
    expect(hud?.bottom.textContent).toBe('100 x 50');
    expect(hud?.top.style.display).toBe('inline-flex');
    expect(hud?.bottom.style.display).toBe('inline-flex');
    expect(Number.parseFloat(hud?.top.style.top ?? '0')).toBeLessThan(90);
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
    const updateNodeIconPositions = vi.spyOn(
      service as unknown as { updateNodeIconPositions: () => void },
      'updateNodeIconPositions'
    );
    const updateNodeIconVisibility = vi.spyOn(
      service as unknown as { updateNodeIconVisibility: () => void },
      'updateNodeIconVisibility'
    );

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
    expect(appState.scenes.cameraStates['scene-open']?.zoom).toBeCloseTo(expectedDefault2DZoom);
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

    const savedState = appState.scenes.cameraStates['scene-2d'];
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
        tickComponentPreview: (dt: number) => void;
      }
    ).tickComponentPreview(0.25);

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
        tickComponentPreview: (dt: number) => void;
      }
    ).tickComponentPreview(0.25);

    expect(component.tickSpy).not.toHaveBeenCalled();
  });
});
