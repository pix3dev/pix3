import { Script } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import { Vector3 } from 'three';
import { BurningWreck } from './BurningWreck';

const HIT_SOUNDS = [
  'res://src/assets/audio/hits/enemy_hit1.mp3',
  'res://src/assets/audio/hits/enemy_hit2.mp3',
  'res://src/assets/audio/hits/enemy_hit3.mp3',
];
const BODY_DEATH_SOUND = 'res://src/assets/audio/explosions/big_explosion.mp3';
const PART_DEATH_SOUND = 'res://src/assets/audio/explosions/light_explosion.mp3';
const CRASH_SOUND = 'res://src/assets/audio/explosions/medium_explosion.mp3';
const EXPLOSION_PREFAB = 'res://src/assets/prefabs/explosion.pix3scene';
const WRECK_PREFAB = 'res://src/assets/prefabs/burning-wreck.pix3scene';

type PartName = 'body' | 'ropes' | 'gondola';

interface Part {
  key: PartName;
  node: NodeBase;
  hp: number;
  alive: boolean;
}

/**
 * CompoundBalloon — a GDD "Multi Unit" (Unik-class aerostat): carrier balloon
 * + ropes + armed gondola, each with its own `core:Hitbox2D` and destruction
 * scenario (GDD §Типы разрушаемых объектов):
 * - hit the CARRIER → full detonation: big explosion, the whole hull falls as
 *   a burning wreck and detonates again on impact;
 * - hit the ROPES → they snap: the balloon sails UP and away, the gondola
 *   drops as a burning wreck (and explodes on whatever it lands on);
 * - hit the GONDOLA → it blows up in place, the balloon + ropes fly away.
 * Reports kills/escape through the same game-root signals as EnemyBalloon.
 */
