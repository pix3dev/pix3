import type { PropertyDefinition } from '@/fw';
import type { AnimationClip, AnimationFrame, AnimationPlaybackMode } from '@pix3/runtime';
import type { AnimationInspectorController } from '@/services/animation/AnimationEditorService';

/**
 * The Animation Inspector's clip/frame editors expressed as ordinary
 * {@link PropertyDefinition}s, so they render through the same property-row
 * machinery (`renderDetachedProperty` → `pix3-number-field`, `pix3-vector2-editor`,
 * `.property-input--text`, …) every other inspector section uses.
 *
 * A definition's `getValue`/`setValue` close over nothing: the target carries both
 * the value holder (clip/frame snapshot) and the controller the edit routes to, so
 * the arrays below are module constants and each render just passes a fresh target.
 */

export interface AnimationClipPropertyTarget {
  readonly controller: AnimationInspectorController;
  readonly clip: AnimationClip;
}

export interface AnimationFramePropertyTarget {
  readonly controller: AnimationInspectorController;
  readonly frame: AnimationFrame;
}

export interface AnimationResourcePropertyTarget {
  readonly controller: AnimationInspectorController;
  readonly texturePath: string;
}

interface Vector2Value {
  x: number;
  y: number;
}

function asClipTarget(target: unknown): AnimationClipPropertyTarget {
  return target as AnimationClipPropertyTarget;
}

function asFrameTarget(target: unknown): AnimationFramePropertyTarget {
  return target as AnimationFramePropertyTarget;
}

function asResourceTarget(target: unknown): AnimationResourcePropertyTarget {
  return target as AnimationResourcePropertyTarget;
}

/** Vector editors emit both axes on every commit; only forward the one that moved. */
function toVector2(value: unknown, fallback: Vector2Value): Vector2Value {
  if (value && typeof value === 'object') {
    const candidate = value as Partial<Vector2Value>;
    return {
      x: Number.isFinite(candidate.x) ? Number(candidate.x) : fallback.x,
      y: Number.isFinite(candidate.y) ? Number(candidate.y) : fallback.y,
    };
  }
  return fallback;
}

/** The animation resource's one-time spritesheet import source. */
export const ANIMATION_RESOURCE_PROPERTIES: readonly PropertyDefinition[] = [
  {
    name: 'animationTexturePath',
    type: 'string',
    ui: {
      label: 'Source',
      group: 'Spritesheet Import',
      description:
        'One-time import source. The editor stores sequence frames as separate files after slicing.',
    },
    getValue: target => asResourceTarget(target).texturePath,
    setValue: (target, value) => {
      void asResourceTarget(target).controller.updateTexturePath(String(value ?? '').trim());
    },
  },
];

export const ANIMATION_CLIP_PROPERTIES: readonly PropertyDefinition[] = [
  {
    name: 'animationClipName',
    type: 'string',
    ui: { label: 'Name', group: 'Clip' },
    getValue: target => asClipTarget(target).clip.name,
    setValue: (target, value) => {
      const nextName = String(value ?? '').trim();
      if (!nextName) {
        return;
      }
      void asClipTarget(target).controller.renameClip(nextName);
    },
  },
  {
    name: 'animationClipFps',
    type: 'number',
    ui: { label: 'FPS', group: 'Clip', min: 1, step: 1, precision: 0 },
    getValue: target => asClipTarget(target).clip.fps,
    setValue: (target, value) => {
      void asClipTarget(target).controller.updateClipFps(Number(value));
    },
  },
  {
    name: 'animationClipPlaybackMode',
    type: 'enum',
    ui: {
      label: 'Playback',
      group: 'Clip',
      options: { Normal: 'normal', 'Ping-Pong': 'ping-pong' },
    },
    getValue: target => asClipTarget(target).clip.playbackMode,
    setValue: (target, value) => {
      void asClipTarget(target).controller.updateClipPlaybackMode(value as AnimationPlaybackMode);
    },
  },
  {
    name: 'animationClipLoop',
    type: 'boolean',
    ui: { label: 'Loop', group: 'Clip' },
    getValue: target => asClipTarget(target).clip.loop,
    setValue: (target, value) => {
      void asClipTarget(target).controller.updateClipLoop(value === true);
    },
  },
];

