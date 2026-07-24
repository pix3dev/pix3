import { Script } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';

const EXPLOSION_PREFAB = 'res://src/assets/prefabs/explosion.pix3scene';
const QUEST_CARGO_PREFAB = 'res://src/assets/prefabs/quest-cargo.pix3scene';
const HIT_SOUNDS = [
  'res://src/assets/audio/hits/enemy_hit1.mp3',
  'res://src/assets/audio/hits/enemy_hit2.mp3',
  'res://src/assets/audio/hits/enemy_hit3.mp3',
];
const DEATH_SOUND = 'res://src/assets/audio/explosions/explosion.mp3';
const DROP_SOUND = 'res://src/assets/audio/explosions/light_explosion.mp3';

/** Stage-local x past the castle where a crossing NPC leaves the field. */
const LEFT_EXIT = -460;

/**
 * QuestNpc — one generic behaviour for every Sky Defender quest NPC (v15 ids
 * 63-74). The visual composition (body + optional cargo) is baked into the
 * generic `quest-npc.pix3scene`; WaveSpawner.applyNpcStats pushes the per-id
 * stats + per-level questId/container rect on top. Three roles:
 *
 * - **protect** (MFargo/MWife/MBob/MEngin/MGold): a friendly that crosses the
 *   field. Leaving alive → `quest-npc-safe {questId}`; shot dead → a small death
 *   fx + `quest-npc-lost {questId}` (the tension: don't hit the ones you guard).
 * - **carrier** (MLuckyGold/MPolicek/MSheep/MZombee): flies with a payload child
 *   (gold bar / cone / sheep, own `enemy` hitbox). Shoot the PAYLOAD and it
 *   detaches into free fall (see QuestCargo): landing inside the container rect →
 *   `quest-cargo-saved`, else `quest-cargo-lost`. The carrier keeps flying;
 *   killing it (or it escaping) while it still holds the cargo is a cargo loss.
 * - **combat** (MTurik/MLucky/MFargoWar): a plain enemy — just needs to die.
 *
 * Standard game-root signal contract for wave accounting: emits `unit-killed`
 * (score) on death and `enemy-gone` on any despawn (like every other enemy), so
 * WaveSpawner.isWaveClear works unchanged. Emits `quest-npc-spawned` on start.
 *
 * NOTE: quest NPCs always TRAVERSE the field (stopX is carried for reference but
 * not used to park) — parking would stall wave-clear, and the near-zero original
 * speeds of MGold/MLuckyGold are floored by the spawner so they still cross.
 */