export class CompoundBalloon extends Script {
  private parts: Part[] = [];
  private state: 'intact' | 'flyaway' | 'gone' = 'intact';
  private flyawaySpeed = 0;
  private bobTime = 0;
  private baseY: number | null = null;
  private shoveVx = 0;
  private shoveVy = 0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      bodyHp: 100,
      ropesHp: 30,
      gondolaHp: 60,
      speed: 40,
      stopX: 0,
      score: 20,
      gondolaScore: 8,
      // Absolute castle HP a breakthrough costs (M4 scale: floors are 700..1600).
      castleDamage: 90,
      // Wreck liveries (set per unik/urik by WaveSpawner.applyCompoundUnit).
      wreckBodyTex: 'res://src/assets/textures/enemy/air/unik/unik_body.png',
      wreckGondolaTex: 'res://src/assets/textures/enemy/air/unik/unik_body.png',
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, step = 1) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Compound', step },
      getValue: (c: unknown) => (c as CompoundBalloon).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as CompoundBalloon).config[name] = Number(v);
      },
    });
    return {
      nodeType: 'CompoundBalloon',
      properties: [
        num('bodyHp', 'Body HP'),
        num('ropesHp', 'Ropes HP'),
        num('gondolaHp', 'Gondola HP'),
        num('speed', 'Speed (px/s)'),
        num('score', 'Score (full kill)'),
        num('gondolaScore', 'Score (gondola only)'),
        num('castleDamage', 'Castle Damage (HP)'),
      ],
      groups: { Compound: { label: 'Compound Balloon', expanded: true } },
    };
  }

  onStart(): void {
    const setup: Array<{ key: PartName; childName: string; hp: number }> = [
      { key: 'body', childName: 'Unik Body', hp: Number(this.config.bodyHp) },
      { key: 'ropes', childName: 'Unik Ropes', hp: Number(this.config.ropesHp) },
      { key: 'gondola', childName: 'Unik Gondola', hp: Number(this.config.gondolaHp) },
    ];
    this.parts = [];
    for (const { key, childName, hp } of setup) {
      const node = this.node?.getChildByName(childName) as NodeBase | undefined;
      if (!node) continue;
      const part: Part = { key, node, hp, alive: true };
      node.connect('damaged', this, (amount: unknown) => {
        this.onPartDamaged(part, Number(amount) || 0);
      });
      node.connect('shoved', this, (vx: unknown, vy: unknown) => {
        this.onShoved(Number(vx) || 0, Number(vy) || 0);
      });
      this.parts.push(part);
    }
    this.node?.connect('shoved', this, (vx: unknown, vy: unknown) => {
      this.onShoved(Number(vx) || 0, Number(vy) || 0);
    });
  }

  onUpdate(dt: number): void {
    const node = this.node;
    if (!node || this.state === 'gone') return;

    if (this.baseY === null) {
      this.baseY = node.position.y;
    }

    // Shockwave impulse (decays quickly).
    if (this.shoveVx !== 0 || this.shoveVy !== 0) {
      node.position.x += this.shoveVx * dt;
      this.baseY += this.shoveVy * dt;
      const damp = Math.max(0, 1 - 3 * dt);
      this.shoveVx *= damp;
      this.shoveVy *= damp;
      if (Math.abs(this.shoveVx) < 2 && Math.abs(this.shoveVy) < 2) {
        this.shoveVx = 0;
        this.shoveVy = 0;
      }
    }

    if (this.state === 'flyaway') {
      // The freed balloon sails up and slightly onward.
      this.flyawaySpeed = Math.min(90, this.flyawaySpeed + 70 * dt);
      node.position.y += this.flyawaySpeed * dt;
      node.position.x -= Number(this.config.speed) * 0.3 * dt;
      if (node.position.y > 330) {
        this.despawn();
      }
      return;
    }

    // Intact: drift toward the castle with a buoyant bob.
    this.bobTime += dt;
    const stopX = Number(this.config.stopX);
    const holding = stopX !== 0 && node.position.x <= stopX;
    if (!holding) {
      node.position.x -= Number(this.config.speed) * dt;
    }
    node.position.y = this.baseY + Math.sin(this.bobTime * 1.4) * 4;

    if (node.position.x <= -180) {
      this.crashIntoCastle();
    }
  }

  // ── destruction scenarios ─────────────────────────────────────────────────

  private onPartDamaged(part: Part, amount: number): void {
    if (this.state === 'gone' || !part.alive) return;
    part.hp -= amount;
    if (part.hp > 0) {
      const sound = HIT_SOUNDS[Math.floor(Math.random() * HIT_SOUNDS.length)];
      this.scene?.audio.play(sound, { bus: 'sfx', pitchVariation: 0.12 });
      if (this.node) this.scene?.juice.punchScale(this.node, { amount: 0.12, duration: 0.14 });
      return;
    }

    switch (part.key) {
      case 'body':
        this.detonate();
        break;
      case 'ropes':
        this.snapRopes(part);
        break;
      case 'gondola':
        this.blowGondola(part);
        break;
    }
  }

  /** Carrier hit → full detonation + the hull falls as a burning wreck. */
  private detonate(): void {
    const node = this.node;
    if (!node || this.state === 'gone') return;
    const world = this.partWorldToStage(this.findPart('body')?.node ?? node);

    this.scene?.audio.play(BODY_DEATH_SOUND, { bus: 'sfx', volumeVariation: 0.1 });
    this.spawnExplosion(world.x, world.y, 1.35);
    this.spawnWreck(
      String(this.config.wreckBodyTex),
      world.x, world.y, -Number(this.config.speed) * 0.6, -10, 1.2
    );
    this.emitToGameRoot('unit-killed', Number(this.config.score));
    this.despawn();
  }

  /** Ropes snapped → balloon flies up, gondola drops burning. */
  private snapRopes(ropes: Part): void {
    ropes.alive = false;
    ropes.node.visible = false;
    this.disableHitbox(ropes.node);

    const gondola = this.findPart('gondola');
    if (gondola?.alive) {
      gondola.alive = false;
      const world = this.partWorldToStage(gondola.node);
      gondola.node.visible = false;
      this.disableHitbox(gondola.node);
      this.spawnWreck(
        String(this.config.wreckGondolaTex),
        world.x, world.y, -14, 0, 0.8
      );
    }
    this.scene?.audio.play(PART_DEATH_SOUND, { bus: 'sfx', volumeVariation: 0.15 });
    this.emitToGameRoot('unit-killed', Number(this.config.gondolaScore));
    this.startFlyaway();
  }

  /** Gondola shot off → it explodes in place, the balloon escapes. */
  private blowGondola(gondola: Part): void {
    gondola.alive = false;
    const world = this.partWorldToStage(gondola.node);
    gondola.node.visible = false;
    this.disableHitbox(gondola.node);

    this.scene?.audio.play(PART_DEATH_SOUND, { bus: 'sfx', volumeVariation: 0.15 });
    this.spawnExplosion(world.x, world.y, 0.8);
    this.emitToGameRoot('unit-killed', Number(this.config.gondolaScore));
    this.startFlyaway();
  }

  private startFlyaway(): void {
    // The escaping balloon is no longer a target.
    for (const part of this.parts) {
      this.disableHitbox(part.node);
    }
    this.state = 'flyaway';
    this.flyawaySpeed = 20;
  }

  private crashIntoCastle(): void {
    if (this.state === 'gone') return;
    this.scene?.audio.play(CRASH_SOUND, { bus: 'sfx', volumeVariation: 0.1 });
    this.scene?.juice.shake('camera2d', { amplitude: 12, duration: 0.35 });
    this.emitToGameRoot('castle-damaged', Number(this.config.castleDamage));
    if (this.node) {
      this.spawnExplosion(this.node.position.x, this.node.position.y, 1.1);
    }
    this.despawn();
  }

  private despawn(): void {
    if (this.state === 'gone' || !this.node) return;
    this.state = 'gone';
    this.emitToGameRoot('enemy-gone');
    this.node.queueFree();
  }

  private onShoved(vx: number, vy: number): void {
    this.shoveVx += vx;
    this.shoveVy += vy;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private findPart(key: PartName): Part | undefined {
    return this.parts.find(p => p.key === key);
  }

  private disableHitbox(node: NodeBase): void {
    for (const comp of node.components) {
      if (comp.type === 'core:Hitbox2D') {
        comp.config.group = 'disabled';
      }
    }
  }

  /** Part world position → stage-local coords (effects/enemies share the stage). */
  private partWorldToStage(part: NodeBase): { x: number; y: number } {
    const parent = this.node?.parentNode;
    const world = part.getWorldPosition(CompoundBalloon.scratch);
    if (!parent) return { x: world.x, y: world.y };
    const origin = parent.getWorldPosition(CompoundBalloon.scratch2);
    const scale = parent.getWorldScale(CompoundBalloon.scratch3);
    return {
      x: (world.x - origin.x) / (Math.abs(scale.x) || 1),
      y: (world.y - origin.y) / (Math.abs(scale.y) || 1),
    };
  }

  private spawnExplosion(x: number, y: number, scale: number): void {
    void this.scene
      ?.instantiate(EXPLOSION_PREFAB, { parent: 'effects' })
      .then(fx => {
        fx.position.set(x, y, 0);
        fx.scale.set(scale, scale, 1);
      })
      .catch(err => console.warn('[CompoundBalloon] explosion failed', err));
  }

  private spawnWreck(texturePath: string, x: number, y: number, vx: number, vy: number, explosionScale: number): void {
    void this.scene
      ?.instantiate(WRECK_PREFAB, { parent: 'effects' })
      .then(wreck => {
        wreck.position.set(x, y, 0);
        BurningWreck.configure(wreck, texturePath, vx, vy, explosionScale);
      })
      .catch(err => console.warn('[CompoundBalloon] wreck failed', err));
  }

  private emitToGameRoot(signal: string, ...args: unknown[]): void {
    this.findNode('game-root')?.emit(signal, ...args);
  }

  private static readonly scratch = new Vector3();
  private static readonly scratch2 = new Vector3();
  private static readonly scratch3 = new Vector3();
}
