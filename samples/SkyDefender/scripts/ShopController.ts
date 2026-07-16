import { Script } from '@pix3/runtime';
import type { Button2D, Label2D, NodeBase, PropertySchema } from '@pix3/runtime';
import type { Texture } from 'three';
import { SHOP_BG_NATIVE, SHOP_ITEMS, type ShopItem } from './SdBalance';
import { session } from './SdSession';

const ITEM_PREFAB = 'res://src/assets/prefabs/shop-item.pix3scene';
const ICON_DIR = 'res://src/assets/textures/gui/shop';
const SFX_BUY = 'res://src/assets/audio/gui/shop/shop_buy.mp3';
const SFX_REPAIR = 'res://src/assets/audio/gui/shop/shop_repair.mp3';
const SFX_DENY = 'res://src/assets/audio/guns/main/out_of_ammo.mp3';
const SFX_MONEY = 'res://src/assets/audio/other/money.mp3';

/** UIControl2D hides its canvas-text refresh behind a protected method. */
type RuntimeLabel2D = Label2D & { updateLabel(): void };
/** Runtime Button2D surface used here (setStateTexture is public API). */
type RuntimeButton2D = Button2D & {
  setStateTexture(state: 'normal' | 'hover' | 'pressed' | 'disabled', tex: Texture | null): void;
  onHoverEnter?: () => void;
};

interface ItemSlot {
  item: ShopItem;
  button: RuntimeButton2D;
  noway: NodeBase | null;
  dark: Texture | null;
  gold: Texture | null;
}

/** The baked shop panel is authored at ×1.7 of its native 590×480 pixels. */
const PANEL_SCALE = 1003 / SHOP_BG_NATIVE.width;
/** shop-bg sprite position inside the overlay. */
const PANEL_OFFSET_Y = 60;

/**
 * ShopController — the original 24-position Upgrades shop (M4). Lives on the
 * `shop-overlay` node; GameFlow opens/closes it via `shop-opened`/`shop-closed`
 * signals on `game-root`. Item cells are instantiated over the icon grid baked
 * into gui/shop/shop_bg.png (dark icon = not owned, golden `_buy` icon =
 * owned/hover, noway badge = missing prerequisite). Purchases go through
 * SdSession; every buy emits `purchase(itemId)` on `game-root` so the castle,
 * gun and HUD can react immediately.
 */
