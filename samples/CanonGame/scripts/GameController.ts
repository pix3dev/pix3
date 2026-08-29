import { Script, type NodeBase } from '@pix3/runtime';
import { Vector3 } from 'three';
import { registerGameDebug } from '@pix3/runtime';

interface Body {
  node: NodeBase;
  vel: Vector3;
  ang: Vector3;
  hx: number;
  hy: number;
  hz: number;
  mass: number;
  active: boolean; // integrated (dynamic) this frame
  inPlay: boolean; // participates in collisions
  isBall: boolean;
  isKing: boolean;
  knocked: boolean;
  rest: { x: number; y: number; z: number };
  life: number; // seconds alive (balls)
  restTimer: number; // seconds spent nearly still (balls)
}

interface LevelDef {
  group: string;
  shots: number;
}

const GRAVITY = 18;
const DT = 1 / 60;
const MAX_SUBSTEPS = 5;
const DAMP_LIN = 0.99;
const DAMP_ANG = 0.96;
const RESTITUTION = 0.22;
const GROUND_FRICTION = 0.78;
const ACTIVATE_SPEED = 1.0;
const BALL_SPEED = 19;
const BALL_RADIUS = 0.3;
const KNOCK_DIST = 0.7;
const KNOCK_Y = 0.28;

export class GameController extends Script {
  private levels: LevelDef[] = [
    { group: 'Tower_L1', shots: 5 },
    { group: 'Tower_L2', shots: 6 },
  ];
  private levelIndex = 0;

  private levelBlocks: Body[][] = [];
  private balls: Body[] = [];
  private curBlocks: Body[] = [];

  private cannon: NodeBase | null = null;

  private shotsLeft = 0;
  private kingsLeft = 0;
  private kingsTotal = 0;
  private destroyedPct = 0;
  private stars = 0;
  private state: 'play' | 'win' | 'lose' = 'play';

  private accumulator = 0;
  private loseTimer = 0;
  private disposeDebug: (() => void) | null = null;

  onStart(): void {
    // Gather block bodies for each level.
    this.levelBlocks = this.levels.map(def => {
      const group = this.findNode(def.group);
      const bodies: Body[] = [];
      if (group) {
        for (const child of group.children) {
          const node = child as unknown as NodeBase;
          if (!node || typeof (node as { name?: string }).name !== 'string') continue;
          bodies.push(this.makeBlockBody(node));
        }
      }
      return bodies;
    });

    // Gather ball pool.
    const ballGroup = this.findNode('Balls');
    this.balls = [];
    if (ballGroup) {
      for (const child of ballGroup.children) {
        const node = child as unknown as NodeBase;
        this.balls.push({
          node,
          vel: new Vector3(),
          ang: new Vector3(),
          hx: BALL_RADIUS,
          hy: BALL_RADIUS,
          hz: BALL_RADIUS,
          mass: 1.6,
          active: false,
          inPlay: false,
          isBall: true,
          isKing: false,
          knocked: false,
          rest: { x: node.position.x, y: node.position.y, z: node.position.z },
          life: 0,
          restTimer: 0,
        });
        node.visible = false;
      }
    }

    this.cannon = this.findNode('Cannon');

    // Camera aim at the tower.
    const cam = this.findNode('Main Camera');
    if (cam && typeof (cam as unknown as { lookAt?: (x: number, y: number, z: number) => void }).lookAt === 'function') {
      (cam as unknown as { lookAt: (x: number, y: number, z: number) => void }).lookAt(0, 1.2, 2);
    }

    this.disposeDebug = registerGameDebug({
      name: 'SmashFigesh',
      snapshot: () => ({
        level: this.levelIndex + 1,
        shots: this.shotsLeft,
        kingsLeft: this.kingsLeft,
        destroyedPct: Math.round(this.destroyedPct),
        stars: this.stars,
        state: this.state,
      }),
      reset: () => {
        this.levelIndex = 0;
        this.loadLevel(0);
      },
    });

    this.wireButtons();
    this.loadLevel(0);
  }

  onDetach(): void {
    if (this.disposeDebug) this.disposeDebug();
    super.onDetach();
  }

