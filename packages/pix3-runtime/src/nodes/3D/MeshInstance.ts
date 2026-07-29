import {
  Mesh,
  Object3D,
  AnimationClip,
  AnimationMixer,
  AnimationAction,
  LoopOnce,
  LoopRepeat,
} from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';

export interface MeshInstanceProps extends Omit<Node3DProps, 'type'> {
  src?: string | null; // res:// or templ:// path to .glb/.gltf
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Optional clip name to auto-play on first runtime tick. Falls back to first available clip. */
  initialAnimation?: string | null;
  isPlaying?: boolean;
  isLoop?: boolean;
}

export class MeshInstance extends Node3D {
  readonly src: string | null;
  castShadow: boolean;
  receiveShadow: boolean;
  animations: AnimationClip[] = [];
  mixer: AnimationMixer | null = null;
  currentAction: AnimationAction | null = null;
  /** The name of the animation clip currently selected for preview. Editor-only, not serialized. */
  activeAnimation: string | null = null;
  initialAnimation: string | null;
  private _isPlaying: boolean;
  private _isLoop: boolean;
  private hasAttemptedInitialAnimation = false;

  constructor(props: MeshInstanceProps) {
    super(props, 'MeshInstance');
    this.src = props.src ?? null;
    this.castShadow = props.castShadow ?? true;
    this.receiveShadow = props.receiveShadow ?? true;
    this.initialAnimation = props.initialAnimation ?? null;
    this._isPlaying = props.isPlaying ?? true;
    this._isLoop = props.isLoop ?? true;

    // Nothing to propagate here: the shadow flags are set above, and the loaded model's children
    // get them from applyShadowPropertiesToChildren once the GLTF resolves.
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  set isPlaying(value: boolean) {
    const nextValue = !!value;
    if (this._isPlaying === nextValue) {
      return;
    }

    this._isPlaying = nextValue;
    if (this.currentAction) {
      this.currentAction.paused = !nextValue;
      if (nextValue) {
        this.currentAction.play();
      }
    }

    if (nextValue && !this.currentAction) {
      this.hasAttemptedInitialAnimation = false;
    }
  }

  get isLoop(): boolean {
    return this._isLoop;
  }

  set isLoop(value: boolean) {
    const nextValue = !!value;
    if (this._isLoop === nextValue) {
      return;
    }

    this._isLoop = nextValue;
    if (this.currentAction) {
      this.applyLoopMode(this.currentAction);
    }
  }

  /**
   * Play an animation by name. Forces `isPlaying` to true.
   * @param name - The name of the animation clip to play
   * @param loop - Optional override for looping
   */
  playAnimation(name: string, loop?: boolean): void {
    this.isPlaying = true;
    this.setAnimation(name, loop);
  }

  /**
   * Select an animation by name without forcing `isPlaying`.
   * Respects current `isPlaying` state for whether the clip actually advances.
   * @param name - The name of the animation clip to set
   * @param loop - Optional override for looping
   */
  setAnimation(name: string, loop?: boolean): void {
    const clip = this.animations.find(a => a.name === name);
    if (!clip) {
      console.warn(`[MeshInstance] Animation '${name}' not found on node ${this.nodeId}`);
      return;
    }

    if (!this.mixer) {
      this.mixer = new AnimationMixer(this);
    }

    if (this.currentAction) {
      this.currentAction.stop();
    }

    this.currentAction = this.mixer.clipAction(clip);
    this.applyLoopMode(this.currentAction, loop);
    this.currentAction.reset().play();
    this.mixer.update(0); // Force evaluation at t=0 to apply the pose immediately
    this.currentAction.paused = !this._isPlaying;
    this.activeAnimation = name;
    this.hasAttemptedInitialAnimation = true;
  }

  /**
   * Show the default animation at time 0 (for editor mode and post-stop).
   * Uses initialAnimation if set, otherwise falls back to the first available clip.
   * Clears mixer state if no animations are available (restores default mesh pose).
   * Resets hasAttemptedInitialAnimation so play mode restarts the animation cleanly.
   */
  showDefaultPose(): void {
    if (this.animations.length === 0) {
      if (this.mixer) {
        this.mixer.stopAllAction();
      }
      this.currentAction = null;
      this.activeAnimation = null;
      this.hasAttemptedInitialAnimation = false;
      return;
    }

    const preferredClip = this.initialAnimation
      ? this.animations.find(clip => clip.name === this.initialAnimation)
      : null;
    const clipToShow = preferredClip ?? this.animations[0];

    if (!this.mixer) {
      this.mixer = new AnimationMixer(this);
    }

    if (this.currentAction) {
      this.currentAction.stop();
    }

    const action = this.mixer.clipAction(clipToShow);
    action.reset().play();
    this.mixer.update(0); // Evaluate at t=0 to apply bone transforms
    action.paused = true; // Freeze at frame 0
    this.currentAction = action;
    this.activeAnimation = clipToShow.name;
    this.hasAttemptedInitialAnimation = false; // Allow play mode to restart
  }

  /**
   * Tick method called every frame.
   * Updates the animation mixer if it exists.
   * @param dt - Delta time in seconds since last frame
   */
  override tick(dt: number): void {
    super.tick(dt);
    this.playInitialAnimationIfNeeded();
    if (this.mixer && this._isPlaying) {
      this.mixer.update(dt);
    }
  }

  private playInitialAnimationIfNeeded(): void {
    if (this.hasAttemptedInitialAnimation) {
      return;
    }

    if (this.animations.length === 0) {
      return;
    }

    const preferredClip = this.initialAnimation
      ? this.animations.find(clip => clip.name === this.initialAnimation)
      : null;
    if (this.initialAnimation && !preferredClip) {
      console.warn(
        `[MeshInstance] Initial animation '${this.initialAnimation}' not found on node ${this.nodeId}. Falling back to first clip.`
      );
    }

    const clipToPlay = preferredClip ?? this.animations[0];
    this.setAnimation(clipToPlay.name);
  }

  private applyLoopMode(action: AnimationAction, loop?: boolean): void {
    const isLoop = loop !== undefined ? loop : this._isLoop;
    if (isLoop) {
      action.setLoop(LoopRepeat, Infinity);
      action.clampWhenFinished = false;
      return;
    }

    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
  }

  /**
   * Get the property schema for MeshInstance.
   * Extends Node3D schema with shadow rendering properties.
   */
  static getPropertySchema(): PropertySchema {
    const baseSchema = Node3D.getPropertySchema();

    return {
      nodeType: 'MeshInstance',
      extends: 'Node3D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'isPlaying',
          type: 'boolean',
          ui: {
            label: 'IsPlaying',
            description: 'Whether animation starts and keeps advancing at runtime',
            group: 'Animation',
          },
          getValue: (node: unknown) => {
            const n = node as MeshInstance;
            return n.isPlaying;
          },
          setValue: (node: unknown, value: unknown) => {
            const n = node as MeshInstance;
            n.isPlaying = !!value;
          },
        },
        {
          name: 'isLoop',
          type: 'boolean',
          ui: {
            label: 'IsLoop',
            description: 'Whether animation repeats after reaching the end',
            group: 'Animation',
          },
          getValue: (node: unknown) => {
            const n = node as MeshInstance;
            return n.isLoop;
          },
          setValue: (node: unknown, value: unknown) => {
            const n = node as MeshInstance;
            n.isLoop = !!value;
          },
        },
        {
          name: 'initialAnimation',
          type: 'string',
          ui: {
            label: 'Initial Animation',
            description: 'Clip name to auto-play on scene start (uses first clip when empty)',
            group: 'Animation',
          },
          getValue: (node: unknown) => {
            const n = node as MeshInstance;
            return n.initialAnimation ?? '';
          },
          setValue: (node: unknown, value: unknown) => {
            const n = node as MeshInstance;
            const v = typeof value === 'string' ? value.trim() : '';
            n.initialAnimation = v.length > 0 ? v : null;
            n.showDefaultPose(); // Show new default at t=0 immediately in editor
          },
        },
        {
          name: 'castShadow',
          type: 'boolean',
          ui: {
            label: 'Cast Shadow',
            description: 'Whether this mesh casts shadows in the scene',
            group: 'Rendering',
          },
          getValue: (node: unknown) => {
            const n = node as MeshInstance;
            return n.castShadow;
          },
          setValue: (node: unknown, value: unknown) => {
            const n = node as MeshInstance;
            const v = !!value;
            n.castShadow = v;
            MeshInstance.applyShadowPropertiesToChildren(n, v, n.receiveShadow);
          },
        },
        {
          name: 'receiveShadow',
          type: 'boolean',
          ui: {
            label: 'Receive Shadow',
            description: 'Whether this mesh receives shadows from other objects',
            group: 'Rendering',
          },
          getValue: (node: unknown) => {
            const n = node as MeshInstance;
            return n.receiveShadow;
          },
          setValue: (node: unknown, value: unknown) => {
            const n = node as MeshInstance;
            const v = !!value;
            n.receiveShadow = v;
            MeshInstance.applyShadowPropertiesToChildren(n, n.castShadow, v);
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Animation: {
          label: 'Animation',
          description: 'Animation playback properties',
          expanded: true,
        },
        Rendering: {
          label: 'Rendering',
          description: 'Shadow and rendering properties',
          expanded: true,
        },
      },
    };
  }

  /**
   * Recursively apply shadow properties to all children meshes.
   * This ensures shadows are applied to loaded GLB models and their sub-meshes.
   */
  private static applyShadowPropertiesToChildren(
    node: Object3D,
    castShadow: boolean,
    receiveShadow: boolean
  ): void {
    if (node instanceof Mesh) {
      node.castShadow = castShadow;
      node.receiveShadow = receiveShadow;
    }

    for (const child of node.children) {
      MeshInstance.applyShadowPropertiesToChildren(child, castShadow, receiveShadow);
    }
  }

  /**
   * Apply shadow properties after loading geometry.
   * Call this after adding children from a loaded GLB/GLTF model.
   */
  applyLoadedShadowProperties(): void {
    MeshInstance.applyShadowPropertiesToChildren(this, this.castShadow, this.receiveShadow);
  }
}
