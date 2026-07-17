import { Script } from '@pix3/runtime';
import type { PropertySchema } from '@pix3/runtime';
import type { Texture } from 'three';

/** The Sprite2D bits we poke (setTexture is public on Sprite2D). */
type SpriteNode = { setTexture?: (tex: Texture) => void };

/**
 * PropellerAnim — cycles this Sprite2D's texture through a list of frames at a
 * fixed fps (the remaster's script-driven sequence pattern, like
 * ExplosionEffect). Used for the enemy transporter airship's spinning propeller:
 * a brown animated base (`transporter/00000..00006`) with a static red `over`
 * overlay drawn on top by the prefab. Loops forever.
 */
export class PropellerAnim extends Script {
  private textures: Texture[] = [];
  private timer = 0;
  private frame = 0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      frames: [] as string[],
      fps: 14,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'PropellerAnim',
      properties: [
        {
          name: 'fps',
          type: 'number',
          ui: { label: 'FPS', group: 'Propeller', step: 1 },
          getValue: (c: unknown) => (c as PropellerAnim).config.fps,
          setValue: (c: unknown, v: unknown) => {
            (c as PropellerAnim).config.fps = Number(v);
          },
        },
      ],
      groups: { Propeller: { label: 'Propeller Animation', expanded: true } },
    };
  }

  onStart(): void {
    const loader = this.scene?.getAssetLoader();
    const frames = (this.config.frames as string[]) ?? [];
    if (!loader || frames.length === 0) return;
    frames.forEach((path, i) => {
      void loader
        .loadTexture(path)
        .then(tex => {
          this.textures[i] = tex;
        })
        .catch(() => console.warn(`[PropellerAnim] missing frame ${path}`));
    });
  }

  onUpdate(dt: number): void {
    if (this.textures.length === 0) return;
    this.timer += dt;
    const step = 1 / Math.max(1, Number(this.config.fps) || 14);
    if (this.timer < step) return;
    this.timer -= step;
    this.frame = (this.frame + 1) % this.textures.length;
    const tex = this.textures[this.frame];
    if (tex) (this.node as unknown as SpriteNode).setTexture?.(tex);
  }
}