  private makeBlockBody(node: NodeBase): Body {
    const name = (node as { name: string }).name;
    return {
      node,
      vel: new Vector3(),
      ang: new Vector3(),
      hx: 0.5,
      hy: 0.5,
      hz: 0.5,
      mass: 1,
      active: false,
      inPlay: true,
      isBall: false,
      isKing: name.includes('King'),
      knocked: false,
      rest: { x: node.position.x, y: node.position.y, z: node.position.z },
      life: 0,
      restTimer: 0,
    };
  }

  private wireButtons(): void {
    const retry = this.findNode('RetryButton');
    const next = this.findNode('NextButton');
    const connect = (n: NodeBase | null, cb: () => void) => {
      if (!n) return;
      (n as unknown as { connect: (s: string, t: unknown, h: () => void) => void }).connect(
        'click',
        this,
        cb
      );
    };
    connect(retry, () => this.loadLevel(this.levelIndex));
    connect(next, () => {
      const nextIdx = (this.levelIndex + 1) % this.levels.length;
      this.loadLevel(nextIdx);
    });
  }

  private loadLevel(index: number): void {
    this.levelIndex = index;
    const def = this.levels[index];

    // Toggle tower group visibility.
    this.levels.forEach((l, i) => {
      const g = this.findNode(l.group);
      if (g) g.visible = i === index;
    });

    this.curBlocks = this.levelBlocks[index];
    this.kingsTotal = 0;
    for (const b of this.curBlocks) {
      b.node.position.set(b.rest.x, b.rest.y, b.rest.z);
      b.node.rotation.set(0, 0, 0);
      b.node.visible = true;
      b.vel.set(0, 0, 0);
      b.ang.set(0, 0, 0);
      b.active = false;
      b.knocked = false;
      if (b.isKing) this.kingsTotal++;
    }

    for (const ball of this.balls) {
      ball.node.visible = false;
      ball.node.position.set(ball.rest.x, ball.rest.y, ball.rest.z);
      ball.node.rotation.set(0, 0, 0);
      ball.vel.set(0, 0, 0);
      ball.ang.set(0, 0, 0);
      ball.active = false;
      ball.inPlay = false;
      ball.life = 0;
      ball.restTimer = 0;
    }

    this.shotsLeft = def.shots;
    this.kingsLeft = this.kingsTotal;
    this.destroyedPct = 0;
    this.stars = 0;
    this.state = 'play';
    this.loseTimer = 0;
    this.accumulator = 0;

    this.setOverlay(false);
    this.setLabel('HintLabel', 'Тапни, чтобы выстрелить', true);
    this.updateHud();
  }

