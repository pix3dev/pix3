/**
 * ViewportAxisGizmo — the orientation indicator (X/Y/Z axis balls) drawn in the
 * bottom-right corner of the editor viewport, Blender/Godot style. Clicking a
 * ball flies the editor camera onto that axis around the current orbit pivot.
 *
 * It draws itself into a small square viewport of the *same* framebuffer with
 * its own orthographic camera and its own miniature object tree — nothing here
 * ever joins the editor scene, so no layer/render-order bookkeeping applies.
 *
 * Three non-obvious things:
 *  - The pass must never clear: it owns a corner of the frame everything else
 *    already drew into. The caller keeps `autoClear` off around `render()`.
 *  - `renderer.setViewport()` here is in the *renderer's* logical units, and the
 *    editor deliberately calls `setSize(cssPx * devicePixelRatio)` — so the CSS
 *    size the user sees has to be converted (see `resolveLogicalScale`) instead
 *    of passed through, or the gizmo lands short of the corner.
 *  - The snap flight moves the camera outside every render-on-demand dirty path,
 *    so the owner reports `isAnimating()` for the rAF loop to keep painting
 *    (CLAUDE.md render-on-demand rule).
 */
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { appState } from '@/state';

/** Side of the gizmo's square box, in CSS pixels. */
const GIZMO_SIZE_CSS_PX = 104;

/** Gap between the gizmo box and the viewport's bottom-right corner, in CSS px. */
const GIZMO_MARGIN_CSS_PX = 12;

/**
 * The universal editor axis triad (Blender / Godot / three's own ViewHelper):
 * X red, Y green, Z blue. Deliberately not themed — these colours carry meaning,
 * and re-hueing them to the accent would make the gizmo unreadable.
 */
const AXIS_COLORS = ['#ff5470', '#8ddb3f', '#4d97ff'] as const;

/** Radians per second of the snap flight. */
const TURN_RATE = 2 * Math.PI;

/** Half-extent of the gizmo's orthographic frustum; the axis balls sit at ±1. */
const FRUSTUM_HALF = 1.55;

/** Diameter of an axis ball in frustum units. */
const BALL_SIZE = 0.62;

type AxisId = 'posX' | 'posY' | 'posZ' | 'negX' | 'negY' | 'negZ';

export interface AxisGizmoRect {
  /** Left edge, in CSS pixels from the canvas's left edge. */
  readonly x: number;
  /** Top edge, in CSS pixels from the canvas's top edge. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the gizmo sits inside a canvas of the given CSS size, in DOM
 * coordinates (y grows downward). Exported for the pointer hit-test and its spec.
 */
export function getAxisGizmoRect(canvasWidth: number, canvasHeight: number): AxisGizmoRect {
  return {
    x: canvasWidth - GIZMO_SIZE_CSS_PX - GIZMO_MARGIN_CSS_PX,
    y: canvasHeight - GIZMO_SIZE_CSS_PX - GIZMO_MARGIN_CSS_PX,
    width: GIZMO_SIZE_CSS_PX,
    height: GIZMO_SIZE_CSS_PX,
  };
}

/** True when the point (CSS px, canvas-relative, y down) is over the gizmo box. */
export function isPointInAxisGizmo(
  pointX: number,
  pointY: number,
  canvasWidth: number,
  canvasHeight: number
): boolean {
  const rect = getAxisGizmoRect(canvasWidth, canvasHeight);
  return (
    pointX >= rect.x &&
    pointX <= rect.x + rect.width &&
    pointY >= rect.y &&
    pointY <= rect.y + rect.height
  );
}

/** Where an axis puts the camera, and how the camera is oriented once it lands. */
const AXIS_VIEWS: Record<
  AxisId,
  { readonly direction: THREE.Vector3; readonly euler: THREE.Euler }
> = {
  posX: { direction: new THREE.Vector3(1, 0, 0), euler: new THREE.Euler(0, Math.PI * 0.5, 0) },
  negX: { direction: new THREE.Vector3(-1, 0, 0), euler: new THREE.Euler(0, -Math.PI * 0.5, 0) },
  posY: { direction: new THREE.Vector3(0, 1, 0), euler: new THREE.Euler(-Math.PI * 0.5, 0, 0) },
  negY: { direction: new THREE.Vector3(0, -1, 0), euler: new THREE.Euler(Math.PI * 0.5, 0, 0) },
  posZ: { direction: new THREE.Vector3(0, 0, 1), euler: new THREE.Euler() },
  negZ: { direction: new THREE.Vector3(0, 0, -1), euler: new THREE.Euler(0, Math.PI, 0) },
};

interface SnapFlight {
  /** Orbit rotation being slerped, as a look-at-the-camera orientation. */
  readonly from: THREE.Quaternion;
  readonly to: THREE.Quaternion;
  /** Camera orientation at the end of the flight. */
  readonly orientation: THREE.Quaternion;
  /** Orbit distance, held constant so the flight neither zooms in nor out. */
  readonly radius: number;
}

export interface ViewportAxisGizmoDeps {
  getCanvas(): HTMLCanvasElement | undefined;
  /** The editor-controlled camera the gizmo visualizes and snaps. */
  getCamera(): THREE.Camera | undefined;
  /** Orbit pivot: the snap flight keeps this point centred. */
  getOrbitControls(): OrbitControls | undefined;
  requestRender(): void;
}

export class ViewportAxisGizmo {
  private readonly deps: ViewportAxisGizmoDeps;

