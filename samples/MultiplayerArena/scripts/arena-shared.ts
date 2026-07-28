/**
 * Shared match state for the arena sample.
 *
 * The three scripts here are deliberately decoupled through this module rather than through the
 * scene tree: avatars arrive at unpredictable times (the local one from `instantiate`, remote ones
 * from `NetworkNodeBinder` when their entity enters AOI), so "find the controller and register with
 * it" is more fragile than a plain module registry. `ArenaController.reset()` clears it on every
 * scene start, because a module survives a play-mode restart and stale avatars would linger.
 */

/** One player's avatar, as the controller and HUD need to see it. */
export interface ArenaAvatar {
  /** Owning client id — `0` while offline (single-player) or before the entity is bound. */
  readonly clientId: number;
  /** World position of the avatar right now. */
  getPosition(): { x: number; y: number };
  /** True for the avatar this client drives. */
  readonly isMine: boolean;
  /** Shows an emote bubble over the avatar. */
  showEmote(text: string): void;
  /** Paints (or clears) the "it" halo. */
  setIt(isIt: boolean): void;
  /** Puts the avatar back on its spawn point; a teleport, not a walk. */
  respawn(): void;
}

export type ArenaPhase = 'play' | 'intermission';

export interface ArenaMatchState {
  phase: ArenaPhase;
  /** Client id of whoever is "it", or 0 when nobody is. */
  itClientId: number;
  /** Seconds left in the current phase. */
  timeLeft: number;
  /** Seconds survived while not "it", per client. */
  scores: Map<number, number>;
  /** Winner of the last round, for the intermission banner. */
  lastWinner: string;
  /** Newest first; the HUD shows the top few. */
  feed: string[];
}

/** The emotes a player can send. Index is what travels on the wire. */
export const ARENA_EMOTES = ['Hi!', 'Catch me!', 'Nice!'] as const;

/** Eight readable, well-separated avatar colors; index is `clientId % 8`. */
export const ARENA_COLORS = [
  '#4ea1ff',
  '#ff6b6b',
  '#5ddd8f',
  '#ffcf33',
  '#b48cff',
  '#ff9f43',
  '#3ad6d6',
  '#f36bd0',
] as const;

/** Live avatars, local and remote. Avatars add themselves on start and remove themselves on detach. */
export const arenaAvatars = new Set<ArenaAvatar>();

export const arenaMatch: ArenaMatchState = {
  phase: 'play',
  itClientId: 0,
  timeLeft: 0,
  scores: new Map(),
  lastWinner: '',
  feed: [],
};

/** Session-level facts the HUD renders and the controller keeps up to date. */
export const arenaSession = {
  online: false,
  isHost: false,
  clientId: 0,
  roomId: '',
  peerCount: 0,
  rtt: 0,
  /** Set when something went wrong that the player should see (spawn refused, join failed). */
  notice: '',
};

export function resetArenaState(): void {
  arenaAvatars.clear();
  arenaMatch.phase = 'play';
  arenaMatch.itClientId = 0;
  arenaMatch.timeLeft = 0;
  arenaMatch.scores = new Map();
  arenaMatch.lastWinner = '';
  arenaMatch.feed = [];
  arenaSession.online = false;
  arenaSession.isHost = false;
  arenaSession.clientId = 0;
  arenaSession.roomId = '';
  arenaSession.peerCount = 0;
  arenaSession.rtt = 0;
  arenaSession.notice = '';
}

/** Adds a line to the on-screen feed, newest first, bounded. */
export function pushFeed(line: string): void {
  arenaMatch.feed.unshift(line);
  if (arenaMatch.feed.length > 4) {
    arenaMatch.feed.length = 4;
  }
}

/**
 * A peer's display name, falling back to the client id.
 *
 * `peers` is small (≤ room cap) so a linear scan is cheaper than maintaining a map that has to be
 * invalidated on every roster change.
 */
export function peerName(
  peers: readonly { clientId: number; displayName: string }[],
  clientId: number
): string {
  if (clientId === 0) {
    return 'you';
  }
  const peer = peers.find(candidate => candidate.clientId === clientId);
  const name = peer?.displayName?.trim();
  return name && name.length > 0 ? name : `player ${clientId}`;
}
