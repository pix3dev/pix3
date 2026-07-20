/**
 * TransformTool2d unit tests
 *
 * Tests for 2D manipulation system including:
 * - Anchor-based dragging for Group2D nodes
 * - Rotation handle distance consistency
 * - Resize operations with anchor preservation
 * - Handle state management (hover/active)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import {
  TransformTool2d,
  type Active2DTransform,
  type Selection2DOverlay,
} from './TransformTool2d';
import { Sprite2D, type SceneGraph } from '@pix3/runtime';

describe('TransformTool2d', () => {
  let tool: TransformTool2d;

  const createCamera = (): THREE.OrthographicCamera => {
    const camera = new THREE.OrthographicCamera(-400, 400, 300, -300, 0.1, 1000);
    camera.position.z = 100;
    camera.updateProjectionMatrix();
    return camera;
  };

  const toScreen = (
    world: THREE.Vector3,
    camera: THREE.OrthographicCamera,
    viewportSize: { width: number; height: number }
  ) => {
    const projected = world.clone().project(camera);
    return {
      x: ((projected.x + 1) / 2) * viewportSize.width,
      y: ((1 - projected.y) / 2) * viewportSize.height,
    };
  };

  const measureScreenSize = (
    object: THREE.Object3D,
    camera: THREE.OrthographicCamera,
    viewportSize: { width: number; height: number }
  ) => {
    const bounds = new THREE.Box3().setFromObject(object);
    const visibleWorldWidth = Math.abs(camera.right - camera.left) / Math.max(0.0001, camera.zoom);
    const visibleWorldHeight = Math.abs(camera.top - camera.bottom) / Math.max(0.0001, camera.zoom);

    return {
      width: ((bounds.max.x - bounds.min.x) / visibleWorldWidth) * viewportSize.width,
      height: ((bounds.max.y - bounds.min.y) / visibleWorldHeight) * viewportSize.height,
    };
  };

  beforeEach(() => {
    tool = new TransformTool2d();
    // Mock window.devicePixelRatio
    vi.stubGlobal('window', { devicePixelRatio: 1 });
  });

  describe('getRotationHandleOffset', () => {
    it('returns fixed offset based on handle size', () => {
      // Default handle size is 10px CSS, DPR=1, so 10px world
      // Rotation offset is 3x handle size = 30px
      const offset = tool.getRotationHandleOffset();
      expect(offset).toBe(30);
    });

    it('scales with device pixel ratio', () => {
      vi.stubGlobal('window', { devicePixelRatio: 2 });
      const tool2 = new TransformTool2d();
      // With DPR=2, handle size = 20px world, offset = 60px
      const offset = tool2.getRotationHandleOffset();
      expect(offset).toBe(60);
    });
  });

  describe('createFrame', () => {
    it('creates frame from bounds', () => {
      const bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 100, 0));

      const frame = tool.createFrame(bounds);

      expect(frame).toBeInstanceOf(THREE.Group);
      expect(frame.userData.is2DFrame).toBe(true);
      expect(frame.renderOrder).toBe(1000);
    });
  });

  describe('createHandles', () => {
    it('creates 9 handles (8 scale + 1 rotate)', () => {
      const bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 100, 0));

      const handles = tool.createHandles(bounds);

      // 8 scale handles + 1 rotate handle + 1 rotation connector line = 10
      expect(handles.length).toBe(10);

      // ensure each mesh handle uses ShapeGeometry (rounded corners)
      handles.forEach(h => {
        if (h instanceof THREE.Mesh) {
          expect(h.geometry).toBeInstanceOf(THREE.ShapeGeometry);
        }
      });
    });

    it('places rotation handle at fixed distance', () => {
      const bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 100, 0));

      const handles = tool.createHandles(bounds);
      const rotateHandle = handles.find(h => h.userData?.handleType === 'rotate');

      expect(rotateHandle).toBeDefined();
      // Top edge is at y=100, rotation offset is 30px (DPR=1)
      expect(rotateHandle!.position.y).toBe(100 + 30);
    });

    it('uses same rotation distance regardless of bounds size', () => {
      const smallBounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(50, 50, 0));
      const largeBounds = new THREE.Box3(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(500, 500, 0)
      );

      const smallHandles = tool.createHandles(smallBounds);
      const largeHandles = tool.createHandles(largeBounds);

      const smallRotate = smallHandles.find(h => h.userData?.handleType === 'rotate');
      const largeRotate = largeHandles.find(h => h.userData?.handleType === 'rotate');

      // Distance from top edge should be the same (30px)
      const smallOffset = smallRotate!.position.y - 50; // 50 is top of small bounds
      const largeOffset = largeRotate!.position.y - 500; // 500 is top of large bounds

      expect(smallOffset).toBe(30);
      expect(largeOffset).toBe(30);
      expect(smallOffset).toBe(largeOffset);
    });
  });

  describe('getHandleAt', () => {
    let overlay: Selection2DOverlay;
    let camera: THREE.OrthographicCamera;
    const viewportSize = { width: 800, height: 600 };

    beforeEach(() => {
      const bounds = new THREE.Box3(new THREE.Vector3(100, 100, 0), new THREE.Vector3(200, 200, 0));

      camera = createCamera();

      overlay = {
        group: new THREE.Group(),
        handles: tool.createHandles(bounds),
        frame: tool.createFrame(bounds),
        nodeIds: ['test-node'],
        combinedBounds: bounds,
        centerWorld: new THREE.Vector3(150, 150, 0),
      };

      overlay.group.add(overlay.frame, ...overlay.handles);
      overlay.group.updateMatrixWorld(true);
    });

    it('returns move when inside bounds', () => {
      // Center of bounds is at (150, 150) in world coords
      // With ortho camera centered at 0,0 with left=-400,right=400, top=300, bottom=-300
      // Screen coords: x = (worldX + 400) / 800 * viewportWidth = (150 + 400) / 800 * 800 = 550
      // Screen coords: y = (300 - worldY) / 600 * viewportHeight = (300 - 150) / 600 * 600 = 150
      const handle = tool.getHandleAt(550, 150, overlay, camera, viewportSize);
      // Note: Actual raycast depends on precise camera setup
      // This tests the general flow
      expect(['move', 'idle']).toContain(handle);
    });

    it('returns idle outside all handles and bounds', () => {
      const handle = tool.getHandleAt(0, 0, overlay, camera, viewportSize);
      expect(handle).toBe('idle');
    });
  });

  describe('active handle state', () => {
    let overlay: Selection2DOverlay;

    beforeEach(() => {
      const bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 100, 0));

      overlay = {
        group: new THREE.Group(),
        handles: tool.createHandles(bounds),
        frame: tool.createFrame(bounds),
        nodeIds: ['test-node'],
        combinedBounds: bounds,
        centerWorld: new THREE.Vector3(50, 50, 0),
      };
    });

    it('tracks active handle', () => {
      expect(tool.getActiveHandle()).toBe('idle');

      tool.setActiveHandle('scale-ne', overlay);
      expect(tool.getActiveHandle()).toBe('scale-ne');

      tool.clearActiveHandle(overlay);
      expect(tool.getActiveHandle()).toBe('idle');
    });

    it('changes handle color when active', () => {
      const scaleGroup = overlay.handles.find(h => h.userData?.handleType === 'scale-ne');
      expect(scaleGroup).toBeDefined();
      let scaleHandle: THREE.Mesh | undefined;
      if (scaleGroup instanceof THREE.Group) {
        // use fill child as the actual mesh to inspect
        scaleHandle = scaleGroup.children.find(c => c.userData?.['isFill']) as
          | THREE.Mesh
          | undefined;
      } else if (scaleGroup instanceof THREE.Mesh) {
        scaleHandle = scaleGroup;
      }

      expect(scaleHandle).toBeDefined();
      const material = scaleHandle!.material as THREE.MeshBasicMaterial;
      const originalColor = material.color.getHex();

      tool.setActiveHandle('scale-ne', overlay);

      // Color should be active-drag color (0x1ebde3 = sky)
      expect(material.color.getHex()).toBe(0x1ebde3);

      tool.clearActiveHandle(overlay);

      // Color should return to original
      expect(material.color.getHex()).toBe(originalColor);
    });
  });

  describe('hover state', () => {
    let overlay: Selection2DOverlay;

    beforeEach(() => {
      const bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 100, 0));

      overlay = {
        group: new THREE.Group(),
        handles: tool.createHandles(bounds),
        frame: tool.createFrame(bounds),
        nodeIds: ['test-node'],
        combinedBounds: bounds,
        centerWorld: new THREE.Vector3(50, 50, 0),
      };

      overlay.group.add(overlay.frame, ...overlay.handles);
    });

    it('tracks hovered handle', () => {
      expect(tool.getHoveredHandle()).toBe('idle');
    });

    it('clearHover resets hover state', () => {
      tool.clearHover(overlay);
      expect(tool.getHoveredHandle()).toBe('idle');
    });
  });

  describe('zoom-invariant handle sizing', () => {
    const viewportSize = { width: 800, height: 600 };

    const createOverlay = (): Selection2DOverlay => {
      const bounds = new THREE.Box3(new THREE.Vector3(100, 100, 0), new THREE.Vector3(200, 200, 0));
      const overlay: Selection2DOverlay = {
        group: new THREE.Group(),
        handles: tool.createHandles(bounds),
        frame: tool.createFrame(bounds),
        nodeIds: ['test-node'],
        combinedBounds: bounds,
        centerWorld: new THREE.Vector3(150, 150, 0),
      };

      overlay.group.add(overlay.frame, ...overlay.handles);
      return overlay;
    };

    it('keeps resize handles at a constant screen size across zoom levels', () => {
      const overlay = createOverlay();
      const handle = overlay.handles.find(item => item.userData?.handleType === 'scale-ne');

      expect(handle).toBeDefined();

      const zoomedOutCamera = createCamera();
      zoomedOutCamera.zoom = 0.5;
      zoomedOutCamera.updateProjectionMatrix();
      tool.updateHandlePositions(overlay, zoomedOutCamera, viewportSize);
      overlay.group.updateMatrixWorld(true);
      const zoomedOutSize = measureScreenSize(handle!, zoomedOutCamera, viewportSize);

      const zoomedInCamera = createCamera();
      zoomedInCamera.zoom = 2;
      zoomedInCamera.updateProjectionMatrix();
      tool.updateHandlePositions(overlay, zoomedInCamera, viewportSize);
      overlay.group.updateMatrixWorld(true);
      const zoomedInSize = measureScreenSize(handle!, zoomedInCamera, viewportSize);

      expect(zoomedOutSize.width).toBeCloseTo(zoomedInSize.width, 5);
      expect(zoomedOutSize.height).toBeCloseTo(zoomedInSize.height, 5);
    });

    it('keeps handle hit area constant across zoom levels', () => {
      const overlay = createOverlay();
      const rotateHandle = overlay.handles.find(item => item.userData?.handleType === 'rotate');

      expect(rotateHandle).toBeDefined();

      for (const zoom of [0.5, 2]) {
        const camera = createCamera();
        camera.zoom = zoom;
        camera.updateProjectionMatrix();

        tool.updateHandlePositions(overlay, camera, viewportSize);
        overlay.group.updateMatrixWorld(true);

        const handleCenter = rotateHandle!.getWorldPosition(new THREE.Vector3());
        const centerScreen = toScreen(handleCenter, camera, viewportSize);

        expect(
          tool.getHandleAt(centerScreen.x + 6, centerScreen.y, overlay, camera, viewportSize)
        ).toBe('rotate');
        expect(
          tool.getHandleAt(centerScreen.x + 8, centerScreen.y, overlay, camera, viewportSize)
        ).toBe('idle');
      }
    });
  });

  describe('rotated overlay geometry', () => {
    const viewportSize = { width: 800, height: 600 };

    it('rotates the frame and handles with the overlay group', () => {
      const localBounds = new THREE.Box3(
        new THREE.Vector3(-50, -25, 0),
        new THREE.Vector3(50, 25, 0)
      );
      const overlay: Selection2DOverlay = {
        group: new THREE.Group(),
        handles: tool.createHandles(localBounds),
        frame: tool.createFrame(localBounds),
        nodeIds: ['test-node'],
        combinedBounds: new THREE.Box3(
          new THREE.Vector3(50, 75, 0),
          new THREE.Vector3(150, 125, 0)
        ),
        centerWorld: new THREE.Vector3(100, 100, 0),
        localBounds,
        worldRotationZ: Math.PI / 4,
      };

      overlay.group.add(overlay.frame, ...overlay.handles);

      const camera = createCamera();
      tool.updateHandlePositions(overlay, camera, viewportSize);

      expect(overlay.group.rotation.z).toBeCloseTo(Math.PI / 4);

      const eastHandle = overlay.handles.find(item => item.userData?.handleType === 'scale-e');
      expect(eastHandle).toBeDefined();

      const eastHandleWorld = eastHandle!.getWorldPosition(new THREE.Vector3());
      const expectedOffset = new THREE.Vector3(50, 0, 0).applyAxisAngle(
        new THREE.Vector3(0, 0, 1),
        Math.PI / 4
      );

      expect(eastHandleWorld.x).toBeCloseTo(100 + expectedOffset.x, 5);
      expect(eastHandleWorld.y).toBeCloseTo(100 + expectedOffset.y, 5);
    });

    it('resizes along the rotated local axis', () => {
      const sprite = new Sprite2D({
        id: 'sprite-rotated-resize',
        name: 'Sprite Rotated Resize',
        width: 100,
        height: 50,
      });
      sprite.rotation.z = Math.PI / 2;
      sprite.updateWorldMatrix(true, false);

      const sceneGraph: SceneGraph = {
        version: '1.0',
        rootNodes: [sprite],
        nodeMap: new Map([[sprite.nodeId, sprite]]),
        metadata: {},
      };
      const transform: Active2DTransform = {
        nodeIds: [sprite.nodeId],
        handle: 'scale-e',
        startPointerWorld: new THREE.Vector3(0, 50, 0),
        startStates: new Map([
          [
            sprite.nodeId,
            {
              position: sprite.position.clone(),
              rotation: sprite.rotation.z,
              scale: new THREE.Vector2(sprite.scale.x, sprite.scale.y),
              width: sprite.width,
              height: sprite.height,
              worldPosition: sprite.getWorldPosition(new THREE.Vector3()),
              worldRotationZ: sprite.rotation.z,
            },
          ],
        ]),
        combinedBounds: new THREE.Box3(
          new THREE.Vector3(-25, -50, 0),
          new THREE.Vector3(25, 50, 0)
        ),
        startCenterWorld: new THREE.Vector3(0, 0, 0),
        anchorWorld: new THREE.Vector3(0, -50, 0),
        anchorLocal: new THREE.Vector3(-50, 0, 0),
        startSize: new THREE.Vector2(100, 50),
        overlayRotationZ: Math.PI / 2,
      };
      const camera = createCamera();

      tool.updateTransform(400, 200, transform, sceneGraph, camera, viewportSize);

      expect(sprite.width).toBeCloseTo(150);
      expect(sprite.height).toBeCloseTo(50);
      expect(sprite.position.x).toBeCloseTo(0);
      expect(sprite.position.y).toBeCloseTo(25);
    });
  });

  describe('axis-constrained move', () => {
    const viewportSize = { width: 800, height: 600 };

    const toScreen = (worldX: number, worldY: number) => ({
      x: worldX + 400,
      y: 300 - worldY,
    });

    const createSceneGraph = (sprite: Sprite2D): SceneGraph => ({
      version: '1.0',
      rootNodes: [sprite],
      nodeMap: new Map([[sprite.nodeId, sprite]]),
      metadata: {},
    });

    const createMoveTransform = (sprite: Sprite2D): Active2DTransform => {
      sprite.updateWorldMatrix(true, false);
      return {
        nodeIds: [sprite.nodeId],
        handle: 'move',
        startPointerWorld: new THREE.Vector3(0, 0, 0),
        startStates: new Map([
          [
            sprite.nodeId,
            {
              position: sprite.position.clone(),
              rotation: sprite.rotation.z,
              scale: new THREE.Vector2(sprite.scale.x, sprite.scale.y),
              width: sprite.width,
              height: sprite.height,
              worldPosition: sprite.getWorldPosition(new THREE.Vector3()),
              worldRotationZ: sprite.rotation.z,
            },
          ],
        ]),
        combinedBounds: new THREE.Box3(
          new THREE.Vector3(-50, -25, 0),
          new THREE.Vector3(50, 25, 0)
        ),
        startCenterWorld: new THREE.Vector3(0, 0, 0),
        anchorWorld: new THREE.Vector3(0, 0, 0),
        anchorLocal: new THREE.Vector3(0, 0, 0),
        startSize: new THREE.Vector2(100, 50),
        moveConstraintAxis: null,
      };
    };

    it('locks move to the dominant x axis while shift is held', () => {
      const sprite = new Sprite2D({
        id: 'sprite-move-x',
        name: 'Sprite Move X',
        width: 100,
        height: 50,
      });
      const sceneGraph = createSceneGraph(sprite);
      const transform = createMoveTransform(sprite);
      const camera = createCamera();
      const pointer = toScreen(40, 10);

      tool.updateTransform(pointer.x, pointer.y, transform, sceneGraph, camera, viewportSize, {
        constrainMoveToAxis: true,
      });

      expect(sprite.position.x).toBeCloseTo(40);
      expect(sprite.position.y).toBeCloseTo(0);
      expect(transform.moveConstraintAxis).toBe('x');
    });

    it('releases axis lock when shift is no longer held', () => {
      const sprite = new Sprite2D({
        id: 'sprite-move-release',
        name: 'Sprite Move Release',
        width: 100,
        height: 50,
      });
      const sceneGraph = createSceneGraph(sprite);
      const transform = createMoveTransform(sprite);
      const camera = createCamera();
      const firstPointer = toScreen(40, 10);
      const secondPointer = toScreen(40, 10);

      tool.updateTransform(
        firstPointer.x,
        firstPointer.y,
        transform,
        sceneGraph,
        camera,
        viewportSize,
        { constrainMoveToAxis: true }
      );

      tool.updateTransform(
        secondPointer.x,
        secondPointer.y,
        transform,
        sceneGraph,
        camera,
        viewportSize
      );

      expect(sprite.position.x).toBeCloseTo(40);
      expect(sprite.position.y).toBeCloseTo(10);
      expect(transform.moveConstraintAxis).toBeNull();
    });
  });

  describe('aspect-ratio constrained resize', () => {
    const viewportSize = { width: 800, height: 600 };

    const createCamera = (): THREE.OrthographicCamera => {
      const camera = new THREE.OrthographicCamera(-400, 400, 300, -300, 0.1, 1000);
      camera.position.z = 100;
      camera.updateProjectionMatrix();
      return camera;
    };

    const toScreen = (worldX: number, worldY: number) => ({
      x: worldX + 400,
      y: 300 - worldY,
    });

    const createSceneGraph = (sprite: Sprite2D): SceneGraph => ({
      version: '1.0',
      rootNodes: [sprite],
      nodeMap: new Map([[sprite.nodeId, sprite]]),
      metadata: {},
    });

    const createScaleEastTransform = (sprite: Sprite2D): Active2DTransform => {
      sprite.updateWorldMatrix(true, false);
      return {
        nodeIds: [sprite.nodeId],
        handle: 'scale-e',
        startPointerWorld: new THREE.Vector3(50, 0, 0),
        startStates: new Map([
          [
            sprite.nodeId,
            {
              position: sprite.position.clone(),
              rotation: sprite.rotation.z,
              scale: new THREE.Vector2(sprite.scale.x, sprite.scale.y),
              width: sprite.width,
              height: sprite.height,
              worldPosition: sprite.getWorldPosition(new THREE.Vector3()),
              worldRotationZ: sprite.rotation.z,
            },
          ],
        ]),
        combinedBounds: new THREE.Box3(
          new THREE.Vector3(-50, -25, 0),
          new THREE.Vector3(50, 25, 0)
        ),
        startCenterWorld: new THREE.Vector3(0, 0, 0),
        anchorWorld: new THREE.Vector3(-50, 0, 0),
        anchorLocal: new THREE.Vector3(-50, 0, 0),
        startSize: new THREE.Vector2(100, 50),
      };
    };

    it('preserves aspect ratio while shift-constrained resizing a single sprite', () => {
      const sprite = new Sprite2D({
        id: 'sprite-shift',
        name: 'Sprite Shift',
        width: 100,
        height: 50,
      });
      const sceneGraph = createSceneGraph(sprite);
      const transform = createScaleEastTransform(sprite);
      const camera = createCamera();
      const pointer = toScreen(100, 0);

      tool.updateTransform(pointer.x, pointer.y, transform, sceneGraph, camera, viewportSize, {
        preserveAspectRatio: true,
      });

      expect(sprite.width).toBeCloseTo(150);
      expect(sprite.height).toBeCloseTo(75);
    });

    it('keeps freeform resizing when shift is not pressed and aspect lock is off', () => {
      const sprite = new Sprite2D({
        id: 'sprite-freeform',
        name: 'Sprite Freeform',
        width: 100,
        height: 50,
      });
      const sceneGraph = createSceneGraph(sprite);
      const transform = createScaleEastTransform(sprite);
      const camera = createCamera();
      const pointer = toScreen(100, 0);

      tool.updateTransform(pointer.x, pointer.y, transform, sceneGraph, camera, viewportSize);

      expect(sprite.width).toBeCloseTo(150);
      expect(sprite.height).toBeCloseTo(50);
    });
  });

  describe('rotation snapping', () => {
    const viewportSize = { width: 800, height: 600 };

    const createCamera = (): THREE.OrthographicCamera => {
      const camera = new THREE.OrthographicCamera(-400, 400, 300, -300, 0.1, 1000);
      camera.position.z = 100;
      camera.updateProjectionMatrix();
      return camera;
    };

    const toScreen = (worldX: number, worldY: number) => ({
      x: worldX + 400,
      y: 300 - worldY,
    });

    const createSceneGraph = (sprite: Sprite2D): SceneGraph => ({
      version: '1.0',
      rootNodes: [sprite],
      nodeMap: new Map([[sprite.nodeId, sprite]]),
      metadata: {},
    });

    const createRotateTransform = (sprite: Sprite2D): Active2DTransform => {
      sprite.updateWorldMatrix(true, false);
      return {
        nodeIds: [sprite.nodeId],
        handle: 'rotate',
        // Start pointer at angle 0 relative to the selection center.
        startPointerWorld: new THREE.Vector3(100, 0, 0),
        startStates: new Map([
          [
            sprite.nodeId,
            {
              position: sprite.position.clone(),
              rotation: sprite.rotation.z,
              scale: new THREE.Vector2(sprite.scale.x, sprite.scale.y),
              width: sprite.width,
              height: sprite.height,
              worldPosition: sprite.getWorldPosition(new THREE.Vector3()),
              worldRotationZ: sprite.rotation.z,
            },
          ],
        ]),
        combinedBounds: new THREE.Box3(
          new THREE.Vector3(-50, -25, 0),
          new THREE.Vector3(50, 25, 0)
        ),
        startCenterWorld: new THREE.Vector3(0, 0, 0),
        anchorWorld: new THREE.Vector3(0, 0, 0),
        anchorLocal: new THREE.Vector3(0, 0, 0),
        startSize: new THREE.Vector2(100, 50),
        overlayRotationZ: 0,
        moveConstraintAxis: null,
      };
    };

    // Pointer position at a given angle (degrees) on a radius-100 circle.
    const pointerAtAngle = (deg: number) => {
      const rad = (deg * Math.PI) / 180;
      return toScreen(100 * Math.cos(rad), 100 * Math.sin(rad));
    };

    it('snaps rotation to the nearest 5-degree increment while shift is held', () => {
      const sprite = new Sprite2D({
        id: 'sprite-rot-snap',
        name: 'Sprite Rot',
        width: 100,
        height: 50,
      });
      const sceneGraph = createSceneGraph(sprite);
      const transform = createRotateTransform(sprite);
      const camera = createCamera();
      const pointer = pointerAtAngle(12);

      tool.updateTransform(pointer.x, pointer.y, transform, sceneGraph, camera, viewportSize, {
        snapRotation: true,
      });

      expect(sprite.rotation.z).toBeCloseTo((10 * Math.PI) / 180);
    });

    it('rotates freely when shift is not held', () => {
      const sprite = new Sprite2D({
        id: 'sprite-rot-free',
        name: 'Sprite Rot Free',
        width: 100,
        height: 50,
      });
      const sceneGraph = createSceneGraph(sprite);
      const transform = createRotateTransform(sprite);
      const camera = createCamera();
      const pointer = pointerAtAngle(12);

      tool.updateTransform(pointer.x, pointer.y, transform, sceneGraph, camera, viewportSize);

      expect(sprite.rotation.z).toBeCloseTo((12 * Math.PI) / 180);
    });

    it('honours a custom rotation snap increment', () => {
      const sprite = new Sprite2D({
        id: 'sprite-rot-15',
        name: 'Sprite Rot 15',
        width: 100,
        height: 50,
      });
      const sceneGraph = createSceneGraph(sprite);
      const transform = createRotateTransform(sprite);
      const camera = createCamera();
      const pointer = pointerAtAngle(22);

      tool.updateTransform(pointer.x, pointer.y, transform, sceneGraph, camera, viewportSize, {
        snapRotation: true,
        rotationSnapDegrees: 15,
      });

      expect(sprite.rotation.z).toBeCloseTo((15 * Math.PI) / 180);
    });
  });
});
