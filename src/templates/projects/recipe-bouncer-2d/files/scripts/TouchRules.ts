/**
 * TouchRules — turns ball contacts into meaning, and into feel.
 *
 * Same role (and the same `rules` format) as in the other recipes; only the
 * source of the contact differs. Here it listens to `BallBody`'s `ball-hit`
 * signal instead of running its own overlap test, because the swept solver
 * already knows exactly what was hit and how hard.
 *
 * `ball-hit` payload: (kind, nodeId, speed, x, y) where kind is `wall`,
 * `paddle`, `bumper` or `drain`. `x`/`y` are WORLD coordinates, which is why the
 * particles and the score popup can be spawned straight at the contact point.
 *
 * It emits the same semantic signals every recipe uses, on `game-root`:
 *   `touch-scored`  (amount, x, y)
 *   `touch-damaged` (amount, x, y)
 *
 * `rules` format: `kind:outcome:amount`, entries separated by `;`.
 *
 * The feel is all engine one-liners — copy them next to whatever mechanic you
 * add, they cost nothing to call:
 *   `scene.audio.sfx('score')`        procedural SFX, no asset needed
 *   `scene.juice.burst({x, y})`       2D particles that free themselves
 *   `scene.juice.floatText('+100')`   score popup
 *   `scene.juice.punchScale(node)` / `flash` / `shake` / `scene.time.hitstop`
 * Spawn them at BOARD-space anchors (a node or the hit point) rather than on the
 * HUD: the HUD is a CanvasLayer2D drawn after post-processing, so effects
 * parented there never bloom.
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
      // Feel. Raise for arcade, drop to 0 to switch a piece of it off.
      punchAmount: 0.34,
      hitstopMs: 50,
      burstCount: 18,
      popupFormat: '+{value}',
      feedbackColor: '#ffe066',
      sfxEnabled: true,
      // Optional asset overrides. When set they REPLACE the synth preset.
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
    const num = (name: string, label: string, min: number, max: number, step: number) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Feel', min, max, step, slider: true },
      getValue: (s: unknown) => (s as TouchRules).config[name],
      setValue: (s: unknown, v: unknown) => {
        const n = Number(v);
        (s as TouchRules).config[name] = Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
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
        num('punchAmount', 'Punch Scale', 0, 1, 0.01),
        num('hitstopMs', 'Hitstop (ms)', 0, 200, 5),
        num('burstCount', 'Burst Particles', 0, 120, 1),
        str('popupFormat', 'Score Popup', 'Feel'),
        str('feedbackColor', 'Feedback Colour', 'Feel'),
        {
          name: 'sfxEnabled',
          type: 'boolean',
          ui: { label: 'Sound', group: 'Feedback' },
          getValue: s => (s as TouchRules).config.sfxEnabled,
          setValue: (s, v) => {
            (s as TouchRules).config.sfxEnabled = Boolean(v);
          },
        },
        str('scoreSound', 'Score Sound', 'Feedback', 'audio-resource'),
        str('damageSound', 'Damage Sound', 'Feedback', 'audio-resource'),
      ],
      groups: {
        Contact: { label: 'Contact', expanded: true },
        Feel: { label: 'Feel', expanded: true },
        Feedback: { label: 'Sound', expanded: false },
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
    const scene = this.scene;
    const owner = this.node;
    if (!scene || !owner) {
      return;
    }
    // A resting ball rattling on the paddle must not score — or click.
    if (kind !== 'drain' && speed < Math.max(0, Number(this.config.minImpactSpeed) || 0)) {
      return;
    }

    const rule = parseRules(String(this.config.rules ?? '')).get(kind);
    // Every contact is audible, including the walls the rules say nothing about.
    this.playContactSound(kind, rule?.outcome ?? null, speed);
    if (!rule) {
      return;
    }

    if (rule.outcome === 'damage') {
      owner.emit('touch-damaged', rule.amount, x, y);
      scene.juice.flash({ color: '#ff2d6f', intensity: 0.45, durationSec: 0.24 });
      // The board is safe to shake here: BallBody freezes the ball for
      // `resetDelaySec` after a drain, so no collider moves under a live ball.
      scene.juice.shake('board', { amplitude: 26, frequency: 22, duration: 0.3 });
      this.burst(x, y, { colors: ['#ff2d6f', '#ffffff'], scale: 1, speed: 320 });
      return;
    }

    owner.emit('touch-scored', rule.amount, x, y);
    const target = nodeId ? this.findNode(nodeId) : null;
    if (target) {
      const amount = Math.max(0, Number(this.config.punchAmount) || 0);
      if (amount > 0) {
        scene.juice.punchScale(target, { amount, duration: 0.24 });
      }
    }
    // Hitstop is the bumper's weight — the paddle is touched constantly and
    // would stutter the whole run.
    if (kind === 'bumper') {
      scene.time.hitstop(Math.max(0, Number(this.config.hitstopMs) || 0));
    }
    const accent = this.accentColor();
    this.burst(x, y, {
      colors: ['#ffffff', accent],
      scale: kind === 'bumper' ? 1 : 0.5,
      speed: kind === 'bumper' ? 420 : 260,
    });
    this.popup(rule.amount, x, y, accent);
  }

  private accentColor(): string {
    const color = String(this.config.feedbackColor ?? '').trim();
    return color.length > 0 ? color : '#ffe066';
  }

  /** Contact particles at the hit point (world space, so they bloom with the board). */
  private burst(
    x: number,
    y: number,
    options: { colors: string[]; scale: number; speed: number }
  ): void {
    const count = Math.round(Math.max(0, Number(this.config.burstCount) || 0) * options.scale);
    if (count <= 0) {
      return;
    }
    this.scene?.juice.burst(
      { x, y },
      { count, colors: options.colors, speed: options.speed, sizePx: 12, lifeSec: 0.45 }
    );
  }

  /** "+100" rising off the contact. Empty `popupFormat` switches it off. */
  private popup(amount: number, x: number, y: number, color: string): void {
    const format = String(this.config.popupFormat ?? '');
    if (!format) {
      return;
    }
    this.scene?.juice.floatText(format.replace('{value}', String(Math.round(amount))), {
      at: { x, y },
      color,
      fontSizePx: 42,
      glow: true,
      glowStrength: 2,
    });
  }

  /**
   * An asset wins when one is authored; otherwise the procedural preset plays,
   * so a fresh project has sound with no audio files at all. Bounces are
   * pitched by impact speed — the cheapest "harder hit = brighter sound" there is.
   */
  private playContactSound(kind: string, outcome: TouchOutcome | null, speed: number): void {
    if (this.config.sfxEnabled === false) {
      return;
    }
    const damage = outcome === 'damage';
    const asset = String((damage ? this.config.damageSound : this.config.scoreSound) ?? '');
    if (asset && (damage || outcome === 'score')) {
      void this.scene?.audio.play(asset, { bus: 'sfx', pitchVariation: 0.08 });
      return;
    }
    if (damage) {
      this.scene?.audio.sfx('lose', { volume: 0.9 });
      return;
    }
    if (kind === 'bumper') {
      this.scene?.audio.sfx('score', { pitch: 1 + Math.random() * 0.12 });
      return;
    }
    const pitch = Math.min(1.5, Math.max(0.8, 0.85 + speed / 3200));
    this.scene?.audio.sfx('bounce', { pitch, volume: 0.8 });
  }
}
