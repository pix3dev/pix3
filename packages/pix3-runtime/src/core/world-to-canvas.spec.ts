import { describe, expect, it } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { worldToCanvasLogical, worldToCanvasThroughCamera } from './world-to-canvas';

describe('worldToCanvasLogical', () => {
  const logical = { width: 1920, height: 1080 };
  const canvas = { width: 960, height: 540 };

  it('maps the world origin to the canvas center', () => {
    expect(worldToCanvasLogical(0, 0, logical, canvas)).toEqual({ x: 480, y: 270 });
  });

  it('maps the top-left world corner to canvas (0, 0) — y flips', () => {
    expect(worldToCanvasLogical(-960, 540, logical, canvas)).toEqual({ x: 0, y: 0 });
  });

  it('maps the bottom-right world corner to the canvas extent', () => {
    expect(worldToCanvasLogical(960, -540, logical, canvas)).toEqual({ x: 960, y: 540 });
  });

  it('returns null for a degenerate logical or canvas size', () => {
    expect(worldToCanvasLogical(0, 0, { width: 0, height: 1080 }, canvas)).toBeNull();
    expect(worldToCanvasLogical(0, 0, logical, { width: 0, height: 0 })).toBeNull();
  });
});

describe('worldToCanvasThroughCamera', () => {
  it('is the exact inverse of the ortho-camera unproject used by 2D hit-tests', () => {
    // Mirror the runner's 2D camera setup: frustum = logical size, camera at z=100.
    const camera = new OrthographicCamera(-960, 960, 540, -540, 0.1, 1000);
    camera.position.z = 100;
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    const canvas = { width: 800, height: 450 };

    const px = worldToCanvasThroughCamera(new Vector3(480, -270, 0), camera, canvas);
    expect(px).not.toBeNull();
    // World (480, -270) is 3/4 across, 3/4 down the 1920x1080 view.
    expect(px!.x).toBeCloseTo(600, 3);
    expect(px!.y).toBeCloseTo(337.5, 3);

    // Round-trip through the same unproject the hit-test path performs.
    const ndcX = (px!.x / canvas.width) * 2 - 1;
    const ndcY = -((px!.y / canvas.height) * 2 - 1);
    const back = new Vector3(ndcX, ndcY, 0).unproject(camera);
    expect(back.x).toBeCloseTo(480, 3);
    expect(back.y).toBeCloseTo(-270, 3);
  });

  it('respects camera pan and zoom (Camera2D view)', () => {
    const camera = new OrthographicCamera(-960, 960, 540, -540, 0.1, 1000);
    camera.position.set(200, 100, 100);
    camera.zoom = 2;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const canvas = { width: 1920, height: 1080 };

    // The camera center (its own x/y) always projects to the canvas center.
    const center = worldToCanvasThroughCamera(new Vector3(200, 100, 0), camera, canvas);
    expect(center!.x).toBeCloseTo(960, 3);
    expect(center!.y).toBeCloseTo(540, 3);

    // At zoom 2, a +240 world-x offset covers half of the 960-wide half-view → +480 px... actually:
    // visible half-width = 960 / zoom = 480 world units per 960 px → 240 world = 480 px.
    const offset = worldToCanvasThroughCamera(new Vector3(440, 100, 0), camera, canvas);
    expect(offset!.x).toBeCloseTo(960 + 480, 3);
    expect(offset!.y).toBeCloseTo(540, 3);
  });

  it('projects through a perspective camera for 3D targets', () => {
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    const canvas = { width: 1600, height: 900 };

    const center = worldToCanvasThroughCamera(new Vector3(0, 0, 0), camera, canvas);
    expect(center!.x).toBeCloseTo(800, 3);
    expect(center!.y).toBeCloseTo(450, 3);
  });

  it('returns null for a zero-sized canvas', () => {
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.updateMatrixWorld(true);
    expect(worldToCanvasThroughCamera(new Vector3(), camera, { width: 0, height: 0 })).toBeNull();
  });
});
