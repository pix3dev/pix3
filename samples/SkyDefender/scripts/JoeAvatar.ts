import { Script, Sprite2D } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import type { Texture } from 'three';

const TEXTURES = {
  main: 'res://src/assets/textures/npc/joe/main.png',
  smile: 'res://src/assets/textures/npc/joe/smile1.png',
  dead: 'res://src/assets/textures/npc/joe/dead.png',
};

/**
 * JoeAvatar — Joe's HUD portrait (bottom-left cluster, original layout):
 * - Blinking: the `eye.png` overlay flashes on at random intervals.
 * - Shoot: a tiny recoil jolt of the portrait on the gun's `fired` signal.
 * - Kill: a short grin (`smile1.png`) when a unit dies.
 * - Dead: on DEFEAT (`game-over` false) the portrait becomes the T-800 sprite.
 */
export class JoeAvatar extends Script {
  private baseX = 0;
  private blinkIn = 2;
  private blinkLeft = 0;
  private recoilLeft = 0;
  private smileLeft = 0;
  private dead = false;
  private eye: NodeBase | null = null;
  private textures: Partial<Record<keyof typeof TEXTURES, Texture>> = {};

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      gunNode: 'maingun',
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'JoeAvatar',
      properties: [
        {
          name: 'gunNode',
          type: 'string',
          ui: { label: 'Gun Node', description: 'Node whose "fired" signal triggers recoil', group: 'Joe' },
          getValue: (c: unknown) => (c as JoeAvatar).config.gunNode,
          setValue: (c: unknown, v: unknown) => {
            (c as JoeAvatar).config.gunNode = String(v);
          },
        },
      ],
      groups: { Joe: { label: 'Joe', expanded: true } },
    };
  }

  onStart(): void {
    if (this.node) {
      this.baseX = this.node.position.x;
    }
    this.eye = this.findNode('joe-eye');
    if (this.eye) this.eye.visible = false;

    const loader = this.scene?.getAssetLoader();
    if (loader) {
      (Object.keys(TEXTURES) as Array<keyof typeof TEXTURES>).forEach(key => {
        void loader.loadTexture(TEXTURES[key])
          .then(tex => { this.textures[key] = tex; })
          .catch(() => undefined);
      });
    }

    const gun = this.findNode(String(this.config.gunNode));
    gun?.connect('fired', this, () => {
      this.recoilLeft = 0.08;
    });

    const gameRoot = this.findNode('game-root');
    gameRoot?.connect('unit-killed', this, () => {
      if (!this.dead) this.smileLeft = 0.9;
    });
    gameRoot?.connect('game-over', this, (victory: unknown) => {
      if (!victory) this.die();
    });
  }

  private setPortrait(key: keyof typeof TEXTURES): void {
    const sprite = this.node;
    const tex = this.textures[key];
    if (sprite instanceof Sprite2D && tex) {
      sprite.setTexture(tex);
    }
  }

  private die(): void {
    if (this.dead) return;
    this.dead = true;
    this.smileLeft = 0;
    if (this.eye) this.eye.visible = false;
    this.setPortrait('dead');
  }

  onUpdate(dt: number): void {
    if (!this.node || this.dead) return;

    // Shoot recoil (portrait jolts left, snaps back).
    if (this.recoilLeft > 0) {
      this.recoilLeft -= dt;
      this.node.position.x = this.baseX - 3;
    } else {
      this.node.position.x = this.baseX;
    }

    // Kill grin.
    if (this.smileLeft > 0) {
      this.smileLeft -= dt;
      this.setPortrait(this.smileLeft > 0 ? 'smile' : 'main');
    }

    // Random blink (skip while grinning — the smile art has its own eyes).
    if (this.eye && this.smileLeft <= 0) {
      if (this.blinkLeft > 0) {
        this.blinkLeft -= dt;
        if (this.blinkLeft <= 0) this.eye.visible = false;
      } else {
        this.blinkIn -= dt;
        if (this.blinkIn <= 0) {
          this.eye.visible = true;
          this.blinkLeft = 0.12;
          this.blinkIn = 1.5 + Math.random() * 3.5;
        }
      }
    }
  }
}
