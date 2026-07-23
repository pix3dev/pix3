import {
  CASTLE_FLOOR_HP,
  FLAG_HP_BONUS,
  RELOAD_SPECIAL_FACTOR,
  SHOP_ITEMS,
  WEAPON_AMMO,
  WEAPON_DAMAGE,
} from './SdBalance';

export type GameMode = 'campaign' | 'survival';

/**
 * SdSession — the run state that outlives a single battle scene: gold, shop
 * purchases and campaign progress. A plain module singleton (all user scripts
 * share one bundle), persisted to localStorage so a reload can pick a run up.
 *
 * GameFlow owns the *battle* state (castle HP, score, kills); this module owns
 * what the shop sells and the wallet it drains.
 */
interface SessionState {
  mode: GameMode;
  /** 1-based campaign mission. */
  mission: number;
  gold: number;
  owned: string[];
  /** Missions whose post-victory epilogue dialog has already played. */
  epiloguesSeen: number[];
}

const SAVE_KEY = 'skydefender.run.v1';

const startingOwned = (): string[] => SHOP_ITEMS.filter(i => i.startsOwned).map(i => i.id);

let state: SessionState = {
  mode: 'campaign',
  mission: 1,
  gold: 0,
  owned: startingOwned(),
  epiloguesSeen: [],
};

function persist(): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch {
    // Storage may be unavailable (private mode) — the run just won't survive a reload.
  }
}

export const session = {
  get mode(): GameMode {
    return state.mode;
  },
  get mission(): number {
    return state.mission;
  },
  get gold(): number {
    return state.gold;
  },

  /** Fresh run (menu "Campaign"/"Survival" button). */
  resetRun(mode: GameMode): void {
    state = { mode, mission: 1, gold: 0, owned: startingOwned(), epiloguesSeen: [] };
    persist();
  },

  /** Restore a persisted run (returns false when there is none). */
  loadRun(): boolean {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as Partial<SessionState>;
      if (!Array.isArray(parsed.owned) || typeof parsed.gold !== 'number') return false;
      state = {
        mode: parsed.mode === 'survival' ? 'survival' : 'campaign',
        mission: Math.max(1, Number(parsed.mission) || 1),
        gold: Math.max(0, parsed.gold),
        owned: parsed.owned.filter((id): id is string => typeof id === 'string'),
        // Older saves predate epilogues — treat them all as unseen.
        epiloguesSeen: Array.isArray(parsed.epiloguesSeen)
          ? parsed.epiloguesSeen.filter((n): n is number => typeof n === 'number')
          : [],
      };
      return true;
    } catch {
      return false;
    }
  },

  addGold(amount: number): void {
    state.gold = Math.max(0, state.gold + amount);
    persist();
  },

  /** Deducts and reports success; never goes negative. */
  spendGold(amount: number): boolean {
    if (state.gold < amount) return false;
    state.gold -= amount;
    persist();
    return true;
  },

  /** Overwrite the wallet — checkpoint restore on a survival wave failure. */
  setGold(amount: number): void {
    state.gold = Math.max(0, Math.floor(amount));
    persist();
  },

  isOwned(id: string): boolean {
    return state.owned.includes(id);
  },

  own(id: string): void {
    if (!state.owned.includes(id)) {
      state.owned.push(id);
      persist();
    }
  },

  /** Raise campaign progress to `n` (replays never move the frontier back). */
  unlockMission(n: number): void {
    if (n > state.mission) {
      state.mission = n;
      persist();
    }
  },

  /** Post-victory dialogs play once per run (see MapController). */
  isEpilogueSeen(mission: number): boolean {
    return state.epiloguesSeen.includes(mission);
  },

  markEpilogueSeen(mission: number): void {
    if (!state.epiloguesSeen.includes(mission)) {
      state.epiloguesSeen.push(mission);
      persist();
    }
  },

  // ── derived game rules ─────────────────────────────────────────────────────

  /** Highest owned floor tier (1..4). */
  floorTier(): number {
    let tier = 1;
    for (const item of SHOP_ITEMS) {
      if (item.effect === 'floor' && item.tier && this.isOwned(item.id)) {
        tier = Math.max(tier, item.tier);
      }
    }
    return tier;
  },

  maxCastleHp(): number {
    return (CASTLE_FLOOR_HP[this.floorTier()] ?? 700) + (this.isOwned('flag') ? FLAG_HP_BONUS : 0);
  },

  weaponUnlocked(key: string): boolean {
    return this.isOwned(key); // shop weapon ids match WeaponDef keys
  },

  /** Effective per-hit damage for a weapon, given owned special/power items. */
  weaponDamage(key: string): number {
    const table = WEAPON_DAMAGE[key];
    if (!table) return 0;
    const special = table.special && this.isOwned(specialItemId(key));
    const level = this.isOwned(`${key}-power`) ? 1 : 0;
    return (special ? table.special! : table.base)[level];
  },

  /** Effective magazine + reserve for a weapon, given its owned special. */
  weaponAmmo(key: string): { magSize: number; reserve: number } {
    const table = WEAPON_AMMO[key];
    if (!table) return { magSize: 0, reserve: 0 };
    const special = table.special && this.isOwned(specialItemId(key));
    return special ? table.special! : table.base;
  },

  /** Reload-time multiplier (Reload Speed specials for gun/minigun). */
  weaponReloadFactor(key: string): number {
    if ((key === 'gun' || key === 'minigun') && this.isOwned(`${key}-reload`)) {
      return RELOAD_SPECIAL_FACTOR;
    }
    return 1;
  },

  /** JSON view for the debug bridge. */
  debugState(): Record<string, unknown> {
    return { ...state, owned: [...state.owned] };
  },
};

/** Shop id of a weapon's "special" upgrade (fire shells / rail gun). */
function specialItemId(key: string): string {
  return key === 'shotgun' ? 'fire-shells' : key === 'rifle' ? 'rail-gun' : `${key}-reload`;
}
