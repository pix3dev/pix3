/**
 * TouchRules — turns ball contacts into meaning.
 *
 * Same role (and the same `rules` format) as in the other recipes; only the
 * source of the contact differs. Here it listens to `BallBody`'s `ball-hit`
 * signal instead of running its own overlap test, because the swept solver
 * already knows exactly what was hit and how hard.
 *
 * `ball-hit` payload: (kind, nodeId, speed, x, y) where kind is `wall`,
 * `paddle`, `bumper` or `drain`.
 *
 * It emits the same semantic signals every recipe uses, on `game-root`:
 *   `touch-scored`  (amount, x, y)
 *   `touch-damaged` (amount, x, y)
 *
 * `rules` format: `kind:outcome:amount`, entries separated by `;`.
 */
import { Script, type PropertySchema } from '@pix3/runtime';

type TouchOutcome = 'score' | 'damage';

interface TouchRule {
  kind: string;
  outcome: TouchOutcome;
  amount: number;
}

function parseRules(text: string): Map<string, TouchRule> {
  const rules = new Map<string, TouchRule>();
  for (const entry of text.split(';')) {
    const parts = entry.trim().split(':');
    if (parts.length < 2 || !parts[0].trim()) {
      continue;
    }
    const amount = Number(parts[2] ?? 1);
    rules.set(parts[0].trim(), {
      kind: parts[0].trim(),
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
      // Node carrying BallBody.
      ballNode: 'ball',
      // kind:outcome:amount pairs, separated by ';'.
      rules: 'bumper:score:100;paddle:score:10;drain:damage:1',
      // Ignore contacts softer than this (px/s) so a resting ball scores nothing.
      minImpactSpeed: 60,
      scoreSound: '',
      damageSound: '',
    };
  }

  static getPropertySchema(): PropertySchema {
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
        str('ballNode', 'Ball Node', 'Contact'),
        str('rules', 'Rules', 'Contact'),
        {
          name: 'minImpactSpeed',
          type: 'number',
          ui: { label: 'Min Impact Speed', group: 'Contact', min: 0, max: 2000, step: 10, slider: true },
          getValue: s => (s as TouchRules).config.minImpactSpeed,
          setValue: (s, v) => {
            const n = Number(v);
            (s as TouchRules).config.minImpactSpeed = Math.min(2000, Math.max(0, Number.isFinite(n) ? n : 0));
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

  onStart(): void {
    const ball = this.findNode(String(this.config.ballNode ?? ''));
    if (!ball) {
      console.warn(`[TouchRules] Ball node "${this.config.ballNode}" not found.`);
      return;
    }
    ball.connect('ball-hit', this, (...args: unknown[]) =>
      this.resolve(String(args[0] ?? ''), String(args[1] ?? ''), Number(args[2]) || 0, Number(args[3]) || 0, Number(args[4]) || 0)
    );
  }

  private resolve(kind: string, nodeId: string, speed: number, x: number, y: number): void {
    const rule = parseRules(String(this.config.rules ?? '')).get(kind);
    const scene = this.scene;
    const owner = this.node;
    if (!rule || !scene || !owner) {
      return;
    }
    if (kind !== 'drain' && speed < Math.max(0, Number(this.config.minImpactSpeed) || 0)) {
      return;
    }

    if (rule.outcome === 'damage') {
      owner.emit('touch-damaged', rule.amount, x, y);
      scene.juice.flash({ color: '#ff4d6d', intensity: 0.4, durationSec: 0.22 });
      this.playSound(String(this.config.damageSound ?? ''));
      return;
    }

    owner.emit('touch-scored', rule.amount, x, y);
    const target = nodeId ? this.findNode(nodeId) : null;
    if (target) {
      scene.juice.punchScale(target, { amount: 0.28, duration: 0.22 });
    }
    this.playSound(String(this.config.scoreSound ?? ''));
  }

  private playSound(path: string): void {
    if (!path) {
      return;
    }
    void this.scene?.audio.play(path, { bus: 'sfx', pitchVariation: 0.08 });
  }
}
