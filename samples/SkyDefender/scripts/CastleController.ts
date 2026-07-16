import { Script } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import { session } from './SdSession';

/**
 * CastleController — the castle's *visual* state (GameFlow owns the HP math):
 * shows the floor sprites the shop has sold, moves the main gun up onto
 * Floor 2 when it appears (GDD: "сюда переезжает главная пушка"), raises the
 * flag and arms the turrets on their floors. Reacts to `purchase(itemId)` on
 * `game-root` and applies the whole owned set on start (mid-campaign waves).
 */
export class CastleController extends Script {
  private maingunBaseY: number | null = null;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      // Gun carriage lift when Floor 2 exists (one floor of masonry = 55 px).
      gunLift: 55,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'CastleController',
      properties: [
        {
          name: 'gunLift',
          type: 'number',
          ui: { label: 'Gun Lift (px)', group: 'Castle', step: 1 },
          getValue: (c: unknown) => (c as CastleController).config.gunLift,
          setValue: (c: unknown, v: unknown) => {
            (c as CastleController).config.gunLift = Number(v);
          },
        },
      ],
      groups: { Castle: { label: 'Castle', expanded: true } },
    };
  }

  onStart(): void {
    this.findNode('game-root')?.connect('purchase', this, () => this.refresh());
    this.refresh();
  }

  private refresh(): void {
    const tier = session.floorTier();

    // Floors 2..4 stack above the base floor as they are bought.
    this.setVisible('floor-2', tier >= 2);
    this.setVisible('floor-3', tier >= 3);
    this.setVisible('floor-4', tier >= 4);

    // The main gun moves up onto Floor 2 once it exists.
    const maingun = this.findNode('maingun');
    if (maingun) {
      if (this.maingunBaseY === null) {
        this.maingunBaseY = maingun.position.y;
      }
      const lift = tier >= 2 ? Number(this.config.gunLift) : 0;
      maingun.position.y = this.maingunBaseY + lift;
    }

    // Flag on the gate tower.
    this.setVisible('castle-flag', session.isOwned('flag'));

    // Turrets arm when bought (their floors gate the shop items already).
    this.setVisible('turret-tr1', session.isOwned('turret-1'));
    this.setVisible('turret-tr2', session.isOwned('turret-2'));
    this.setVisible('turret-aa', session.isOwned('air-gun'));
  }

  private setVisible(id: string, visible: boolean): void {
    const node = this.findNode(id) as NodeBase | null;
    if (node && node.visible !== visible) {
      node.visible = visible;
    }
  }
}