  onUpdate(dt: number): void {
    // Handle taps (shoot) — only in play state.
    if (this.state === 'play' && this.input) {
      for (const ev of this.input.pointerEvents) {
        if (ev.type === 'down') {
          this.shoot(ev.x, ev.y);
          break;
        }
      }
    }

    // Fixed-step physics.
    this.accumulator += Math.min(dt, 0.1);
    let steps = 0;
    while (this.accumulator >= DT && steps < MAX_SUBSTEPS) {
      this.step(DT);
      this.accumulator -= DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;

    this.evaluate(dt);
  }

  private shoot(px: number, py: number): void {
    if (this.shotsLeft <= 0) return;
    const ball = this.balls.find(b => !b.inPlay);
    if (!ball) return;

    const w = Math.max(1, this.input?.width ?? 1080);
    const h = Math.max(1, this.input?.height ?? 1920);
    const nx = px / w; // 0..1 left→right
    const ny = py / h; // 0..1 top→bottom

    const yaw = (nx - 0.5) * 1.2; // radians
    const t = 1 - ny; // top of screen = 1
    const pitch = (15 + t * 55) * (Math.PI / 180);

    const cp = this.cannon ? this.cannon.position : new Vector3(0, 1, -3.6);
    ball.node.position.set(cp.x, cp.y + 0.3, cp.z + 0.4);
    ball.node.rotation.set(0, 0, 0);
    const cosP = Math.cos(pitch);
    ball.vel.set(
      Math.sin(yaw) * cosP * BALL_SPEED,
      Math.sin(pitch) * BALL_SPEED,
      Math.cos(yaw) * cosP * BALL_SPEED
    );
    ball.ang.set(0, 0, 0);
    ball.active = true;
    ball.inPlay = true;
    ball.life = 0;
    ball.restTimer = 0;
    ball.node.visible = true;

    this.shotsLeft--;
    this.scene?.audio.sfx('laser');
    this.setLabel('HintLabel', '', true);
    this.updateHud();
  }

  private step(dt: number): void {
    const bodies: Body[] = [];
    for (const b of this.curBlocks) bodies.push(b);
    for (const b of this.balls) if (b.inPlay) bodies.push(b);

    // Integrate dynamic bodies.
    for (const b of bodies) {
      if (!b.active) continue;
      b.vel.y -= GRAVITY * dt;
      b.node.position.x += b.vel.x * dt;
      b.node.position.y += b.vel.y * dt;
      b.node.position.z += b.vel.z * dt;
      b.node.rotation.x += b.ang.x * dt;
      b.node.rotation.y += b.ang.y * dt;
      b.node.rotation.z += b.ang.z * dt;
      b.vel.multiplyScalar(DAMP_LIN);
      b.ang.multiplyScalar(DAMP_ANG);

      // Ground.
      const floor = b.hy;
      if (b.node.position.y < floor) {
        b.node.position.y = floor;
        if (b.vel.y < 0) b.vel.y = -b.vel.y * RESTITUTION;
        b.vel.x *= GROUND_FRICTION;
        b.vel.z *= GROUND_FRICTION;
        b.ang.multiplyScalar(0.85);
      }

      if (b.isBall) {
        b.life += dt;
        const speed = b.vel.length();
        if (speed < 0.5 && b.node.position.y <= floor + 0.05) {
          b.restTimer += dt;
        } else {
          b.restTimer = 0;
        }
      }
    }

    // Collisions (pairwise).
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        this.resolve(bodies[i], bodies[j]);
      }
    }
  }

  private resolve(a: Body, b: Body): void {
    if (!a.active && !b.active) return;

    const ax = a.node.position.x, ay = a.node.position.y, az = a.node.position.z;
    const bx = b.node.position.x, by = b.node.position.y, bz = b.node.position.z;

    const dx = bx - ax;
    const ox = a.hx + b.hx - Math.abs(dx);
    if (ox <= 0) return;
    const dy = by - ay;
    const oy = a.hy + b.hy - Math.abs(dy);
    if (oy <= 0) return;
    const dz = bz - az;
    const oz = a.hz + b.hz - Math.abs(dz);
    if (oz <= 0) return;

    // Min penetration axis → collision normal (from a to b).
    let nx = 0, ny = 0, nz = 0, pen = ox;
    if (ox <= oy && ox <= oz) {
      nx = dx < 0 ? -1 : 1;
      pen = ox;
    } else if (oy <= ox && oy <= oz) {
      ny = dy < 0 ? -1 : 1;
      pen = oy;
    } else {
      nz = dz < 0 ? -1 : 1;
      pen = oz;
    }

    // Relative velocity along normal.
    const rvx = b.vel.x - a.vel.x;
    const rvy = b.vel.y - a.vel.y;
    const rvz = b.vel.z - a.vel.z;
    const velAlongN = rvx * nx + rvy * ny + rvz * nz;

    // Wake inactive blocks that are hit hard enough → cascade.
    const approach = Math.abs(velAlongN);
    if (!a.active && b.active && approach > ACTIVATE_SPEED) this.wake(a);
    if (!b.active && a.active && approach > ACTIVATE_SPEED) this.wake(b);

    const invA = a.active ? 1 / a.mass : 0;
    const invB = b.active ? 1 / b.mass : 0;
    const totalInv = invA + invB;
    if (totalInv === 0) return;

    // Positional correction.
    const corr = pen / totalInv;
    a.node.position.x -= nx * corr * invA;
    a.node.position.y -= ny * corr * invA;
    a.node.position.z -= nz * corr * invA;
    b.node.position.x += nx * corr * invB;
    b.node.position.y += ny * corr * invB;
    b.node.position.z += nz * corr * invB;

    if (velAlongN > 0) return; // separating

    const jImp = (-(1 + RESTITUTION) * velAlongN) / totalInv;
    a.vel.x -= nx * jImp * invA;
    a.vel.y -= ny * jImp * invA;
    a.vel.z -= nz * jImp * invA;
    b.vel.x += nx * jImp * invB;
    b.vel.y += ny * jImp * invB;
    b.vel.z += nz * jImp * invB;

    // A little spin for juice on struck blocks.
    const spin = Math.min(6, approach) * 0.4;
    if (invA > 0 && !a.isBall) {
      a.ang.x += (Math.random() - 0.5) * spin;
      a.ang.z += (Math.random() - 0.5) * spin;
    }
    if (invB > 0 && !b.isBall) {
      b.ang.x += (Math.random() - 0.5) * spin;
      b.ang.z += (Math.random() - 0.5) * spin;
    }
  }

  private wake(b: Body): void {
    if (b.active) return;
    b.active = true;
    b.ang.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2);
  }

  private evaluate(dt: number): void {
    // Deactivate settled balls.
    for (const ball of this.balls) {
      if (!ball.inPlay) continue;
      if (ball.restTimer > 0.5 || ball.life > 6 || ball.node.position.y < -3) {
        ball.active = false;
        ball.inPlay = false;
        ball.node.visible = false;
      }
    }

    if (this.state !== 'play') return;

    // Knock detection.
    let knockedCount = 0;
    let newKingDown = false;
    for (const b of this.curBlocks) {
      const dispX = b.node.position.x - b.rest.x;
      const dispZ = b.node.position.z - b.rest.z;
      const dist = Math.hypot(dispX, dispZ);
      const down = dist > KNOCK_DIST || b.node.position.y < KNOCK_Y;
      if (down && !b.knocked) {
        b.knocked = true;
        if (b.isKing) newKingDown = true;
      }
      if (b.knocked) knockedCount++;
    }
    if (newKingDown) {
      this.kingsLeft = this.curBlocks.filter(b => b.isKing && !b.knocked).length;
      this.scene?.audio.sfx('explosion');
      this.scene?.juice.shake('camera', { amplitude: 10, duration: 250 });
      this.updateHud();
    }
    this.destroyedPct =
      this.curBlocks.length > 0 ? (knockedCount / this.curBlocks.length) * 100 : 0;

    // Win.
    if (this.kingsLeft <= 0) {
      this.win();
      return;
    }

    // Lose: out of shots and everything settled.
    const anyBall = this.balls.some(b => b.inPlay);
    if (this.shotsLeft <= 0 && !anyBall) {
      this.loseTimer += dt;
      if (this.loseTimer > 1.0) this.lose();
    } else {
      this.loseTimer = 0;
    }
  }

  private win(): void {
    this.state = 'win';
    this.stars = 1 + (this.destroyedPct >= 60 ? 1 : 0) + (this.destroyedPct >= 90 ? 1 : 0);
    this.scene?.audio.sfx('win');
    this.setLabel('ResultLabel', 'Победа!', false);
    this.setLabel('StarsLabel', '★★★☆☆☆'.slice(3 - this.stars, 6 - this.stars), false);
    this.setOverlay(true);
    this.updateHud();
  }

  private lose(): void {
    this.state = 'lose';
    this.scene?.audio.sfx('lose');
    this.setLabel('ResultLabel', 'Поражение', false);
    this.setLabel('StarsLabel', 'Короли устояли', false);
    this.setOverlay(true);
  }

  private updateHud(): void {
    this.setLabel('ShotsLabel', `Выстрелы: ${this.shotsLeft}`, true);
    this.setLabel('KingsLabel', `Короли: ${this.kingsLeft}`, true);
  }

  private setLabel(name: string, text: string, keepVisible: boolean): void {
    const n = this.findNode(name);
    if (!n) return;
    const withSetter = n as unknown as { setText?: (t: string) => void };
    if (typeof withSetter.setText === 'function') withSetter.setText(text);
    else (n as unknown as { label: string }).label = text;
    if (keepVisible) n.visible = true;
  }

  private setOverlay(show: boolean): void {
    const overlay = this.findNode('ResultOverlay');
    if (overlay) overlay.visible = show;
  }
}