export const ANIMATION_FRAME_PROPERTIES: readonly PropertyDefinition[] = [
  {
    name: 'animationFrameDurationMultiplier',
    type: 'number',
    ui: {
      label: 'Duration',
      group: 'Frame',
      unit: 'x',
      min: 0.05,
      step: 0.05,
      precision: 2,
      description: "Per-frame duration multiplier — 1 keeps the clip's own frame time.",
    },
    getValue: target => asFrameTarget(target).frame.durationMultiplier,
    setValue: (target, value) => {
      void asFrameTarget(target).controller.updateSelectedFrameDurationMultiplier(Number(value));
    },
  },
  {
    name: 'animationFrameTexturePath',
    type: 'string',
    ui: {
      label: 'Texture',
      group: 'Frame',
      description: 'Optional per-frame texture override.',
    },
    getValue: target => asFrameTarget(target).frame.texturePath,
    setValue: (target, value) => {
      void asFrameTarget(target).controller.updateSelectedFrameTexturePath(
        String(value ?? '').trim()
      );
    },
  },
  {
    name: 'animationFrameAnchor',
    type: 'vector2',
    ui: {
      label: 'Anchor',
      group: 'Frame',
      min: 0,
      max: 1,
      step: 0.01,
      precision: 2,
      description: 'Frame origin, normalized to the frame rect (y measured from the top).',
    },
    getValue: target => {
      const { anchor } = asFrameTarget(target).frame;
      return { x: anchor.x, y: anchor.y };
    },
    setValue: (target, value) => {
      const { controller, frame } = asFrameTarget(target);
      const next = toVector2(value, { x: frame.anchor.x, y: frame.anchor.y });
      if (next.x !== frame.anchor.x) {
        void controller.updateSelectedFrameAnchor('x', next.x);
        return;
      }
      if (next.y !== frame.anchor.y) {
        void controller.updateSelectedFrameAnchor('y', next.y);
      }
    },
  },
  {
    name: 'animationFrameBoundingBoxPosition',
    type: 'vector2',
    ui: {
      label: 'Box Position',
      group: 'Frame',
      step: 1,
      precision: 0,
      description: 'Bounding-box origin in frame pixels.',
    },
    getValue: target => {
      const { boundingBox } = asFrameTarget(target).frame;
      return { x: boundingBox.x, y: boundingBox.y };
    },
    setValue: (target, value) => {
      const { controller, frame } = asFrameTarget(target);
      const next = toVector2(value, { x: frame.boundingBox.x, y: frame.boundingBox.y });
      if (next.x !== frame.boundingBox.x) {
        void controller.updateSelectedFrameBoundingBox('x', next.x);
        return;
      }
      if (next.y !== frame.boundingBox.y) {
        void controller.updateSelectedFrameBoundingBox('y', next.y);
      }
    },
  },
  {
    name: 'animationFrameBoundingBoxSize',
    type: 'vector2',
    ui: {
      label: 'Box Size',
      group: 'Frame',
      min: 0,
      step: 1,
      precision: 0,
      description: 'Bounding-box size in frame pixels.',
    },
    getValue: target => {
      const { boundingBox } = asFrameTarget(target).frame;
      return { x: boundingBox.width, y: boundingBox.height };
    },
    setValue: (target, value) => {
      const { controller, frame } = asFrameTarget(target);
      const next = toVector2(value, {
        x: frame.boundingBox.width,
        y: frame.boundingBox.height,
      });
      if (next.x !== frame.boundingBox.width) {
        void controller.updateSelectedFrameBoundingBox('width', next.x);
        return;
      }
      if (next.y !== frame.boundingBox.height) {
        void controller.updateSelectedFrameBoundingBox('height', next.y);
      }
    },
  },
];
