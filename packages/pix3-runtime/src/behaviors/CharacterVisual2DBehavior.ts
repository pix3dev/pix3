import { Script } from '../core/ScriptComponent';
import { defineProperty } from '../fw/property-schema';
import type { NodeBase } from '../nodes/NodeBase';
import { AnimatedSprite2D } from '../nodes/2D/AnimatedSprite2D';

export interface PlayStateOptions {
  /** Start the state's clip from frame 0 even when it is already showing (a repeated attack). */
  restart?: boolean;
}

/** Signal emitted on the host node when the current state's non-looping clip ends. */
export const CHARACTER_STATE_FINISHED_SIGNAL = 'state-finished';

/**
 * CharacterVisual2D — resolves `variant + state → clip` on an `AnimatedSprite2D`
 * whose clips follow the naming convention `<variant><separator><state>`
 * (`sword.idle`, `sword.attack`, `bow.idle`, …; a clip with no separator is a
 * variant-less state). It is the engine's counterpart of Unity's Sprite Library
 * categories/labels + Sprite Resolver: swap the *skin* (weapon, outfit) while
 * the *state* vocabulary stays the same, so game code says `playState('attack')`
 * and never spells a clip name.
 *
 * Deliberately thin: no movement, physics, AI, damage or automatic transitions
 * — a finished one-shot holds its last frame and emits `state-finished`
 * (state, variant); the game decides what comes next. No new file format: the
 * mapping IS the clip names of the `.pix3anim`, and the chosen variant/state live
 * in this component's config inside the prefab, so a Store character is
 * self-contained and `pix3 validate` already checks it.
 */
export class CharacterVisual2DBehavior extends Script {
  /** Current variant (`sword`); empty = clips are named by state alone. */
  variant = '';
  /** State to show; on start it is played (`idle`). */
  state = '';
  /** Text between variant and state in clip names. */
  separator = '.';
  /**
   * Node id of the AnimatedSprite2D to drive. Empty = the host node itself when it
   * is an AnimatedSprite2D, else its first AnimatedSprite2D child (the prefab
   * shape `Group2D root → AnimatedSprite2D Visual`).
   */
  spriteNodeId = '';

  private sprite: AnimatedSprite2D | null = null;
  private warnedMissingSprite = false;

  private readonly onAnimationFinished = (clipName: unknown): void => {
    if (!this.node || typeof clipName !== 'string' || clipName !== this.currentClipName()) {
      return;
    }
    this.node.emit(CHARACTER_STATE_FINISHED_SIGNAL, this.state, this.variant);
  };

  static override getPropertySchema() {
    return {
      nodeType: 'CharacterVisual2DBehavior',
      properties: [
        defineProperty('variant', 'string', {
          ui: {
            label: 'Variant',
            description: 'Clip-name prefix (sword, bow). Empty when clips are named by state alone',
            group: 'Character',
          },
          getValue: (c: unknown) => (c as CharacterVisual2DBehavior).variant,
          setValue: (c: unknown, v: unknown) => {
            (c as CharacterVisual2DBehavior).variant = String(v ?? '').trim();
          },
        }),
        defineProperty('state', 'string', {
          ui: { label: 'State', description: 'State played on start (idle)', group: 'Character' },
          getValue: (c: unknown) => (c as CharacterVisual2DBehavior).state,
          setValue: (c: unknown, v: unknown) => {
            (c as CharacterVisual2DBehavior).state = String(v ?? '').trim();
          },
        }),
        defineProperty('separator', 'string', {
          ui: {
            label: 'Separator',
            description: 'Text between variant and state in clip names',
            group: 'Character',
          },
          getValue: (c: unknown) => (c as CharacterVisual2DBehavior).separator,
          setValue: (c: unknown, v: unknown) => {
            const next = String(v ?? '');
            (c as CharacterVisual2DBehavior).separator = next.length > 0 ? next : '.';
          },
        }),
        defineProperty('spriteNodeId', 'string', {
          ui: {
            label: 'Sprite Node',
            description: 'AnimatedSprite2D to drive; empty = this node or its first sprite child',
            group: 'Character',
          },
          getValue: (c: unknown) => (c as CharacterVisual2DBehavior).spriteNodeId,
          setValue: (c: unknown, v: unknown) => {
            (c as CharacterVisual2DBehavior).spriteNodeId = String(v ?? '').trim();
          },
        }),
      ],
      groups: {
        Character: {
          label: 'Character',
          description: 'variant + state → clip on the AnimatedSprite2D',
          expanded: true,
        },
      },
    };
  }

