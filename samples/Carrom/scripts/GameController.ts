import {
  Bar2D,
  Label2D,
  NodeBase,
  Script,
  readWorldTransform2D,
  registerGameDebug,
} from '@pix3/runtime';
import type { GameCommandArgs, PhysicsBody2DHandle, PropertySchema } from '@pix3/runtime';

import {
  AI_FALLBACK_POWER,
  AI_THINK_MAX_FRAMES,
  AI_THINK_SEC,
  DISC_PALETTE,
  HITSTOP_MS,
  IDLE_HINT_AFTER_SEC,
  IDLE_HINT_PERIOD_SEC,
  IDLE_HINT_PUNCH,
  IMPACT_SHAKE_DURATION,
  IMPACT_SHAKE_FREQUENCY,
  IMPACT_SHAKE_MAX_AMPLITUDE,
  IMPACT_SHAKE_MIN_AMPLITUDE,
  IMPACT_SHAKE_MIN_SPEED,
  IMPACT_SHAKE_SPEED_SCALE,
  MEN_PER_SIDE,
  MIN_POWER,
  POCKETS,
  QUEEN_SLOWMO_BLEND_MS,
  QUEEN_SLOWMO_MS,
  QUEEN_SLOWMO_SCALE,
  STRIKER_MASS,
  STRIKER_PARK,
  STRIKER_X_LIMIT,
  WIN_BURST_COUNT,
  WIN_BURST_INTERVAL_SEC,
  aiOn,
  capturingPocket,
  clamp,
  clampForwardCone,
  discRadius,
  forwardSign,
  freeSpotNear,
  isForwardDir,
  isSpawnableKind,
  launchSpeed,
  normalize,
  otherColour,
  prefabPath,
  rackLayout,
  strikerLineY,
  velocitySampleOn,
  type AiShot,
  type CarromControllerApi,
  type CarromState,
  type Colour,
  type DiscKind,
  type Point2,
  type RackEntry,
  type SpawnableKind,
  type SweepDisc,
} from './carrom-geometry';

/** One piece currently on the board. */
interface LiveDisc {
  node: NodeBase;
  kind: DiscKind;
  radius: number;
}

/** What one strike did, as the debug snapshot reports it. */
interface StrikeRecord {
  contacts: number;
  pocketed: DiscKind[];
  foul: boolean;
  keptTurn: boolean;
}

/** `board`, `pending-cover:<colour>` or `covered:<colour>`. */
type QueenState = 'board' | `pending-cover:${Colour}` | `covered:${Colour}`;

const PENDING_PREFIX = 'pending-cover:';
const COVERED_PREFIX = 'covered:';
const TOAST_SECONDS = 1.8;

/**
 * `user:GameController` — the whole rules engine, on `GameRoot`.
 *
 * It owns the turn state machine
 *
 * ```
 * AIM      ─(shot accepted)─▶ SHOOT ─(1 frame)─▶ SIMULATE ─(settled)─▶ RESOLVE ─▶ NEXT_TURN ─┬─▶ AIM
 * AI_THINK ─(0.9 s)─────────▶ SHOOT                                      └─(win)─▶ GAME_OVER └─▶ AI_THINK
 * ```
 *
 * and, inside it, everything the engine does not do for us: the constant cloth
 * deceleration and the stop snap (the solver only has exponential damping),
 * pocket capture by centre distance (a circle sensor would fire on a graze),
 * settle detection (the solver's sleep latency is a fixed 0.5 s), and the carrom
 * rules table — continuation on your own pot, Queen-and-cover, striker fouls
 * with a penalty man, and returns to the centre.
 *
 * It also exposes the game to tooling: `scene.commands` for driving it without
 * gestures, and `registerGameDebug` for reading it as state rather than pixels.
 */
export class GameController extends Script implements CarromControllerApi {
  // --- run state ---
  private runState: CarromState = 'AIM';
  private currentShooter: Colour = 'white';
  private men: LiveDisc[] = [];
  private strikerNode: NodeBase | null = null;
  private strikerX = 0;

  private pocketedCount: Record<Colour, number> = { white: 0, black: 0 };
  private due: Record<Colour, number> = { white: 0, black: 0 };
  private queenState: QueenState = 'board';

  // --- current strike ---
  private strikeContacts = 0;
  private strikePocketed: DiscKind[] = [];
  private strikeFoul = false;
  private lastStrike: StrikeRecord | null = null;
  private settleTimer = 0;
  private shotElapsed = 0;

  // --- AI ---
  /** Debug soak mode: the AI plays BOTH colours. Runtime only, never authored. */
  private autoplay = false;
  private aiThinkTimer = 0;
  /**
   * Frames spent in `AI_THINK`. The think delay runs on scaled game time, so
   * this is the guard that does not depend on `timeScale` being sane.
   */
  private aiThinkFrames = 0;
  private pendingAiShot: AiShot | null = null;

  // --- outcome ---
  private winner: Colour | null = null;
  private finalScore = 0;
  private celebrationLeft = 0;
  private celebrationTimer = 0;