  private root?: THREE.Group;
  private camera?: THREE.OrthographicCamera;
  private balls: THREE.Sprite[] = [];
  private disposables: Array<{ dispose(): void }> = [];

  private flight?: SnapFlight;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly logicalSize = new THREE.Vector2();
  private readonly scratchCenter = new THREE.Vector3();
  private readonly scratchObject = new THREE.Object3D();

  constructor(deps: ViewportAxisGizmoDeps) {
    this.deps = deps;
  }

  /**
   * The gizmo is a 3D-navigation affordance: in 2D mode the view is locked
   * looking down -Z, so an orientation indicator would never move.
   */
  isEnabled(): boolean {
    return appState.ui.showAxisGizmo && appState.ui.navigationMode === '3d';
  }

  isAnimating(): boolean {
    return this.flight !== undefined;
  }

  /**
   * Draws the gizmo over the current frame. The caller owns `autoClear` — this
   * pass must never clear, or it erases the scene underneath it.
   */
  render(renderer: THREE.WebGLRenderer): void {
    if (!this.isEnabled()) return;

    const camera = this.deps.getCamera();
    const scale = this.resolveLogicalScale(renderer);
    if (!camera || scale === null) return;

    const { root, camera: gizmoCamera } = this.ensureVisuals();

    // Counter-rotating by the camera's orientation is what makes the little axes
    // point the same way the world's do.
    root.quaternion.copy(camera.quaternion).invert();
    root.updateMatrixWorld(true);

    const box = GIZMO_SIZE_CSS_PX * scale;
    const margin = GIZMO_MARGIN_CSS_PX * scale;
    const x = this.logicalSize.x - box - margin;
    const y = margin; // setViewport's origin is the bottom-left.

    const savedViewport = new THREE.Vector4();
    renderer.getViewport(savedViewport);
    renderer.clearDepth();
    renderer.setViewport(x, y, box, box);
    renderer.render(root, gizmoCamera);
    renderer.setViewport(savedViewport.x, savedViewport.y, savedViewport.z, savedViewport.w);
  }

  /**
   * Pointer-down over the gizmo. Returns true when the press belongs to the
   * gizmo, in which case the viewport must not treat it as a pick — otherwise a
   * click in that corner would clear the selection.
   */
  handlePointerDown(event: PointerEvent): boolean {
    if (event.button !== 0) return false;

    const local = this.resolveLocalPoint(event);
    if (!local) return false;

    const axis = this.pickAxis(local.x, local.y, local.canvasWidth, local.canvasHeight);
    if (axis) {
      this.startFlight(axis);
    }

    // Swallow the press either way: the gizmo box is chrome, not scene surface.
    return true;
  }

