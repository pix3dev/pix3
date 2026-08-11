/**
 * TouchRules — turns contact into meaning.
 *
 * Every frame it overlap-tests a circle around the player against the
 * `core:Hitbox2D` groups listed in `rules`, and for each hit emits a SEMANTIC
 * signal on its own node (`game-root`):
 *
 *   `touch-scored`  (amount, x, y)
 *   `touch-damaged` (amount, x, y)
 *
 * It never touches the score, the lives or the HUD — `GameRules` owns those and
 * listens for these two signals. Add an outcome by adding a rule here and a
 * listener there; nothing else has to change.
 *
 * `rules` format: `group:outcome:amount`, entries separated by `;`.
 * Outcomes: `score` | `damage`. Example: `pickup:score:1;hazard:damage:1`.
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
    const outcome: TouchOutcome = parts[1].trim() === 'damage' ? 'damage' : 'score';
    const amount = Number(parts[2] ?? 1);
    rules.push({
      group: parts[0].trim(),
      outcome,
      amount: Number.isFinite(amount) && amount > 0 ? amount : 1,
    });
  }
  return rules;
}

export class TouchRules extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      // Node id/name whose world position is the centre of the overlap test.
      playerNode: 'player',
      // Radius of the overlap test, in logical pixels.
      touchRadius: 62,
      // group:outcome:amount pairs, separated by ';'.
      rules: 'pickup:score:1;hazard:damage:1',
      // Free the touched node after resolving it.
      consume: true,
      // res:// audio paths; empty = silent.
      scoreSound: '',
      damageSound: '',
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'TouchRules',
      properties: [
        {
          name: 'playerNode',
          type: 'string',
          ui: { label: 'Player Node', group: 'Contact' },
          getValue: s => (s as TouchRules).config.playerNode,
          setValue: (s, v) => {
            (s as TouchRules).config.playerNode = typeof v === 'string' ? v : '';
          },
        },
        {
          name: 'touchRadius',
          type: 'number',
          ui: { label: 'Touch Radius', group: 'Contact', min: 4, max: 600, step: 1, slider: true },
          getValue: s => (s as TouchRules).config.touchRadius,
          setValue: (s, v) => {
            const n = Number(v);
            (s as TouchRules).config.touchRadius = Math.min(600, Math.max(4, Number.isFinite(n) ? n : 4));
          },
        },
        {
          name: 'rules',
          type: 'string',
          ui: {
            label: 'Rules',
            description: "group:outcome:amount, ';'-separated. Outcome is score or damage.",
            group: 'Contact',
          },
          getValue: s => (s as TouchRules).config.rules,
          setValue: (s, v) => {
            (s as TouchRules).config.rules = typeof v === 'string' ? v : '';
          },
        },
        {
          name: 'consume',
          type: 'boolean',
          ui: { label: 'Consume On Touch', group: 'Contact' },
          getValue: s => (s as TouchRules).config.consume,
          setValue: (s, v) => {
            (s as TouchRules).config.consume = Boolean(v);
          },
        },
        {
          name: 'scoreSound',
          type: 'string',
          ui: { label: 'Score Sound', group: 'Feedback', editor: 'audio-resource' },
          getValue: s => (s as TouchRules).config.scoreSound,
          setValue: (s, v) => {
            (s as TouchRules).config.scoreSound = typeof v === 'string' ? v : '';
          },
        },
        {
          name: 'damageSound',
          type: 'string',
          ui: { label: 'Damage Sound', group: 'Feedback', editor: 'audio-resource' },
          getValue: s => (s as TouchRules).config.damageSound,
          setValue: (s, v) => {
            (s as TouchRules).config.damageSound = typeof v === 'string' ? v : '';
          },
        },
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
    const player = this.findNode(String(this.config.playerNode ?? ''));
    if (!scene || !owner || !player) {
      return;
    }

    player.updateWorldMatrix(true, false);
    const px = player.matrixWorld.elements[12];
    const py = player.matrixWorld.elements[13];
    const radius = Math.max(1, Number(this.config.touchRadius) || 1);
    const consume = Boolean(this.config.consume);

    for (const rule of parseRules(String(this.config.rules ?? ''))) {
      for (const hit of scene.collision2d.overlapCircle(px, py, radius, rule.group)) {
        if (rule.outcome === 'damage') {
          owner.emit('touch-damaged', rule.amount, hit.x, hit.y);
          scene.juice.shake(player, { amplitude: 16, duration: 0.25 });
          scene.juice.flash({ color: '#ff4d6d', intensity: 0.4, durationSec: 0.22 });
          this.playSound(String(this.config.damageSound ?? ''));
        } else {
          owner.emit('touch-scored', rule.amount, hit.x, hit.y);
          scene.juice.punchScale(player, { amount: 0.22, duration: 0.22 });
          this.playSound(String(this.config.scoreSound ?? ''));
        }
        if (consume) {
          hit.node.queueFree();
        }
      }
    }
  }

  private playSound(path: string): void {
    if (!path) {
      return;
    }
    void this.scene?.audio.play(path, { bus: 'sfx', pitchVariation: 0.08 });
  }
}