export class QuestNpc extends Script {
  private hp = 0;
  private payloadHp = 0;
  private bobTime = 0;
  private baseY: number | null = null;
  private state: 'alive' | 'gone' = 'alive';
  private hasCargo = false;
  private bodyNode: NodeBase | null = null;
  private cargoNode: NodeBase | null = null;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      hp: 100,
      speed: 60,
      score: 0,
      // Reference only (quest NPCs traverse; they do not park at stopX).
      stopX: 0,
      // 'protect' | 'carrier' | 'combat'.
      role: 'combat',
      // Cargo class: 0 none, 10 gold bar, 11 sheep, 12 cone/apple.
      payloadType: 0,
      payloadHp: 1,
      // Texture the falling cargo reuses (set by WaveSpawner per payload).
      payloadTex: '',
      // Per-level quest identity + friendly name (set by WaveSpawner).
      questId: '',
      npcName: '',
      // Stage-local landing rect for a carrier's cargo (boat / cup / truck).
      containerX: 0,
      containerY: -170,
      containerW: 360,
      containerH: 90,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, step = 1) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Quest NPC', step },
      getValue: (c: unknown) => (c as QuestNpc).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as QuestNpc).config[name] = Number(v);
      },
    });
    const str = (name: string, label: string) => ({
      name,
      type: 'string' as const,
      ui: { label, group: 'Quest NPC' },
      getValue: (c: unknown) => (c as QuestNpc).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as QuestNpc).config[name] = String(v);
      },
    });
    return {
      nodeType: 'QuestNpc',
      properties: [
        num('hp', 'HP'),
        num('speed', 'Speed (px/s)'),
        num('score', 'Score'),
        str('role', 'Role (protect/carrier/combat)'),
        num('payloadType', 'Payload (0/10/11/12)'),
        num('payloadHp', 'Payload HP'),
        str('questId', 'Quest Id'),
        str('npcName', 'NPC Name'),
        num('containerX', 'Container X'),
        num('containerY', 'Container Y'),
        num('containerW', 'Container W'),
        num('containerH', 'Container H'),
      ],
      groups: { 'Quest NPC': { label: 'Quest NPC', expanded: true } },
    };
  }

  onStart(): void {
    this.hp = Number(this.config.hp);
    this.payloadHp = Number(this.config.payloadHp);

    // The `enemy` hitbox lives on the NPC Body child (so player fire + turrets
    // hit it), so the `damaged` signal fires there (see boss.pix3scene pattern).
    this.bodyNode = (this.node?.getChildByName('NPC Body') as NodeBase | undefined) ?? null;
    (this.bodyNode ?? this.node)?.connect('damaged', this, (amount: unknown) => {
      this.onBodyDamaged(Number(amount) || 0);
    });

    // Cargo child: only carriers keep it (with its own `enemy` hitbox); everyone
    // else hides it + silences its hitbox.
    this.cargoNode = (this.node?.getChildByName('Cargo') as NodeBase | undefined) ?? null;
    if (this.isCarrier() && this.cargoNode) {
      this.hasCargo = true;
      this.cargoNode.visible = true;
      this.cargoNode.connect('damaged', this, (amount: unknown) => {
        this.onCargoDamaged(Number(amount) || 0);
      });
    } else if (this.cargoNode) {
      this.cargoNode.visible = false;
      this.disableHitboxes(this.cargoNode);
    }

    this.emitToGameRoot('quest-npc-spawned', {
      questId: String(this.config.questId),
      npcName: String(this.config.npcName),
      role: String(this.config.role),
    });
  }

  onUpdate(dt: number): void {
    const node = this.node;
    if (!node || this.state === 'gone') return;
    if (this.baseY === null) this.baseY = node.position.y;

    this.bobTime += dt;
    node.position.x -= Number(this.config.speed) * dt;
    node.position.y = this.baseY + Math.sin(this.bobTime * 1.7) * 4;

    if (node.position.x < LEFT_EXIT) this.leaveField();
  }

  private isCarrier(): boolean {
    return this.config.role === 'carrier';
  }

  // ── damage ──────────────────────────────────────────────────────────────────

  private onBodyDamaged(amount: number): void {
    if (this.state === 'gone') return;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.die();
      return;
    }
    this.hitFeedback();
  }

  private onCargoDamaged(amount: number): void {
    if (this.state === 'gone' || !this.hasCargo) return;
    this.payloadHp -= amount;
    if (this.payloadHp <= 0) {
      this.detachCargo();
      return;
    }
    this.hitFeedback();
  }

  private hitFeedback(): void {
    const sound = HIT_SOUNDS[Math.floor(Math.random() * HIT_SOUNDS.length)];
    this.scene?.audio.play(sound, { bus: 'sfx', pitchVariation: 0.12 });
    if (this.node) this.scene?.juice.punchScale(this.node, { amount: 0.2, duration: 0.15 });
  }

  // ── cargo detach → free fall ─────────────────────────────────────────────────

  /** The payload was shot off: spawn the falling cargo, then keep flying empty. */
  private detachCargo(): void {
    const scene = this.scene;
    const node = this.node;
    const cargo = this.cargoNode;
    if (!scene || !node || !cargo) return;
    this.hasCargo = false;
    const x = node.position.x + cargo.position.x;
    const y = node.position.y + cargo.position.y;
    cargo.visible = false;
    this.disableHitboxes(cargo);
    this.scene?.audio.play(DROP_SOUND, { bus: 'sfx', pitchVariation: 0.15 });
    // Tell the tracker a payload is airborne (it holds wave-clear until the cargo
    // lands and reports saved/lost — otherwise evaluation would race the fall).
    this.emitToGameRoot('quest-cargo-dropped', { questId: String(this.config.questId) });

    void scene
      .instantiate(QUEST_CARGO_PREFAB, { parent: 'effects' })
      .then(dropped => {
        dropped.position.set(x, y, 0);
        const logic = dropped.components.find(
          c => (c as { type?: string }).type === 'user:QuestCargo'
        ) as { config?: Record<string, unknown> } | undefined;
        if (logic?.config) {
          logic.config.payloadType = Number(this.config.payloadType);
          logic.config.payloadTex = String(this.config.payloadTex);
          logic.config.questId = String(this.config.questId);
          logic.config.containerX = Number(this.config.containerX);
          logic.config.containerY = Number(this.config.containerY);
          logic.config.containerW = Number(this.config.containerW);
          logic.config.containerH = Number(this.config.containerH);
          // Inherit some of the carrier's leftward momentum.
          logic.config.vx = -Number(this.config.speed) * 0.4;
        }
      })
      .catch(err => console.warn('[QuestNpc] cargo drop failed', err));
  }

  // ── despawn paths ─────────────────────────────────────────────────────────────

  /** Shot dead. Death fx + wave accounting; protect NPCs are a quest loss. */
  private die(): void {
    const node = this.node;
    if (!node || this.state === 'gone') return;
    this.scene?.audio.play(DEATH_SOUND, { bus: 'sfx', volumeVariation: 0.15 });
    this.spawnExplosion(node.position.x, node.position.y, 0.7);
    this.emitToGameRoot('unit-killed', Number(this.config.score));

    if (this.config.role === 'protect') {
      this.emitToGameRoot('quest-npc-lost', { questId: String(this.config.questId) });
    } else if (this.isCarrier() && this.hasCargo) {
      // Killed with the cargo still aboard → the cargo is lost with it.
      this.emitToGameRoot('quest-cargo-lost', {
        questId: String(this.config.questId),
        payloadType: Number(this.config.payloadType),
      });
    }
    this.despawn();
  }

  /** Crossed the field. Protect = safe; carrier that still holds cargo = lost. */
  private leaveField(): void {
    if (this.state === 'gone') return;
    if (this.config.role === 'protect') {
      this.emitToGameRoot('quest-npc-safe', { questId: String(this.config.questId) });
    } else if (this.isCarrier() && this.hasCargo) {
      this.emitToGameRoot('quest-cargo-lost', {
        questId: String(this.config.questId),
        payloadType: Number(this.config.payloadType),
      });
    }
    this.despawn();
  }

  private despawn(): void {
    if (this.state === 'gone' || !this.node) return;
    this.state = 'gone';
    this.emitToGameRoot('enemy-gone');
    this.node.queueFree();
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private disableHitboxes(node: NodeBase): void {
    for (const comp of node.components) {
      if (comp.type === 'core:Hitbox2D') comp.config.group = 'disabled';
    }
  }

  private spawnExplosion(x: number, y: number, scale: number): void {
    void this.scene
      ?.instantiate(EXPLOSION_PREFAB, { parent: 'effects' })
      .then(fx => {
        fx.position.set(x, y, 0);
        fx.scale.set(scale, scale, 1);
      })
      .catch(err => console.warn('[QuestNpc] explosion spawn failed', err));
  }

  private emitToGameRoot(signal: string, ...args: unknown[]): void {
    this.findNode('game-root')?.emit(signal, ...args);
  }
}