  onStart(): void {
    this.bind();
    if (this.state) {
      this.playState(this.state);
    }
  }

  override onDetach(): void {
    this.unbind();
    super.onDetach();
  }

  /** Clip name for a variant/state pair under this component's convention. */
  clipNameFor(variant: string, state: string): string {
    return variant ? `${variant}${this.separator}${state}` : state;
  }

  /** The clip the current variant/state resolves to. */
  currentClipName(): string {
    return this.clipNameFor(this.variant, this.state);
  }

  /** The driven sprite, resolved lazily (`null` when none is reachable). */
  getSprite(): AnimatedSprite2D | null {
    if (!this.sprite) {
      this.sprite = this.resolveSprite();
    }
    return this.sprite;
  }

  /**
   * Show a state under the current variant. Returns `false` — leaving the
   * previous state playing — when the sprite's resource has no such clip; no
   * hidden fallback. `restart` replays a state that is already showing from
   * frame 0 (a second attack).
   */
  playState(state: string, options: PlayStateOptions = {}): boolean {
    const nextState = state.trim();
    const sprite = this.getSprite();
    if (!nextState || !sprite) {
      return false;
    }
    if (!sprite.play(this.clipNameFor(this.variant, nextState), { restart: options.restart })) {
      return false;
    }
    this.state = nextState;
    return true;
  }

  /**
   * Switch variant, keeping the state: the matching clip starts again from
   * frame 0. Refused (`false`, nothing changes) when the sprite has no clip for
   * the pair.
   */
  setVariant(variant: string): boolean {
    const nextVariant = variant.trim();
    const sprite = this.getSprite();
    if (!sprite) {
      return false;
    }
    if (this.state) {
      if (!sprite.play(this.clipNameFor(nextVariant, this.state), { restart: true })) {
        return false;
      }
    }
    this.variant = nextVariant;
    return true;
  }

  /** Variants the sprite's clips define, in first-seen order (`''` for variant-less clips). */
  getVariants(): string[] {
    const seen = new Set<string>();
    for (const { variant } of this.parsedClips()) {
      seen.add(variant);
    }
    return [...seen];
  }

  /** States defined for a variant (defaults to the current one), in first-seen order. */
  getStates(variant: string = this.variant): string[] {
    const seen = new Set<string>();
    for (const clip of this.parsedClips()) {
      if (clip.variant === variant) {
        seen.add(clip.state);
      }
    }
    return [...seen];
  }

  private parsedClips(): { variant: string; state: string }[] {
    const sprite = this.getSprite();
    if (!sprite) {
      return [];
    }
    return sprite.getClipNames().map(name => {
      const at = name.indexOf(this.separator);
      return at > 0
        ? { variant: name.slice(0, at), state: name.slice(at + this.separator.length) }
        : { variant: '', state: name };
    });
  }

  private resolveSprite(): AnimatedSprite2D | null {
    const host = this.node;
    if (!host) {
      return null;
    }
    let sprite: NodeBase | null = null;
    if (this.spriteNodeId) {
      sprite = this.scene?.findNodeById(this.spriteNodeId) ?? null;
    } else if (host instanceof AnimatedSprite2D) {
      sprite = host;
    } else {
      sprite = host.children.find(child => child instanceof AnimatedSprite2D) ?? null;
    }
    if (sprite instanceof AnimatedSprite2D) {
      return sprite;
    }
    if (!this.warnedMissingSprite) {
      this.warnedMissingSprite = true;
      console.warn(
        `[CharacterVisual2D] No AnimatedSprite2D to drive on node ${host.nodeId}` +
          (this.spriteNodeId ? ` (spriteNodeId "${this.spriteNodeId}" not found)` : '')
      );
    }
    return null;
  }

  private bind(): void {
    const sprite = this.getSprite();
    sprite?.connect('animation-finished', this, this.onAnimationFinished);
  }

  private unbind(): void {
    this.sprite?.disconnect('animation-finished', this, this.onAnimationFinished);
    this.sprite = null;
  }
}
