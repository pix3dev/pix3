/**
 * TouchRules — turns a tap into meaning.
 *
 * Same role (and the same `rules` format) as in the other recipes; only the
 * source of the contact differs. Here a pointer-down is hit-tested against the
 * `core:Hitbox2D` groups listed in `rules` and the topmost match resolves.
 *
 * It emits the same semantic signals every recipe uses, on `game-root`:
 *   `touch-scored`  (amount, x, y)
 *   `touch-damaged` (amount, x, y)
 *
 * `rules` format: `group:outcome:amount`, entries separated by `;`.
 * A tap that hits nothing can be punished too — see `missPenalty`.
 */
import { Script, type PropertySchema } from '@pix3/runtime';

type TouchOutcome = 'score' | 'damage';

interface TouchRule {
  group: string;
  outcome: TouchOutcome;
  amount: number;
}

function parseRules(text: string): TouchRule[] {
  const rules: TouchRule[] = [];
  for (const entry of text.split(';')) {
    const parts = entry.trim().split(':');
    if (parts.length < 2 || !parts[0].trim()) {
      continue;
    }
    const amount = Number(parts[2] ?? 1);
    rules.push({
      group: parts[0].trim(),
      outcome: parts[1].trim() === 'damage' ? 'damage' : 'score',
      amount: Number.isFinite(amount) && amount > 0 ? amount : 1,
    });
  }
  return rules;
}

export class TouchRules extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      // group:outcome:amount pairs, separated by ';'.
      rules: 'target:score:1;hazard:damage:1',
      // 0 = exact point test; larger = a more forgiving finger.
      tapRadius: 40,
      // Free the tapped node after resolving it.
      consume: true,
      // Damage dealt by a tap that hits nothing (0 = free misses).
      missPenalty: 0,
      scoreSound: '',
      damageSound: '',
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, min: number, max: number, step: number) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Contact', min, max, step, slider: true },
      getValue: (s: unknown) => (s as TouchRules).config[name],
      setValue: (s: unknown, v: unknown) => {
        const n = Number(v);
        (s as TouchRules).config[name] = Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
      },
    });
    const str = (name: string, label: string, group: string, editor?: 'audio-resource') => ({
      name,
      type: 'string' as const,
      ui: { label, group, editor },
      getValue: (s: unknown) => (s as TouchRules).config[name],
      setValue: (s: unknown, v: unknown) => {
        (s as TouchRules).config[name] = typeof v === 'string' ? v : '';
      },
    });

    return {
      nodeType: 'TouchRules',
      properties: [
        str('rules', 'Rules', 'Contact'),
        num('tapRadius', 'Tap Radius', 0, 400, 1),
        num('missPenalty', 'Miss Penalty', 0, 10, 1),
        {
          name: 'consume',
          type: 'boolean',
          ui: { label: 'Consume On Tap', group: 'Contact' },
          getValue: s => (s as TouchRules).config.consume,
          setValue: (s, v) => {
            (s as TouchRules).config.consume = Boolean(v);
          },
        },
        str('scoreSound', 'Score Sound', 'Feedback', 'audio-resource'),
        str('damageSound', 'Damage Sound', 'Feedback', 'audio-resource'),
      ],
      groups: {
        Contact: { label: 'Contact', expanded: true },
        Feedback: { label: 'Feedback', expanded: false },
      },
    };
  }

  onUpdate(): void {
    const scene = this.scene;
    const owner = this.node;
    const tapped = this.input?.pointerEvents.some(event => event.type === 'down') ?? false;
    if (!scene || !owner || !tapped || this.input?.isHoveringUI) {
      return;
    }
    const pointer = scene.getPointer2DWorldPosition();
    if (!pointer) {
      return;
    }

    const radius = Math.max(0, Number(this.config.tapRadius) || 0);
    const consume = Boolean(this.config.consume);

    for (const rule of parseRules(String(this.config.rules ?? ''))) {
      const hits =
        radius > 0
          ? scene.collision2d.overlapCircle(pointer.x, pointer.y, radius, rule.group)
          : scene.collision2d.overlapPoint(pointer.x, pointer.y, rule.group);
      // Only the first match resolves: one tap is one action.
      const hit = hits[0];
      if (!hit) {
        continue;
      }
      if (rule.outcome === 'damage') {
        owner.emit('touch-damaged', rule.amount, hit.x, hit.y);
        scene.juice.flash({ color: '#ff4d6d', intensity: 0.4, durationSec: 0.22 });
        this.playSound(String(this.config.damageSound ?? ''));
      } else {
        owner.emit('touch-scored', rule.amount, hit.x, hit.y);
        scene.juice.punchScale(hit.node, { amount: 0.3, duration: 0.18 });
        this.playSound(String(this.config.scoreSound ?? ''));
      }
      if (consume) {
        hit.node.queueFree();
      }
      return;
    }

    const penalty = Math.max(0, Number(this.config.missPenalty) || 0);
    if (penalty > 0) {
      owner.emit('touch-damaged', penalty, pointer.x, pointer.y);
      this.playSound(String(this.config.damageSound ?? ''));
    }
  }

  private playSound(path: string): void {
    if (!path) {
      return;
    }
    void this.scene?.audio.play(path, { bus: 'sfx', pitchVariation: 0.08 });
  }
}