  /** True while the pointer is over the gizmo box (and the gizmo is showing). */
  containsPointer(event: PointerEvent): boolean {
    return this.resolveLocalPoint(event) !== null;
  }

  /**
   * Advances the snap flight. Must run *after* the orbit controls' own update so
   * the animated camera pose wins for this frame; the controls are re-synced
   * once the flight lands.
   */
  update(deltaSeconds: number): void {
    const flight = this.flight;
    const camera = this.deps.getCamera();
    if (!flight || !camera) return;

    const step = deltaSeconds * TURN_RATE;
    const center = this.resolveCenter();

    flight.from.rotateTowards(flight.to, step);
    camera.position
      .set(0, 0, 1)
      .applyQuaternion(flight.from)
      .multiplyScalar(flight.radius)
      .add(center);
    camera.quaternion.rotateTowards(flight.orientation, step);

    if (flight.from.angleTo(flight.to) === 0) {
      this.flight = undefined;
      // Landed: let OrbitControls re-derive its spherical state from the new pose.
      this.deps.getOrbitControls()?.update();
    }

    this.deps.requestRender();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    this.balls = [];
    this.root = undefined;
    this.camera = undefined;
    this.flight = undefined;
  }

  private startFlight(axis: AxisId): void {
    const camera = this.deps.getCamera();
    if (!camera) return;

    const center = this.resolveCenter();
    const view = AXIS_VIEWS[axis];
    const radius = camera.position.distanceTo(center) || 1;

    // Slerping "look at the camera from the pivot" orientations keeps the flight
    // on the orbit sphere instead of cutting a straight line through the scene.
    const dummy = this.scratchObject;
    dummy.position.copy(center);
    dummy.lookAt(camera.position);
    const from = dummy.quaternion.clone();

    dummy.lookAt(view.direction.clone().multiplyScalar(radius).add(center));
    const to = dummy.quaternion.clone();

    this.flight = {
      from,
      to,
      orientation: new THREE.Quaternion().setFromEuler(view.euler),
      radius,
    };
    this.deps.requestRender();
  }

  private pickAxis(
    pointX: number,
    pointY: number,
    canvasWidth: number,
    canvasHeight: number
  ): AxisId | null {
    const camera = this.deps.getCamera();
    if (!camera) return null;

    const { root, camera: gizmoCamera } = this.ensureVisuals();
    root.quaternion.copy(camera.quaternion).invert();
    root.updateMatrixWorld(true);

    const rect = getAxisGizmoRect(canvasWidth, canvasHeight);
    this.pointerNdc.set(
      ((pointX - rect.x) / rect.width) * 2 - 1,
      -((pointY - rect.y) / rect.height) * 2 + 1
    );

    this.raycaster.setFromCamera(this.pointerNdc, gizmoCamera);
    const hit = this.raycaster.intersectObjects(this.balls, false)[0];
    return (hit?.object.userData.axis as AxisId | undefined) ?? null;
  }

  /** Pointer position in canvas-relative CSS px, or null when it misses the gizmo. */
  private resolveLocalPoint(
    event: PointerEvent
  ): { x: number; y: number; canvasWidth: number; canvasHeight: number } | null {
    if (!this.isEnabled()) return null;

    const canvas = this.deps.getCanvas();
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (!isPointInAxisGizmo(x, y, rect.width, rect.height)) return null;

    return { x, y, canvasWidth: rect.width, canvasHeight: rect.height };
  }

  /**
   * CSS pixels → the renderer's `setViewport` units. Not always 1: the editor
   * hands `setSize()` device pixels (see ViewportRendererService.resize), so a
   * CSS-sized box has to be scaled by whatever ratio those two sizes are apart.
   */
  private resolveLogicalScale(renderer: THREE.WebGLRenderer): number | null {
    const canvas = this.deps.getCanvas();
    if (!canvas) return null;

    renderer.getSize(this.logicalSize);
    const cssWidth = canvas.clientWidth;
    if (cssWidth <= 0 || this.logicalSize.x <= 0) return null;

    return this.logicalSize.x / cssWidth;
  }