  // --- housekeeping ---
  /** True while an async rack/return spawn is in flight; the frame loop waits. */
  private busy = false;
  private toastTimer = 0;
  private idleTimer = 0;
  private idleHintTimer = 0;
  private readonly disposers: (() => void)[] = [];

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      aiEnabled: true,
      aiDifficulty: 0.6,
      aiThinkSec: AI_THINK_SEC,
      settleHoldSec: 0.35,
      settleTimeoutSec: 8,
      decelPxPerSec2: 220,
      stopSnapSpeed: 6,
      hitstopMs: HITSTOP_MS,
      bannerSec: 0.9,
    };
  }

  static getPropertySchema(): PropertySchema {
    const numberProp = (name: string, label: string, description: string, step = 0.05) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Carrom', step, description },
      getValue: (c: unknown) => (c as GameController).config[name],
      setValue: (c: unknown, v: unknown) => {
        (c as GameController).config[name] = Number(v);
      },
    });

    return {
      nodeType: 'GameController',
      properties: [
        {
          name: 'aiEnabled',
          type: 'boolean',
          ui: {
            label: 'AI Opponent',
            group: 'Carrom',
            description: 'Let user:CarromAI play black. Off makes the game hot-seat.',
          },
          getValue: (c: unknown) => (c as GameController).config.aiEnabled !== false,
          setValue: (c: unknown, v: unknown) => {
            (c as GameController).config.aiEnabled = Boolean(v);
          },
        },
        numberProp(
          'aiDifficulty',
          'AI Difficulty',
          '0..1. Pure aim accuracy: 1 shoots the line it picked exactly, 0 gets the full jitter.',
          0.05
        ),
        numberProp(
          'aiThinkSec',
          'AI Think Time',
          'How long the AI pauses on its turn before shooting, so the shot is readable.',
          0.1
        ),
        numberProp(
          'hitstopMs',
          'Hitstop',
          "Freeze on the striker's first contact of a strike, in real milliseconds.",
          5
        ),
        numberProp(
          'settleHoldSec',
          'Settle Hold',
          'Seconds every disc must stay under the stop-snap speed before the strike resolves.'
        ),
        numberProp(
          'settleTimeoutSec',
          'Settle Timeout',
          'Hard ceiling on one strike; everything is force-stopped when it expires.',
          0.5
        ),
        numberProp(
          'decelPxPerSec2',
          'Cloth Deceleration',
          'Constant deceleration applied to every moving disc (px/s^2).',
          10
        ),
        numberProp(
          'stopSnapSpeed',
          'Stop Snap Speed',
          'Below this speed a disc is snapped to a dead stop (px/s).',
          0.5
        ),
        numberProp('bannerSec', 'Banner Seconds', 'How long the turn banner stays up.', 0.1),
      ],
      groups: { Carrom: { label: 'Carrom', expanded: true } },
    };
  }

  // -------------------------------------------------------------------------
  // Public API (CarromControllerApi)
  // -------------------------------------------------------------------------

  get state(): CarromState {
    return this.runState;
  }

  get shooter(): Colour {
    return this.currentShooter;
  }

  sweepDiscs(): SweepDisc[] {
    const out: SweepDisc[] = [];
    for (const disc of this.men) {
      const transform = readWorldTransform2D(disc.node);
      out.push({
        id: disc.node.nodeId,
        kind: disc.kind,
        x: transform.x,
        y: transform.y,
        radius: disc.radius,
      });
    }
    return out;
  }

  strikerPosition(): Point2 {
    if (!this.strikerNode) {
      return { x: this.strikerX, y: strikerLineY(this.currentShooter) };
    }
    const transform = readWorldTransform2D(this.strikerNode);
    return { x: transform.x, y: transform.y };
  }

  placeStriker(x: number): boolean {
    if (this.runState !== 'AIM') {
      return false;
    }
    this.positionStriker(x);
    return true;
  }

  requestShot(dir: Point2, power: number): boolean {
    if ((this.runState !== 'AIM' && this.runState !== 'AI_THINK') || !this.strikerNode) {
      return false;
    }
    const unit = normalize(dir);
    if (!unit || !isForwardDir(unit, this.currentShooter)) {
      return false;
    }
    const strength = clamp(power, 0, 1);
    if (strength < MIN_POWER) {
      return false;
    }
    const body = this.bodyOf(this.strikerNode);
    if (!body) {
      return false;
    }

    this.strikeContacts = 0;
    this.strikePocketed = [];
    this.strikeFoul = false;
    this.settleTimer = 0;
    this.shotElapsed = 0;

    const speed = launchSpeed(strength);
    this.strikerNode.visible = true;
    body.wake();
    body.setVelocity(unit.x * speed, unit.y * speed);

    this.scene?.juice.punchScale(this.strikerNode, { amount: 0.12 });
    this.scene?.audio.sfx('tap', { volume: 0.5 + 0.5 * strength, pitch: 0.9 });

    this.hideAimUi();
    this.runState = 'SHOOT';
    return true;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  onStart(): void {
    const scene = this.scene;
    if (!scene) {
      return;
    }
    // Belt and braces next to `core:PhysicsWorld2D` on this node: the board is
    // top-down, and the behaviour's default is earth gravity.
    scene.physics2d.setGravity(0, 0);

    this.strikerNode = this.findNode('Striker');
    this.strikerNode?.connect('contact-started', this, this.handleStrikerContact);

    this.wireButton('RestartButton', () => {
      void this.restart();
    });
    this.wireButton('PlayAgainButton', () => {
      void this.restart();
    });

    this.registerCommands();
    this.disposers.push(
      registerGameDebug({
        name: 'carrom',
        version: 1,
        snapshot: () => this.snapshot(),
        actions: () => scene.commands.list().map(command => command.name),
        action: (name, args) => {
          const payload =
            args && typeof args === 'object' && !Array.isArray(args)
              ? (args as GameCommandArgs)
              : undefined;
          return scene.commands.dispatch(name, payload);
        },
        reset: () => this.restart(),
      })
    );

    void this.restart();
  }

  override onDetach(): void {
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers.length = 0;
    super.onDetach();
  }

  onUpdate(dt: number): void {
    this.tickToast(dt);
    this.tickCelebration(dt);
    if (this.busy) {
      return;
    }

    switch (this.runState) {
      case 'AIM':
        this.applyClothDrag(dt);
        this.detectPockets();
        // A piece already sitting in a pocket mouth drops in even with nobody
        // shooting; it resolves as a strike that made no contact.
        if (this.strikePocketed.length > 0 || this.strikeFoul) {
          this.enterResolve();
        } else {
          this.tickIdleHint(dt);
        }
        break;
      case 'AI_THINK':
        this.applyClothDrag(dt);
        this.aiThinkTimer += dt;
        this.aiThinkFrames += 1;
        if (
          this.aiThinkTimer >= this.numberConfig('aiThinkSec', AI_THINK_SEC) ||
          this.aiThinkFrames >= AI_THINK_MAX_FRAMES
        ) {
          this.fireAiShot();
        }
        break;
      case 'SHOOT':
        this.runState = 'SIMULATE';
        break;
      case 'SIMULATE':
        this.applyClothDrag(dt);
        this.detectPockets();
        this.updateSettle(dt);
        break;
      case 'NEXT_TURN':
        if (this.isAiShooter()) {
          this.enterAiThink();
        } else {
          this.runState = 'AIM';
        }
        break;
      case 'RESOLVE':
      case 'GAME_OVER':
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Simulation helpers
  // -------------------------------------------------------------------------

  /**
   * Cloth is Coulomb, the solver is viscous. Bleed a constant deceleration off
   * every moving disc and snap the last few px/s to zero, so a struck man dies
   * crisply instead of creeping for a second.
   *
   * Only touched while a body is actually moving: `setVelocity` wakes a body and
   * resets its sleep timer, so calling it every frame would keep the whole board
   * awake forever.
   */
  private applyClothDrag(dt: number): void {
    if (dt <= 0) {
      return;
    }
    const decel = this.numberConfig('decelPxPerSec2', 220);
    const snap = this.numberConfig('stopSnapSpeed', 6);
    for (const node of this.activeNodes()) {
      const body = this.bodyOf(node);
      if (!body || body.isSleeping) {
        continue;
      }
      const vx = body.velocityX;
      const vy = body.velocityY;
      const speed = Math.hypot(vx, vy);
      if (speed <= 0) {
        continue;
      }
      if (speed < snap) {
        body.setVelocity(0, 0);
        continue;
      }
      const next = Math.max(0, speed - decel * dt);
      body.setVelocity((vx / speed) * next, (vy / speed) * next);
    }
  }

  private updateSettle(dt: number): void {
    this.shotElapsed += dt;
    const snap = this.numberConfig('stopSnapSpeed', 6);
    let moving = false;
    for (const node of this.activeNodes()) {
      const body = this.bodyOf(node);
      if (!body || body.isSleeping) {
        continue;
      }
      if (Math.hypot(body.velocityX, body.velocityY) >= snap) {
        moving = true;
        break;
      }
    }
    this.settleTimer = moving ? 0 : this.settleTimer + dt;

    const hold = this.numberConfig('settleHoldSec', 0.35);
    const timeout = this.numberConfig('settleTimeoutSec', 8);
    if (this.settleTimer >= hold || this.shotElapsed >= timeout) {
      this.forceStopAll();
      this.enterResolve();
    }
  }

  private forceStopAll(): void {
    for (const node of this.activeNodes()) {
      this.bodyOf(node)?.setVelocity(0, 0);
    }
  }

  /** Capture by centre distance — a sensor would fire on a grazing edge. */
  private detectPockets(): void {
    for (let i = this.men.length - 1; i >= 0; i--) {
      const disc = this.men[i];
      const transform = readWorldTransform2D(disc.node);
      if (!capturingPocket(transform.x, transform.y)) {
        continue;
      }
      this.men.splice(i, 1);
      this.strikePocketed.push(disc.kind);
      this.pocketJuice(disc.kind, transform.x, transform.y);
      disc.node.queueFree();
    }

    const striker = this.strikerNode;
    if (striker && striker.visible && !this.strikeFoul) {
      const transform = readWorldTransform2D(striker);
      if (capturingPocket(transform.x, transform.y)) {
        this.strikeFoul = true;
        this.parkStriker();
        this.scene?.audio.sfx('bounce', { volume: 0.5, pitch: 0.6 });
      }
    }
  }

  private pocketJuice(kind: DiscKind, x: number, y: number): void {
    const scene = this.scene;
    if (!scene) {
      return;
    }
    const palette = DISC_PALETTE[kind];
    scene.audio.sfx(kind === 'queen' ? 'powerup' : 'score', {
      pitch: kind === 'white' ? 1 : 0.85,
    });
    if (kind === 'queen') {
      // The one moment in a game worth stretching. Real milliseconds, so it is
      // the same length however the frame rate wobbles.
      scene.time.slowMotion(QUEEN_SLOWMO_SCALE, {
        durationMs: QUEEN_SLOWMO_MS,
        blendMs: QUEEN_SLOWMO_BLEND_MS,
      });
    }
    scene.juice.burst(
      { x, y },
      {
        count: kind === 'queen' ? 40 : 18,
        speed: 240,
        colors: [...palette],
        sizePx: 8,
        gravityY: 0,
        lifeSec: 0.45,
      }
    );
    scene.juice.floatText(kind === 'queen' ? 'QUEEN' : '+1', {
      at: { x, y },
      color: palette[1],
      fontSizePx: 44,
      glow: true,
    });
    if (kind === 'white' || kind === 'black') {
      this.label(kind === 'white' ? 'PlayerLeft' : 'OpponentLeft')?.emit('bump');
    }
  }

  // -------------------------------------------------------------------------
  // The AI turn
  // -------------------------------------------------------------------------

  /** Is the colour about to shoot driven by `user:CarromAI`? */
  private isAiShooter(): boolean {
    if (this.autoplay) {
      return true;
    }
    return this.config.aiEnabled !== false && this.currentShooter === 'black';
  }

  /**
   * Enter `AI_THINK` and choose the shot IMMEDIATELY. The delay that follows is
   * presentation — it exists so a human can see the opponent take a turn — and
   * deciding up front means a slow or throwing search shows up as a one-frame
   * stall at the start of the turn instead of an indefinite wait at the end.
   */
  private enterAiThink(): void {
    this.runState = 'AI_THINK';
    this.aiThinkTimer = 0;
    this.aiThinkFrames = 0;
    this.pendingAiShot = this.computeAiShot();
  }

  private computeAiShot(): AiShot {
    const shooter = this.currentShooter;
    try {
      const ai = aiOn(this.node);
      if (ai) {
        const shot = ai.pickShot({
          shooter,
          discs: this.sweepDiscs(),
          ownPocketed: this.pocketedCount[shooter],
          difficulty: clamp(this.numberConfig('aiDifficulty', 0.6), 0, 1),
        });
        const sane = this.sanitizeShot(shot);
        if (sane) {
          return sane;
        }
      }
    } catch (error) {
      console.error('[Carrom] CarromAI.pickShot failed; falling back.', error);
    }
    return this.safeFallbackShot();
  }

  /**
   * Take the AI's shot, and leave `AI_THINK` no matter what happens.
   *
   * Three layers, because the one failure that makes the prototype unplayable
   * is a turn loop that stops: the chosen shot, then a straight-ahead fallback,
   * then passing the turn outright.
   */
  private fireAiShot(): void {
    const shot = this.pendingAiShot;
    this.pendingAiShot = null;

    if (shot) {
      this.positionStriker(shot.x);
      if (this.requestShot(shot.dir, shot.power)) {
        return;
      }
    }

    const rescue = this.safeFallbackShot();
    this.positionStriker(rescue.x);
    if (this.requestShot(rescue.dir, rescue.power)) {
      return;
    }

    // Nothing legal at all (no striker body yet, say). Record an empty strike
    // and hand the turn over rather than sitting here.
    console.warn('[Carrom] The AI could not take a legal shot; passing the turn.');
    this.lastStrike = { contacts: 0, pocketed: [], foul: false, keptTurn: false };
    this.beginTurn(false);
  }

  /** Always inside the forward cone, always at legal power. */
  private safeFallbackShot(): AiShot {
    return {
      x: clamp(this.strikerX, -STRIKER_X_LIMIT, STRIKER_X_LIMIT),
      dir: { x: 0, y: forwardSign(this.currentShooter) },
      power: AI_FALLBACK_POWER,
    };
  }

  /** Reject a shot the controller could not act on; repair the ones it can. */
  private sanitizeShot(shot: AiShot | null | undefined): AiShot | null {
    if (!shot) {
      return null;
    }
    const unit = normalize(shot.dir);
    if (!unit || !Number.isFinite(shot.x) || !Number.isFinite(shot.power)) {
      return null;
    }
    const cone = clampForwardCone(unit, this.currentShooter);
    return {
      x: clamp(shot.x, -STRIKER_X_LIMIT, STRIKER_X_LIMIT),
      dir: { x: cone.x, y: cone.y },
      power: clamp(shot.power, MIN_POWER, 1),
    };
  }

  /**
   * Re-read who is driving the current turn after `ai.toggle` / `autoplay`.
   * Without this, switching autoplay on while a human is aiming would do nothing
   * until the turn happened to change hands.
   */
  private syncShooterControl(): void {
    if (this.runState === 'AIM' && this.isAiShooter()) {
      this.hideAimUi();
      this.enterAiThink();
    }
  }

  // -------------------------------------------------------------------------
  // Resolve — the rules table (spec §2)
  // -------------------------------------------------------------------------

  private enterResolve(): void {
    this.runState = 'RESOLVE';
    void this.resolveStrike();
  }

  private async resolveStrike(): Promise<void> {
    this.busy = true;
    try {
      const shooter = this.currentShooter;
      const potted = [...this.strikePocketed];
      const foul = this.strikeFoul;
      const contacts = this.strikeContacts;
      // Consume the strike NOW: a capture recorded during AIM resolves through
      // this same path, and leaving the record standing would resolve it again
      // on the very next frame, forever.
      this.resetStrikeRecord();
      const ownPotted = potted.filter(kind => kind === shooter).length;
      const toReturn: SpawnableKind[] = [];
      let coverFailed = false;
      let lastManReturned = false;

      // 1. A cover that was pending from the previous strike is decided first.
      const pending = this.pendingCoverColour();
      if (pending) {
        if (!foul && ownPotted > 0 && pending === shooter) {
          this.queenState = `covered:${pending}`;
        } else {
          this.queenState = 'board';
          toReturn.push('queen');
          coverFailed = true;
        }
      }

      const queenPotted = potted.includes('queen');

      // 2. This strike's captures.
      if (foul) {
        // Everything pocketed comes back, plus one man of the shooter's colour
        // (or a "due" when they have nothing banked yet).
        for (const kind of potted) {
          if (isSpawnableKind(kind)) {
            toReturn.push(kind);
          }
        }
        if (this.pocketedCount[shooter] > 0) {
          this.pocketedCount[shooter] -= 1;
          toReturn.push(shooter);
        } else {
          this.due[shooter] += 1;
        }
      } else {
        if (queenPotted && !pending) {
          this.queenState = ownPotted > 0 ? `covered:${shooter}` : `pending-cover:${shooter}`;
        }
        for (const kind of potted) {
          if (kind !== 'white' && kind !== 'black') {
            continue;
          }
          if (this.due[kind] > 0) {
            this.due[kind] -= 1;
            toReturn.push(kind);
          } else {
            this.pocketedCount[kind] += 1;
          }
        }
      }

      // 3. You may not clear your last man before the Queen is covered.
      const pendingOwn = toReturn.filter(kind => kind === shooter).length;
      if (
        !foul &&
        !this.queenState.startsWith(COVERED_PREFIX) &&
        this.onBoard(shooter) + pendingOwn === 0 &&
        this.pocketedCount[shooter] > 0
      ) {
        this.pocketedCount[shooter] -= 1;
        toReturn.push(shooter);
        lastManReturned = true;
      }

      // 4. Who shoots next.
      let keptTurn: boolean;
      if (foul || coverFailed || lastManReturned) {
        keptTurn = false;
      } else if (ownPotted > 0) {
        keptTurn = true;
      } else {
        keptTurn = queenPotted && this.queenState.startsWith(PENDING_PREFIX);
      }

      this.lastStrike = { contacts, pocketed: potted, foul, keptTurn };

      // 5. Feedback for the things a player cannot see from the board alone.
      if (foul) {
        this.scene?.audio.sfx('lose', { volume: 0.6 });
        this.scene?.juice.flash({ color: '#ff3b30', intensity: 0.25, durationSec: 0.25 });
        this.setToast('Foul - striker pocketed. One man returned.');
      } else if (coverFailed) {
        this.setToast('Queen uncovered - she goes back to the centre.');
      } else if (lastManReturned) {
        this.setToast('Cover the Queen before your last man.');
      }

      // 6. Put the returned pieces back — one at a time, because each spot has
      // to see the one before it or two returns land on top of each other.
      for (const kind of toReturn) {
        const spot = freeSpotNear(0, 0, this.sweepDiscs());
        await this.spawnDiscs([{ kind, x: spot.x, y: spot.y }], true);
      }

      this.updateHud();

      const winner = this.checkWin();
      if (winner) {
        this.enterGameOver(winner);
      } else {
        this.beginTurn(keptTurn);
      }
    } finally {
      this.busy = false;
    }
  }

  private checkWin(): Colour | null {
    if (!this.queenState.startsWith(COVERED_PREFIX)) {
      return null;
    }
    if (this.pocketedCount.white >= MEN_PER_SIDE) {
      return 'white';
    }
    if (this.pocketedCount.black >= MEN_PER_SIDE) {
      return 'black';
    }
    return null;
  }

  private enterGameOver(winner: Colour): void {
    const loser = otherColour(winner);
    const queenBonus = this.queenState === `covered:${winner}` ? 3 : 0;
    this.winner = winner;
    this.finalScore = this.onBoard(loser) + queenBonus;
    this.runState = 'GAME_OVER';

    this.parkStriker();
    this.hideAimUi();

    this.label('ResultLabel')?.setText(winner === 'white' ? 'YOU WIN' : 'BLACK WINS');
    this.label('ScoreLabel')?.setText(
      `Score ${this.finalScore}${queenBonus > 0 ? ' (Queen +3)' : ''}`
    );
    this.label('TurnBanner')?.setText(winner === 'white' ? 'YOU WIN' : 'BLACK WINS');
    const overlay = this.findNode('EndOverlay');
    if (overlay) {
      overlay.visible = true;
    }
    // The panel's `core:PopIn` also plays on start, but that happens while the
    // overlay is still hidden — the pop that a player actually sees is this one.
    this.findNode('Panel')?.emit('show');
    this.scene?.audio.sfx(winner === 'white' ? 'win' : 'lose');
    // Staggered through onUpdate rather than timers: three bursts fired in the
    // same frame read as one, and a setTimeout would ignore the time scale.
    this.celebrationLeft = WIN_BURST_COUNT;
    this.celebrationTimer = 0;
  }

  private beginTurn(keptTurn: boolean): void {
    if (!keptTurn) {
      this.currentShooter = otherColour(this.currentShooter);
    }
    this.positionStriker(0);
    this.hideAimUi();
    this.idleTimer = 0;
    this.idleHintTimer = 0;

    const banner = this.label('TurnBanner');
    if (banner) {
      banner.setText(this.currentShooter === 'white' ? 'YOUR TURN' : 'BLACK TO PLAY');
      banner.emit('show');
    }
    this.scene?.audio.sfx('tick', { volume: 0.4 });
    this.updateHud();
    this.runState = 'NEXT_TURN';
  }

  // -------------------------------------------------------------------------
  // Board setup
  // -------------------------------------------------------------------------

  /** Full reset: fresh rack, zeroed score, white to break. */
  async restart(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      this.clearBoard();
      this.pocketedCount = { white: 0, black: 0 };
      this.due = { white: 0, black: 0 };
      this.queenState = 'board';
      this.lastStrike = null;
      this.winner = null;
      this.finalScore = 0;
      this.currentShooter = 'white';
      this.resetStrikeRecord();
      this.resetTransientState();
      this.setToast('');

      const overlay = this.findNode('EndOverlay');
      if (overlay) {
        overlay.visible = false;
      }

      await this.spawnDiscs(rackLayout(), false);
      this.updateHud();
      this.beginTurn(true);
    } finally {
      this.busy = false;
    }
  }

  /** Clears the board and places exactly the given pieces — the rule-test harness. */
  private async applyLayout(args?: GameCommandArgs): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      const entries = readLayoutDiscs(args);
      this.clearBoard();
      this.pocketedCount = {
        white: readNumber(readRecord(args?.pocketed)?.white, 0),
        black: readNumber(readRecord(args?.pocketed)?.black, 0),
      };
      this.due = { white: 0, black: 0 };
      this.queenState = readQueenState(args?.queen);
      this.lastStrike = null;
      this.winner = null;
      this.finalScore = 0;
      this.resetStrikeRecord();
      this.resetTransientState();
      this.setToast('');

      const shooter = args?.shooter;
      this.currentShooter = shooter === 'black' ? 'black' : 'white';

      const overlay = this.findNode('EndOverlay');
      if (overlay) {
        overlay.visible = false;
      }

      await this.spawnDiscs(entries, false);
      this.positionStriker(readNumber(readRecord(args?.striker)?.x, 0));
      this.updateHud();
      this.runState = 'AIM';
    } finally {
      this.busy = false;
    }
  }

  private clearBoard(): void {
    for (const disc of this.men) {
      disc.node.queueFree();
    }
    this.men = [];
  }

  private async spawnDiscs(entries: readonly RackEntry[], popIn: boolean): Promise<void> {
    const scene = this.scene;
    if (!scene) {
      return;
    }
    for (const entry of entries) {
      const node = await scene.instantiate(prefabPath(entry.kind), { parent: 'Pieces' });
      // Set the pose BEFORE the prefab's components start: `registerBody` reads
      // the node's world transform once, on the tick after instantiation.
      node.position.set(entry.x, entry.y, node.position.z);
      this.men.push({ node, kind: entry.kind, radius: discRadius(entry.kind) });
      if (popIn) {
        scene.juice.popIn(node);
      }
    }
  }

  private positionStriker(x: number): void {
    const striker = this.strikerNode;
    if (!striker) {
      return;
    }
    const clamped = clamp(x, -STRIKER_X_LIMIT, STRIKER_X_LIMIT);
    const y = strikerLineY(this.currentShooter);
    this.strikerX = clamped;
    striker.visible = true;
    striker.position.set(clamped, y, striker.position.z);
    const body = this.bodyOf(striker);
    // teleport() also zeroes the velocity, which is what "place the striker" means.
    body?.teleport(clamped, y);
  }

  private parkStriker(): void {
    const striker = this.strikerNode;
    if (!striker) {
      return;
    }
    striker.visible = false;
    striker.position.set(STRIKER_PARK.x, STRIKER_PARK.y, striker.position.z);
    this.bodyOf(striker)?.teleport(STRIKER_PARK.x, STRIKER_PARK.y);
  }

  // -------------------------------------------------------------------------
  // HUD
  // -------------------------------------------------------------------------

  private updateHud(): void {
    this.label('PlayerLeft')?.setText(`${this.onBoard('white')} left`);
    this.label('OpponentLeft')?.setText(`${this.onBoard('black')} left`);

    const pending = this.pendingCoverColour();
    const covered = this.coveredColour();
    const queenText = covered
      ? `Queen: covered by ${covered}`
      : pending
        ? `Queen: ${pending} must cover her now`
        : 'Queen: on board';
    this.label('QueenStatus')?.setText(queenText);
  }

  private setToast(text: string): void {
    this.label('Toast')?.setText(text);
    this.toastTimer = text.length > 0 ? TOAST_SECONDS : 0;
  }

  private tickToast(dt: number): void {
    if (this.toastTimer <= 0) {
      return;
    }
    this.toastTimer -= dt;
    if (this.toastTimer <= 0) {
      this.toastTimer = 0;
      this.label('Toast')?.setText('');
    }
  }

  /** Three bursts over the winner's HUD count, one every 0.18 s. */
  private tickCelebration(dt: number): void {
    if (this.celebrationLeft <= 0) {
      return;
    }
    this.celebrationTimer -= dt;
    if (this.celebrationTimer > 0) {
      return;
    }
    this.celebrationLeft -= 1;
    this.celebrationTimer = WIN_BURST_INTERVAL_SEC;

    const winner = this.winner;
    const anchor = this.label(winner === 'black' ? 'OpponentLeft' : 'PlayerLeft');
    if (!anchor) {
      return;
    }
    const palette = DISC_PALETTE[winner === 'black' ? 'black' : 'white'];
    this.scene?.juice.burst(anchor, {
      count: 26,
      speed: 320,
      colors: [...palette, '#f5ae39'],
      sizePx: 10,
      gravityY: -420,
      lifeSec: 0.7,
    });
  }

  /**
   * After four idle seconds in AIM with nothing touched, pulse the help line
   * every two seconds. A player who has not worked out the gesture is exactly
   * the player who will not read a static caption.
   */
  private tickIdleHint(dt: number): void {
    if ((this.input?.pointerDownCount ?? 0) > 0) {
      this.idleTimer = 0;
      this.idleHintTimer = 0;
      return;
    }
    this.idleTimer += dt;
    if (this.idleTimer < IDLE_HINT_AFTER_SEC) {
      return;
    }
    this.idleHintTimer -= dt;
    if (this.idleHintTimer > 0) {
      return;
    }
    this.idleHintTimer = IDLE_HINT_PERIOD_SEC;
    this.scene?.juice.punchScale('HelpLabel', { amount: IDLE_HINT_PUNCH, duration: 0.5 });
  }

  private hideAimUi(): void {
    const guide = this.findNode('AimGuide');
    if (guide) {
      guide.visible = false;
    }
    const bar = this.findNode('PowerBar');
    if (bar instanceof Bar2D) {
      bar.visible = false;
      bar.value = 0;
    }
  }

  private wireButton(name: string, handler: () => void): void {
    const button = this.findNode(name);
    button?.connect('click', this, handler);
  }

  private label(name: string): Label2D | null {
    const node = this.findNode(name);
    return node instanceof Label2D ? node : null;
  }

  // -------------------------------------------------------------------------
  // Commands + debug provider
  // -------------------------------------------------------------------------

  private registerCommands(): void {
    const commands = this.scene?.commands;
    if (!commands) {
      return;
    }
    this.disposers.push(
      commands.register(
        'restart',
        () => {
          void this.restart();
        },
        { description: 'Rack the 19 pieces, reset the score and give white the break.' }
      ),
      commands.register(
        'shoot',
        args => {
          const angleDeg = readNumber(args?.angleDeg, Number.NaN);
          if (!Number.isFinite(angleDeg)) {
            return;
          }
          const radians = (angleDeg * Math.PI) / 180;
          this.requestShot(
            { x: Math.cos(radians), y: Math.sin(radians) },
            readNumber(args?.power, 1)
          );
        },
        {
          description:
            'Launch the striker. angleDeg is board space (90 = straight up), power is 0..1. Refused outside the forward cone.',
        }
      ),
      commands.register(
        'place-striker',
        args => {
          this.placeStriker(readNumber(args?.x, 0));
        },
        { description: "Slide the striker along the shooter's line to x (clamped to +/-240)." }
      ),
      commands.register(
        'settle',
        () => {
          this.forceStopAll();
          if (this.runState === 'SIMULATE') {
            this.enterResolve();
          }
        },
        { description: 'Force every disc to a dead stop and resolve the strike immediately.' }
      ),
      commands.register(
        'layout',
        args => {
          void this.applyLayout(args);
        },
        {
          description:
            'Clear the board and place exactly these pieces. { discs:[{kind,x,y}], striker?:{x}, shooter?, pocketed?:{white,black}, queen? }',
        }
      ),
      commands.register(
        'ai.toggle',
        args => {
          this.config.aiEnabled = readBoolean(args?.enabled, this.config.aiEnabled !== false);
          this.syncShooterControl();
        },
        { description: 'Enable or disable the AI opponent (black). { enabled: boolean }' }
      ),
      commands.register(
        'autoplay',
        args => {
          this.autoplay = readBoolean(args?.enabled, !this.autoplay);
          this.syncShooterControl();
        },
        { description: 'Let the AI play BOTH colours, for soak runs. { enabled: boolean }' }
      )
    );
  }

  private snapshot(): Record<string, unknown> {
    const striker = this.strikerNode;
    const strikerTransform = striker ? readWorldTransform2D(striker) : null;
    const strikerBody = striker ? this.bodyOf(striker) : null;

    let kineticEnergy = 0;
    const discs = this.men.map(disc => {
      const transform = readWorldTransform2D(disc.node);
      const body = this.bodyOf(disc.node);
      const vx = body?.velocityX ?? 0;
      const vy = body?.velocityY ?? 0;
      kineticEnergy += 0.5 * (vx * vx + vy * vy);
      return {
        id: disc.node.nodeId,
        kind: disc.kind,
        x: round(transform.x),
        y: round(transform.y),
        vx: round(vx),
        vy: round(vy),
        speed: round(Math.hypot(vx, vy)),
        sleeping: body?.isSleeping ?? true,
      };
    });

    if (striker && striker.visible && strikerBody) {
      kineticEnergy +=
        0.5 *
        STRIKER_MASS *
        (strikerBody.velocityX * strikerBody.velocityX +
          strikerBody.velocityY * strikerBody.velocityY);
    }

    return {
      state: this.runState,
      shooter: this.currentShooter,
      whiteLeftOnBoard: this.onBoard('white'),
      blackLeftOnBoard: this.onBoard('black'),
      whitePocketed: this.pocketedCount.white,
      blackPocketed: this.pocketedCount.black,
      due: { white: this.due.white, black: this.due.black },
      queen: this.queenState,
      discs,
      striker: {
        x: round(strikerTransform?.x ?? 0),
        y: round(strikerTransform?.y ?? 0),
        vx: round(strikerBody?.velocityX ?? 0),
        vy: round(strikerBody?.velocityY ?? 0),
        visible: striker?.visible ?? false,
      },
      lastStrike: this.lastStrike,
      kineticEnergy: round(kineticEnergy),
      timeScale: round(this.scene?.time.scale ?? 1),
      settleTimerSec: round(this.settleTimer),
      // Extras beyond the spec's list, useful when driving the AI and end screen.
      aiEnabled: this.config.aiEnabled !== false,
      autoplay: this.autoplay,
      aiDifficulty: clamp(this.numberConfig('aiDifficulty', 0.6), 0, 1),
      aiThinkElapsedSec: round(this.aiThinkTimer),
      winner: this.winner,
      score: this.finalScore,
      pockets: POCKETS.map(pocket => ({ x: pocket.x, y: pocket.y })),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The striker touched something. The count feeds `lastStrike.contacts`; the
   * FIRST contact of a strike is also the one beat the whole shot hangs on, so
   * it drives the hitstop and the camera shake.
   *
   * Edge-triggered on purpose. `GameTime.hitstop` takes the longest single
   * request and warns about a caller that re-arms every frame, and re-arming it
   * per contact would hold gameplay `dt` at 0 through a whole break.
   */
  private handleStrikerContact(...args: unknown[]): void {
    const first = this.strikeContacts === 0;
    this.strikeContacts += 1;

    const scene = this.scene;
    if (!first || !scene || (this.runState !== 'SHOOT' && this.runState !== 'SIMULATE')) {
      return;
    }

    scene.time.hitstop(this.numberConfig('hitstopMs', HITSTOP_MS));

    // Contact signals carry no impulse and are flushed AFTER the solver, so the
    // strength comes from the two previous-frame velocities `user:Disc` keeps.
    const self = velocitySampleOn(this.strikerNode);
    const other = args[0] instanceof NodeBase ? velocitySampleOn(args[0]) : null;
    const relativeX = (self?.lastSpeedX ?? 0) - (other?.lastSpeedX ?? 0);
    const relativeY = (self?.lastSpeedY ?? 0) - (other?.lastSpeedY ?? 0);
    const speed = Math.hypot(relativeX, relativeY);
    if (speed > IMPACT_SHAKE_MIN_SPEED) {
      scene.juice.shake('camera2d', {
        amplitude: clamp(
          speed / IMPACT_SHAKE_SPEED_SCALE,
          IMPACT_SHAKE_MIN_AMPLITUDE,
          IMPACT_SHAKE_MAX_AMPLITUDE
        ),
        duration: IMPACT_SHAKE_DURATION,
        frequency: IMPACT_SHAKE_FREQUENCY,
      });
    }
  }

  private resetStrikeRecord(): void {
    this.strikeContacts = 0;
    this.strikePocketed = [];
    this.strikeFoul = false;
    this.settleTimer = 0;
    this.shotElapsed = 0;
  }

  /** Drop anything left over from a previous game: AI plan, celebration, hints. */
  private resetTransientState(): void {
    this.pendingAiShot = null;
    this.aiThinkTimer = 0;
    this.aiThinkFrames = 0;
    this.celebrationLeft = 0;
    this.celebrationTimer = 0;
    this.idleTimer = 0;
    this.idleHintTimer = 0;
    this.scene?.time.reset();
  }

  private onBoard(colour: Colour): number {
    let count = 0;
    for (const disc of this.men) {
      if (disc.kind === colour) {
        count += 1;
      }
    }
    return count;
  }

  private pendingCoverColour(): Colour | null {
    if (!this.queenState.startsWith(PENDING_PREFIX)) {
      return null;
    }
    return this.queenState.slice(PENDING_PREFIX.length) === 'black' ? 'black' : 'white';
  }

  private coveredColour(): Colour | null {
    if (!this.queenState.startsWith(COVERED_PREFIX)) {
      return null;
    }
    return this.queenState.slice(COVERED_PREFIX.length) === 'black' ? 'black' : 'white';
  }

  /** Every node the simulation has to drive this frame. */
  private activeNodes(): NodeBase[] {
    const nodes = this.men.map(disc => disc.node);
    if (this.strikerNode && this.strikerNode.visible) {
      nodes.push(this.strikerNode);
    }
    return nodes;
  }

  private bodyOf(node: NodeBase): PhysicsBody2DHandle | null {
    return this.scene?.physics2d.getBody(node) ?? null;
  }

  private numberConfig(name: string, fallback: number): number {
    const value = Number(this.config[name]);
    return Number.isFinite(value) ? value : fallback;
  }
}

// ---------------------------------------------------------------------------
// Command-argument parsing (JSON in, typed out)
// ---------------------------------------------------------------------------

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true' || value === 1) {
    return true;
  }
  if (value === 'false' || value === 0) {
    return false;
  }
  return fallback;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readQueenState(value: unknown): QueenState {
  if (typeof value !== 'string') {
    return 'board';
  }
  if (value === 'covered:white' || value === 'covered:black') {
    return value;
  }
  if (value === 'pending-cover:white' || value === 'pending-cover:black') {
    return value;
  }
  return 'board';
}

function readLayoutDiscs(args?: GameCommandArgs): RackEntry[] {
  const raw = args?.discs;
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: RackEntry[] = [];
  for (const item of raw) {
    const record = readRecord(item);
    if (!record) {
      continue;
    }
    const kind = record.kind;
    if (kind !== 'white' && kind !== 'black' && kind !== 'queen') {
      continue;
    }
    entries.push({ kind, x: readNumber(record.x, 0), y: readNumber(record.y, 0) });
  }
  return entries;
}