export class ShopController extends Script {
  private slots: ItemSlot[] = [];
  private built = false;
  private building = false;
  private open = false;
  private infoName: RuntimeLabel2D | null = null;
  private infoDesc: RuntimeLabel2D | null = null;
  private goldLabel: RuntimeLabel2D | null = null;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      itemsNode: 'shop-items',
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'ShopController',
      properties: [
        {
          name: 'itemsNode',
          type: 'string',
          ui: { label: 'Items Group', group: 'Shop' },
          getValue: (c: unknown) => (c as ShopController).config.itemsNode,
          setValue: (c: unknown, v: unknown) => {
            (c as ShopController).config.itemsNode = String(v);
          },
        },
      ],
      groups: { Shop: { label: 'Shop', expanded: true } },
    };
  }

  onStart(): void {
    this.infoName = this.findNode('shop-info-name') as RuntimeLabel2D | null;
    this.infoDesc = this.findNode('shop-info-desc') as RuntimeLabel2D | null;
    this.goldLabel = this.findNode('shop-gold-label') as RuntimeLabel2D | null;

    const gameRoot = this.findNode('game-root');
    gameRoot?.connect('shop-opened', this, () => {
      void this.onOpened();
    });
    gameRoot?.connect('shop-closed', this, () => this.onClosed());
    // Purchases can also arrive from outside the grid (debug bridge 'buy').
    gameRoot?.connect('purchase', this, () => {
      if (this.open) this.refreshAll();
    });
  }

  onUpdate(): void {
    if (!this.open) return;
    this.setLabel(this.goldLabel, `${Math.floor(session.gold)}`);
  }

  // ── open / close ────────────────────────────────────────────────────────────

  private async onOpened(): Promise<void> {
    this.open = true;
    this.showInfo(null);
    if (!this.built && !this.building) {
      this.building = true;
      try {
        await this.build();
        this.built = true;
      } catch (err) {
        console.warn('[Shop] build failed', err);
      }
      this.building = false;
    }
    // The shop may have been closed again while the grid was instantiating.
    this.applyOpenState();
    this.refreshAll();
  }

  private onClosed(): void {
    this.open = false;
    this.applyOpenState();
  }

  /** Invisible controls still hit-test, so gate every button on `enabled`. */
  private applyOpenState(): void {
    for (const slot of this.slots) {
      slot.button.enabled = this.open;
    }
  }

  // ── grid construction ───────────────────────────────────────────────────────

  private async build(): Promise<void> {
    const scene = this.scene;
    const loader = scene?.getAssetLoader();
    if (!scene || !loader) return;

    const loadIcon = async (name: string): Promise<Texture | null> => {
      try {
        return await loader.loadTexture(`${ICON_DIR}/${name}.png`);
      } catch {
        console.warn(`[Shop] missing icon ${name}`);
        return null;
      }
    };

    await Promise.all(
      SHOP_ITEMS.map(async item => {
        const [dark, gold] = await Promise.all([loadIcon(item.icon), loadIcon(`${item.icon}_buy`)]);
        const node = await scene.instantiate(ITEM_PREFAB, {
          parent: String(this.config.itemsNode),
        });
        const button = node as RuntimeButton2D;
        // Addressable per-item name (debug tooling taps by node name).
        button.name = `shop-${item.id}`;

        // Cell centers: native 50×50 cells inside the 590×480 panel, ×1.7.
        const cx = item.cell[0] + 25;
        const cy = item.cell[1] + 25;
        button.position.set(
          (cx - SHOP_BG_NATIVE.width / 2) * PANEL_SCALE,
          (SHOP_BG_NATIVE.height / 2 - cy) * PANEL_SCALE + PANEL_OFFSET_Y,
          0
        );

        if (dark) button.setStateTexture('normal', dark);
        if (gold) {
          button.setStateTexture('hover', gold);
          button.setStateTexture('pressed', gold);
        }
        if (dark) button.setStateTexture('disabled', dark);

        button.onHoverEnter = () => {
          if (this.open) this.showInfo(item);
        };
        button.connect('click', this, () => this.onItemClicked(item));

        this.slots.push({
          item,
          button,
          noway: (button.children.find(c => {
            const child = c as NodeBase;
            return child.nodeId?.includes('noway-mark') || child.name === 'No Way';
          }) ?? null) as NodeBase | null,
          dark,
          gold,
        });
      })
    );
  }

  // ── state → visuals ────────────────────────────────────────────────────────

  private refreshAll(): void {
    for (const slot of this.slots) {
      this.refreshSlot(slot);
    }
    this.setLabel(this.goldLabel, `${Math.floor(session.gold)}`);
  }

  private refreshSlot(slot: ItemSlot): void {
    const { item, button } = slot;
    const owned = session.isOwned(item.id);
    const locked = !!item.requires && !session.isOwned(item.requires);
    // Owned cells glow golden permanently; unowned show the dark icon until hover.
    if (owned && slot.gold) {
      button.setStateTexture('normal', slot.gold);
    } else if (slot.dark) {
      button.setStateTexture('normal', slot.dark);
    }
    if (slot.noway) slot.noway.visible = locked && !owned;
  }

  // ── buying ─────────────────────────────────────────────────────────────────

  private onItemClicked(item: ShopItem): void {
    if (!this.open) return;
    const audio = this.scene?.audio;

    if (session.isOwned(item.id) && !item.repeatable) {
      this.showInfo(item);
      return;
    }
    if (item.requires && !session.isOwned(item.requires)) {
      audio?.play(SFX_DENY, { bus: 'sfx' });
      this.showInfo(item, `Requires: ${this.itemName(item.requires)}`);
      return;
    }
    if (!session.spendGold(item.price)) {
      audio?.play(SFX_DENY, { bus: 'sfx' });
      this.showInfo(item, 'Not enough gold!');
      return;
    }

    if (!item.repeatable) {
      session.own(item.id);
    }
    audio?.play(item.effect === 'repair' ? SFX_REPAIR : SFX_BUY, { bus: 'sfx' });
    audio?.play(SFX_MONEY, { bus: 'sfx', volumeVariation: 0.1 });
    // Consumers (GameFlow economy, CastleController floors, GunController
    // unlocks) all react to this one signal.
    this.findNode('game-root')?.emit('purchase', item.id);
    this.refreshAll();
    this.showInfo(item);
  }

  private itemName(id: string): string {
    return SHOP_ITEMS.find(i => i.id === id)?.name ?? id;
  }

  // ── info panel ─────────────────────────────────────────────────────────────

  private showInfo(item: ShopItem | null, warning?: string): void {
    if (!item) {
      this.setLabel(this.infoName, 'UPGRADES');
      this.setLabel(this.infoDesc, 'Hover an item for details. Click to buy.');
      return;
    }
    const owned = session.isOwned(item.id) && !item.repeatable;
    const title = warning
      ? `${item.name} — ${warning}`
      : owned
        ? `${item.name} — OWNED`
        : item.price > 0
          ? `${item.name} — ${item.price} gold`
          : item.name;
    this.setLabel(this.infoName, title);
    this.setLabel(this.infoDesc, item.desc);
  }

  private setLabel(label: RuntimeLabel2D | null, text: string): void {
    if (!label || label.label === text) return;
    label.label = text;
    label.updateLabel();
  }
}
