import { getNodePropertySchema, getPropertyDefinition, Script, setNodePropertyValue } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import { arenaMatch, arenaSession, peerName } from './arena-shared';

/**
 * Renders the match onto the HUD labels.
 *
 * Deliberately read-only: it owns no state and sends nothing. Everything it shows comes from
 * `arena-shared`, which the controller keeps current — so a HUD bug can never desync a match, and
 * the same labels tell you at a glance whether the netcode is alive (ping, player count, "it").
 */
export class ArenaHud extends Script {
  private timer = 0;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = { refreshHz: 6 };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'ArenaHud',
      properties: [
        {
          name: 'refreshHz',
          type: 'number',
          ui: { label: 'Refresh (Hz)', group: 'HUD', min: 1, max: 30, step: 1 },
          getValue: (c: unknown) => (c as ArenaHud).config.refreshHz,
          setValue: (c: unknown, v: unknown) => {
            (c as ArenaHud).config.refreshHz = Number(v);
          },
        },
      ],
      groups: { HUD: { label: 'Arena HUD', expanded: true } },
    };
  }

  onStart(): void {
    this.refresh();
  }

  onUpdate(dt: number): void {
    // Text labels rasterize to a canvas texture, so rewriting them every frame is pure waste; a few
    // times a second reads as live.
    this.timer -= dt;
    if (this.timer > 0) {
      return;
    }
    this.timer = 1 / Math.max(1, Number(this.config.refreshHz) || 6);
    this.refresh();
  }

  private refresh(): void {
    const peers = this.scene?.network.peers ?? [];

    const status = arenaSession.online
      ? `room ${arenaSession.roomId} · ${arenaSession.peerCount} player${
          arenaSession.peerCount === 1 ? '' : 's'
        } · ${arenaSession.rtt} ms${arenaSession.isHost ? ' · host' : ''}`
      : 'Offline — press Play Online to open a room';
    this.setLabel('Status', arenaSession.notice ? `${status}\n${arenaSession.notice}` : status);

    if (!arenaSession.online) {
      this.setLabel('Round', '');
      this.setLabel('Scoreboard', '');
      this.setLabel('Feed', '');
      return;
    }

    const seconds = Math.max(0, Math.round(arenaMatch.timeLeft));
    this.setLabel(
      'Round',
      arenaMatch.phase === 'intermission'
        ? arenaMatch.lastWinner
          ? `${arenaMatch.lastWinner} wins — next round in ${seconds}s`
          : `next round in ${seconds}s`
        : `${it(arenaMatch.itClientId, peers)} · ${seconds}s left`
    );

    const rows = [...arenaMatch.scores]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([clientId, score]) => {
        const name =
          clientId === arenaSession.clientId ? 'you' : peerName(peers, clientId);
        const marker = clientId === arenaMatch.itClientId ? '★ ' : '';
        return `${marker}${name}  ${Math.round(score)}s`;
      });
    this.setLabel('Scoreboard', rows.length > 0 ? rows.join('\n') : 'no scores yet');

    this.setLabel('Feed', arenaMatch.feed.join('\n'));
  }

  private setLabel(name: string, text: string): void {
    const node = this.node?.children.find(child => (child as NodeBase).name === name) as
      | NodeBase
      | undefined;
    if (!node) {
      return;
    }
    const definition = getPropertyDefinition(getNodePropertySchema(node), 'label');
    if (definition && definition.getValue(node) !== text) {
      setNodePropertyValue(node, definition, text);
    }
  }
}

function it(clientId: number, peers: readonly { clientId: number; displayName: string }[]): string {
  if (clientId === 0) {
    return 'waiting for players';
  }
  return `${peerName(peers, clientId)} is it`;
}