  private resolveCenter(): THREE.Vector3 {
    const target = this.deps.getOrbitControls()?.target;
    return target ? this.scratchCenter.copy(target) : this.scratchCenter.set(0, 0, 0);
  }

  private ensureVisuals(): { root: THREE.Group; camera: THREE.OrthographicCamera } {
    if (this.root && this.camera) {
      return { root: this.root, camera: this.camera };
    }

    const root = new THREE.Group();
    // The gizmo tree is rendered on its own, never as part of the editor scene,
    // so it stays on the default layer regardless of the editor's layer split.
    const camera = new THREE.OrthographicCamera(
      -FRUSTUM_HALF,
      FRUSTUM_HALF,
      FRUSTUM_HALF,
      -FRUSTUM_HALF,
      0,
      4
    );
    camera.position.set(0, 0, 2);

    // One arm geometry, re-oriented per axis: a stub from the origin to the ball.
    const armGeometry = new THREE.CylinderGeometry(0.035, 0.035, 0.78, 8)
      .rotateZ(-Math.PI / 2)
      .translate(0.39, 0, 0);
    this.disposables.push(armGeometry);

    const axes: Array<{ positive: AxisId; negative: AxisId; label: string; color: string }> = [
      { positive: 'posX', negative: 'negX', label: 'X', color: AXIS_COLORS[0] },
      { positive: 'posY', negative: 'negY', label: 'Y', color: AXIS_COLORS[1] },
      { positive: 'posZ', negative: 'negZ', label: 'Z', color: AXIS_COLORS[2] },
    ];

    for (const axis of axes) {
      const direction = AXIS_VIEWS[axis.positive].direction;

      const armMaterial = new THREE.MeshBasicMaterial({ color: axis.color, toneMapped: false });
      this.disposables.push(armMaterial);
      const arm = new THREE.Mesh(armGeometry, armMaterial);
      // The geometry runs along +X; point it down the axis it belongs to.
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), direction);
      root.add(arm);

      root.add(this.createBall(axis.positive, direction, axis.color, axis.label, true));
      root.add(
        this.createBall(axis.negative, direction.clone().negate(), axis.color, axis.label, false)
      );
    }

    this.root = root;
    this.camera = camera;
    return { root, camera };
  }

  private createBall(
    axis: AxisId,
    direction: THREE.Vector3,
    color: string,
    label: string,
    filled: boolean
  ): THREE.Sprite {
    const texture = createBallTexture(color, filled ? label : '', filled);
    const material = new THREE.SpriteMaterial({ map: texture, toneMapped: false });
    this.disposables.push(texture, material);

    const sprite = new THREE.Sprite(material);
    sprite.position.copy(direction);
    sprite.scale.setScalar(BALL_SIZE);
    sprite.userData.axis = axis;

    this.balls.push(sprite);
    return sprite;
  }
}

/**
 * A ball as a canvas texture: a filled disc with its letter for the positive
 * end, a hollow ring for the negative one — so "which axis" survives even when
 * the far end is the only one facing you.
 */
function createBallTexture(color: string, label: string, filled: boolean): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d');
  if (context) {
    const center = size / 2;
    const radius = size / 2 - 6;

    context.beginPath();
    context.arc(center, center, radius, 0, Math.PI * 2);
    if (filled) {
      context.fillStyle = color;
      context.fill();
    } else {
      context.lineWidth = 6;
      context.strokeStyle = color;
      context.globalAlpha = 0.85;
      context.stroke();
      context.globalAlpha = 1;
    }

    if (label) {
      context.font = 'bold 30px Inter, Arial, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillStyle = '#101318';
      context.fillText(label, center, center + 1);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
