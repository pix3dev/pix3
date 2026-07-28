import { Script } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import {
  ARENA_EMOTES,
  arenaAvatars,
  arenaMatch,
  arenaSession,
  peerName,
  pushFeed,
  resetArenaState,
  type ArenaAvatar,
} from './arena-shared';
import { PlayerAvatar } from './PlayerAvatar';

/**
 * The arena's brain: spawns this client's avatar, and — on the room host only — runs the tag rules.
 *
 * **Why the host and not the server.** Level 1 of the pix3 multiplayer stack is a relay: the room
 * moves transforms and signals but does not know what a "tag" is. Someone has to decide, so one
 * client does, and every other client just applies what it is told. That is a deliberate trade —
 * this is trusting the host — and it is exactly the piece Level 2/3 move server-side later. The
 * split is kept clean here so that move is a deletion, not a rewrite: rule code lives behind
 * `isHost`, everything else only reacts to `arena:state`.
 *
 * **Signal budget.** Peer signals are quota'd at 2/s per client. Match state is therefore broadcast
 * at 1 Hz plus an immediate extra on a real change (a tag, a phase flip), and `emitBudget` refuses
 * anything beyond two per second so an emote spam does not silently eat the state broadcast.
 */
export class ArenaController extends Script {
  private spawning = false;
  private disposers: (() => void)[] = [];
  private broadcastTimer = 0;
  private tagCooldown = 0;
  private sessionTimer = 0;
  private emitTimestamps: number[] = [];
  private lastEmoteAt = 0;
  private previousEmoteButtons = [false, false, false];
  private myAvatar: PlayerAvatar | null = null;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      playerPrefab: 'res://src/assets/prefabs/player.pix3scene',
      roundSeconds: 90,
      intermissionSeconds: 6,
      tagRadius: 58,
      tagCooldownSeconds: 1.5,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, step = 1) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Arena', step },
      getValue: (c: unknown) => (c as ArenaController).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as ArenaController).config[name] = Number(v);
      },
    });

    return {
      nodeType: 'ArenaController',
      properties: [
        {
          name: 'playerPrefab',
          type: 'string',
          ui: { label: 'Player Prefab', group: 'Arena' },
          getValue: (c: unknown) => String((c as ArenaController).config.playerPrefab ?? ''),
          setValue: (c: unknown, v: unknown) => {
            (c as ArenaController).config.playerPrefab = String(v);
          },
        },
        num('roundSeconds', 'Round Length (s)'),
        num('intermissionSeconds', 'Intermission (s)'),
        num('tagRadius', 'Tag Radius (px)'),
        num('tagCooldownSeconds', 'Tag Cooldown (s)', 0.1),
      ],
      groups: { Arena: { label: 'Arena', expanded: true } },
    };
  }

  onStart(): void {
    resetArenaState();
    this.readSession();

    const network = this.scene?.network;
    if (network) {
      this.disposers.push(
        network.on('arena:state', payload => this.onStateSignal(payload)),
        network.on('arena:emote', (payload, sender) => this.onEmoteSignal(payload, sender))
      );
    }

    arenaMatch.timeLeft = Number(this.config.roundSeconds) || 90;
    void this.spawnLocalAvatar();
  }

  onDetach(): void {
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    super.onDetach();
  }

  onUpdate(dt: number): void {
    this.sessionTimer -= dt;
    if (this.sessionTimer <= 0) {
      this.sessionTimer = 0.5;
      this.readSession();
    }

    this.pollEmoteInput();

    if (this.tagCooldown > 0) {
      this.tagCooldown -= dt;
    }

    if (!arenaSession.online) {
      // Offline the sample is a single-player sandbox: no rules, no timer, just movement. That is
      // what makes it usable as a scene test before a room exists.
      return;
    }

    if (arenaSession.isHost) {
      this.runHostRules(dt);
    }
  }

  // ── Local avatar ───────────────────────────────────────────────────────────

  private async spawnLocalAvatar(): Promise<void> {
    const scene = this.scene;
    const prefab = String(this.config.playerPrefab ?? '');
    if (!scene || this.spawning || !prefab) {
      return;
    }
    this.spawning = true;

    try {
      const node = await scene.instantiate(prefab, { parent: 'players' });
      const spawn = this.resolveSpawnPoint();
      // Position first: the prefab's `core:NetworkedNode` mints its entity in `onStart`, a tick after
      // this, and it mints it at wherever the node is standing.
      node.position.set(spawn.x, spawn.y, node.position.z);

      const avatar = node.getComponent(PlayerAvatar);
      if (avatar) {
        avatar.markLocal();
        this.myAvatar = avatar;
      }
    } catch (error) {
      arenaSession.notice = `Could not spawn the player avatar: ${describe(error)}`;
      console.error('[ArenaController] spawn failed', error);
    } finally {
      this.spawning = false;
    }
  }

  /**
   * Seats this client on a spawn marker.
   *
   * Indexing by client id (not by join order) means two clients never compute a different seat for
   * the same player, and no coordination message is needed to hand seats out.
   */
  private resolveSpawnPoint(): { x: number; y: number } {
    const markers = this.spawnMarkers();
    if (markers.length === 0) {
      return { x: 0, y: 0 };
    }
    const clientId = arenaSession.clientId;
    const index = clientId === 0 ? 0 : Math.abs(clientId) % markers.length;
    const marker = markers[index];
    return { x: marker.position.x, y: marker.position.y };
  }

  private spawnMarkers(): NodeBase[] {
    const spawns = this.node?.children.find(
      child => (child as NodeBase).name === 'Spawns'
    ) as NodeBase | undefined;
    return spawns ? (spawns.children as NodeBase[]) : [];
  }

  // ── Session mirror ─────────────────────────────────────────────────────────

  private readSession(): void {
    const network = this.scene?.network;
    arenaSession.online = network?.isOnline ?? false;
    arenaSession.isHost = network?.isHost ?? false;
    arenaSession.clientId = network?.clientId ?? 0;
    arenaSession.roomId = network?.roomId ?? '';
    arenaSession.peerCount = network?.peers.length ?? 0;
    arenaSession.rtt = Math.round(network?.rtt ?? 0);
  }

  // ── Host rules ─────────────────────────────────────────────────────────────

  private runHostRules(dt: number): void {
    const avatars = [...arenaAvatars].filter(avatar => avatar.clientId !== 0);
    if (avatars.length === 0) {
      return;
    }

    let changed = false;

    // Somebody has to be "it", and the host is the only one who can decide. A departed "it" would
    // otherwise leave the round with no chaser and no way to ever produce one.
    if (!avatars.some(avatar => avatar.clientId === arenaMatch.itClientId)) {
      arenaMatch.itClientId = avatars[0].clientId;
      pushFeed(`${this.nameOf(arenaMatch.itClientId)} is it`);
      changed = true;
    }

    arenaMatch.timeLeft -= dt;

    if (arenaMatch.phase === 'play') {
      for (const avatar of avatars) {
        if (avatar.clientId === arenaMatch.itClientId) {
          continue;
        }
        arenaMatch.scores.set(avatar.clientId, (arenaMatch.scores.get(avatar.clientId) ?? 0) + dt);
      }

      if (this.tagCooldown <= 0 && this.tryTag(avatars)) {
        changed = true;
      }

      if (arenaMatch.timeLeft <= 0) {
        this.endRound();
        changed = true;
      }
    } else if (arenaMatch.timeLeft <= 0) {
      this.startRound(avatars);
      changed = true;
    }

    this.broadcastTimer -= dt;
    if (changed || this.broadcastTimer <= 0) {
      this.broadcastTimer = 1;
      this.broadcastState();
    }
  }

  /** Transfers the tag when "it" touches somebody. Returns true when the tag actually moved. */
  private tryTag(avatars: readonly ArenaAvatar[]): boolean {
    const chaser = avatars.find(avatar => avatar.clientId === arenaMatch.itClientId);
    if (!chaser) {
      return false;
    }

    const radius = Number(this.config.tagRadius) || 58;
    const radiusSquared = radius * radius;
    const chaserPosition = chaser.getPosition();

    for (const avatar of avatars) {
      if (avatar.clientId === chaser.clientId) {
        continue;
      }
      const position = avatar.getPosition();
      const dx = position.x - chaserPosition.x;
      const dy = position.y - chaserPosition.y;
      if (dx * dx + dy * dy > radiusSquared) {
        continue;
      }

      arenaMatch.itClientId = avatar.clientId;
      this.tagCooldown = Number(this.config.tagCooldownSeconds) || 1.5;
      pushFeed(`${this.nameOf(chaser.clientId)} tagged ${this.nameOf(avatar.clientId)}`);
      return true;
    }

    return false;
  }

  private endRound(): void {
    let winner = 0;
    let best = -1;
    for (const [clientId, score] of arenaMatch.scores) {
      if (score > best) {
        best = score;
        winner = clientId;
      }
    }

    arenaMatch.phase = 'intermission';
    arenaMatch.timeLeft = Number(this.config.intermissionSeconds) || 6;
    arenaMatch.lastWinner = winner === 0 ? '' : this.nameOf(winner);
    pushFeed(arenaMatch.lastWinner ? `round over — ${arenaMatch.lastWinner} wins` : 'round over');
  }

  private startRound(avatars: readonly ArenaAvatar[]): void {
    arenaMatch.phase = 'play';
    arenaMatch.timeLeft = Number(this.config.roundSeconds) || 90;
    arenaMatch.scores = new Map();
    // Last round's winner starts as the chaser — a small self-balancing rule that keeps one strong
    // player from farming the same score every round.
    const winner = avatars.find(avatar => this.nameOf(avatar.clientId) === arenaMatch.lastWinner);
    arenaMatch.itClientId = winner?.clientId ?? avatars[0]?.clientId ?? 0;
    arenaMatch.lastWinner = '';
    pushFeed('new round');
    for (const avatar of arenaAvatars) {
      if (avatar.isMine) {
        avatar.respawn();
      }
    }
  }

  private broadcastState(): void {
    if (!this.canEmit()) {
      return;
    }
    this.scene?.network.emit('arena:state', {
      p: arenaMatch.phase,
      it: arenaMatch.itClientId,
      t: Math.max(0, Math.round(arenaMatch.timeLeft)),
      w: arenaMatch.lastWinner,
      s: [...arenaMatch.scores].map(([clientId, score]) => [clientId, Math.round(score)]),
    });
  }

  // ── Inbound signals ────────────────────────────────────────────────────────

  private onStateSignal(payload: Uint8Array): void {
    if (arenaSession.isHost) {
      // The host is the author of this state; echoing somebody else's would let any peer rewrite
      // the match. Level 1 cannot prove who sent what, so the host simply never listens.
      return;
    }

    const state = decodeJson<{
      p?: string;
      it?: number;
      t?: number;
      w?: string;
      s?: [number, number][];
    }>(payload);
    if (!state) {
      return;
    }

    const previousIt = arenaMatch.itClientId;
    arenaMatch.phase = state.p === 'intermission' ? 'intermission' : 'play';
    arenaMatch.itClientId = Number(state.it) || 0;
    arenaMatch.timeLeft = Number(state.t) || 0;
    arenaMatch.lastWinner = typeof state.w === 'string' ? state.w : '';
    arenaMatch.scores = new Map(Array.isArray(state.s) ? state.s : []);

    if (previousIt !== arenaMatch.itClientId && arenaMatch.itClientId !== 0) {
      pushFeed(`${this.nameOf(arenaMatch.itClientId)} is it`);
      if (arenaMatch.itClientId === arenaSession.clientId) {
        this.myAvatar?.showEmote('I am it!');
      }
    }
  }

  private onEmoteSignal(payload: Uint8Array, senderClientId: number): void {
    const message = decodeJson<{ e?: number }>(payload);
    const index = Number(message?.e) || 0;
    const text = ARENA_EMOTES[index] ?? ARENA_EMOTES[0];
    for (const avatar of arenaAvatars) {
      if (avatar.clientId === senderClientId) {
        avatar.showEmote(text);
      }
    }
    pushFeed(`${this.nameOf(senderClientId)}: ${text}`);
  }

  // ── Emotes ─────────────────────────────────────────────────────────────────

  private pollEmoteInput(): void {
    const input = this.input;
    if (!input) {
      return;
    }

    for (let index = 0; index < ARENA_EMOTES.length; index += 1) {
      // Button2D holds its action while pressed and the digit keys are held too, so both need an
      // edge, not a level.
      const pressed =
        input.getButton(`arena_emote_${index}`) || input.getButton(`Key_Digit${index + 1}`);
      if (pressed && !this.previousEmoteButtons[index]) {
        this.sendEmote(index);
      }
      this.previousEmoteButtons[index] = pressed;
    }
  }

  private sendEmote(index: number): void {
    const text = ARENA_EMOTES[index] ?? ARENA_EMOTES[0];
    this.myAvatar?.showEmote(text);
    pushFeed(`you: ${text}`);

    const now = Date.now();
    if (now - this.lastEmoteAt < 1000 || !arenaSession.online || !this.canEmit()) {
      return;
    }
    this.lastEmoteAt = now;
    this.scene?.network.emit('arena:emote', { e: index });
  }

  /** Peer signals are quota'd at 2/s server-side; this keeps us just inside it. */
  private canEmit(): boolean {
    const now = Date.now();
    this.emitTimestamps = this.emitTimestamps.filter(at => now - at < 1000);
    if (this.emitTimestamps.length >= 2) {
      return false;
    }
    this.emitTimestamps.push(now);
    return true;
  }

  private nameOf(clientId: number): string {
    if (clientId === arenaSession.clientId) {
      return 'you';
    }
    return peerName(this.scene?.network.peers ?? [], clientId);
  }
}

function decodeJson<T>(payload: Uint8Array): T | null {
  if (!payload || payload.length === 0) {
    return null;
  }
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as T;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
