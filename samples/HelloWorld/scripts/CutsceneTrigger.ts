/**
 * CutsceneTrigger — drives the Cutscene Director (`scene.cutscene`).
 *
 * Enter play mode and the intro cinematic starts automatically: letterbox bars
 * slide in, gameplay input is locked, and the CameraBrain blends from the
 * gameplay camera to the cinematic camera (the clip on this node's
 * `core:AnimationPlayer` raises the cinematic vcam's priority). A "beat" event
 * key near the end punches the hero — a state-changing beat that is NOT dropped
 * even if you skip.
 *
 * While it plays, press Esc / Space / Enter (or tap the viewport) after the
 * `skippableAfter` delay to SKIP — the director fast-forwards the clip so the
 * beat still fires, then blends back to gameplay. Once it ends (finished or
 * skipped), TAP the viewport to replay it.
 *
 * This is the whole public contract:
 *
 *   const { done } = this.scene.cutscene.playCinematic(nodeId, options);
 *   await done; // 'finished' | 'skipped' | 'stopped'
 */
import { Script, type PropertySchema, type CutsceneHandle } from '@pix3/runtime';

export class CutsceneTrigger extends Script {
  private handle: CutsceneHandle | null = null;
  private elapsed = 0;
  private autoStarted = false;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      // Node hosting the cinematic's core:AnimationPlayer (empty = this node).
      target: '',
      // Clip name on that AnimationPlayer (empty = the player's default clip).
      clip: 'intro',
      // Real-time seconds before the skip gesture arms (< 0 = never skippable).
      skippableAfter: 1.5,
      // One-shot CameraBrain blend (s) into AND out of the cinematic camera.
      blendDuration: 0.8,
      // Play on entering play mode.
      autoStart: true,
      // Seconds of gameplay before the auto-start cinematic kicks in. A small
      // delay doubles as an establishing beat AND guarantees the CameraBrain has
      // started before we arm the entry blend — arming it in the very first
      // frame (e.g. straight from onStart) would be wiped by the brain's own
      // onStart, which resets its pending blend. Real games usually trigger a
      // cutscene from a gameplay event, which is naturally past that point.
      startDelay: 0.5,
      // Replay when the viewport is tapped after the cutscene ends.
      replayOnTap: true,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'CutsceneTrigger',
      properties: [
        {
          name: 'target',
          type: 'string',
          ui: {
            label: 'Target Node',
            description: 'Node with the cinematic core:AnimationPlayer (empty = this node)',
            group: 'Cutscene',
          },
          getValue: s => (s as CutsceneTrigger).config.target,
          setValue: (s, v) => {
            (s as CutsceneTrigger).config.target = typeof v === 'string' ? v : '';
          },
        },
        {
          name: 'clip',
          type: 'string',
          ui: {
            label: 'Clip',
            description: 'Clip name to play (empty = the AnimationPlayer default)',
            group: 'Cutscene',
          },
          getValue: s => (s as CutsceneTrigger).config.clip,
          setValue: (s, v) => {
            (s as CutsceneTrigger).config.clip = typeof v === 'string' ? v : '';
          },
        },
        {
          name: 'skippableAfter',
          type: 'number',
          ui: {
            label: 'Skippable After',
            description: 'Seconds before the skip gesture arms (< 0 = unskippable)',
            group: 'Cutscene',
            step: 0.1,
            precision: 2,
          },
          getValue: s => (s as CutsceneTrigger).config.skippableAfter,
          setValue: (s, v) => {
            (s as CutsceneTrigger).config.skippableAfter = Number(v);
          },
        },
        {
          name: 'blendDuration',
          type: 'number',
          ui: {
            label: 'Blend Duration',
            description: 'Camera blend (s) into and out of the cinematic',
            group: 'Cutscene',
            min: 0,
            step: 0.05,
            precision: 2,
          },
          getValue: s => (s as CutsceneTrigger).config.blendDuration,
          setValue: (s, v) => {
            (s as CutsceneTrigger).config.blendDuration = Math.max(0, Number(v));
          },
        },
        {
          name: 'autoStart',
          type: 'boolean',
          ui: {
            label: 'Auto Start',
            description: 'Play on entering play mode',
            group: 'Cutscene',
          },
          getValue: s => (s as CutsceneTrigger).config.autoStart !== false,
          setValue: (s, v) => {
            (s as CutsceneTrigger).config.autoStart = Boolean(v);
          },
        },
        {
          name: 'startDelay',
          type: 'number',
          ui: {
            label: 'Start Delay',
            description: 'Establishing-beat seconds before the auto-start cinematic',
            group: 'Cutscene',
            min: 0,
            step: 0.1,
            precision: 2,
          },
          getValue: s => (s as CutsceneTrigger).config.startDelay,
          setValue: (s, v) => {
            (s as CutsceneTrigger).config.startDelay = Math.max(0, Number(v));
          },
        },
        {
          name: 'replayOnTap',
          type: 'boolean',
          ui: {
            label: 'Replay On Tap',
            description: 'Replay when the viewport is tapped after it ends',
            group: 'Cutscene',
          },
          getValue: s => (s as CutsceneTrigger).config.replayOnTap !== false,
          setValue: (s, v) => {
            (s as CutsceneTrigger).config.replayOnTap = Boolean(v);
          },
        },
      ],
      groups: { Cutscene: { label: 'Cutscene', expanded: true } },
    };
  }

  onUpdate(dt: number): void {
    this.elapsed += dt;

    // Auto-start once, after the establishing-beat delay.
    if (this.config.autoStart !== false && !this.autoStarted) {
      const delay = Math.max(0, Number(this.config.startDelay) || 0);
      if (this.elapsed >= delay) {
        this.autoStarted = true;
        this.playCutscene();
      }
      return;
    }

    // While a cutscene runs, input is locked, so pointerEvents stays empty and
    // the tap instead reaches the director's skip gesture — no accidental
    // replay. After it ends, a tap replays it.
    if (this.config.replayOnTap === false || this.isPlaying()) {
      return;
    }
    const tapped = this.input?.pointerEvents.some(e => e.type === 'down') ?? false;
    if (tapped) {
      this.playCutscene();
    }
  }

  private isPlaying(): boolean {
    return this.handle?.isActive ?? false;
  }

  private playCutscene(): void {
    const scene = this.scene;
    if (!scene) {
      return;
    }

    const target =
      (typeof this.config.target === 'string' && this.config.target.trim()) ||
      this.node?.nodeId ||
      this.node?.name;
    if (!target) {
      console.warn('[CutsceneTrigger] No target node to play a cinematic on.');
      return;
    }

    const clip = typeof this.config.clip === 'string' ? this.config.clip.trim() : '';
    const skippableAfterRaw = Number(this.config.skippableAfter);
    const blendDuration = Math.max(0, Number(this.config.blendDuration) || 0);

    this.handle = scene.cutscene.playCinematic(target, {
      clip: clip || undefined,
      // A negative value means "never skippable" (omit the option).
      skippableAfter: skippableAfterRaw >= 0 ? skippableAfterRaw : undefined,
      blendDuration,
    });

    console.log('[CutsceneTrigger] Cinematic started.');
    void this.handle.done.then(outcome => {
      console.log(`[CutsceneTrigger] Cinematic ${outcome}. Tap the viewport to replay.`);
    });
  }
}
