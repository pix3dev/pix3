# Multiplayer Arena

A tag arena for up to 8 players, and the reference test bed for pix3 multiplayer (plan step 1.6,
`multiplayer-arena-2d`). It has no binary assets on purpose — every visual is a `ColorRect2D` or a
`Label2D`, so the whole project is readable in a diff and nothing has to be regenerated.

## Play it

1. Open this folder as a project in the pix3 editor (**File → Open Project**), then open
   `src/assets/scenes/arena.pix3scene`.
2. **Play** (no room) — single-player sandbox: your avatar spawns, WASD moves it. Use this to check
   the scene before involving a server at all.
3. **Play Online** (project menu, or the Game tab) — the editor creates a room through pix3-cloud,
   joins it, and shows a session card with a QR code and a join link.
4. Open the join link in another browser (or scan the QR with a phone on the same network). The
   second client streams this project's assets from your editor over the preview relay and joins the
   same room. Add `&name=Phone` to the link to label a client in the roster.

Everything is client-authoritative (Level 1): the **room host** — the editor that created the room —
runs the tag rules and broadcasts the result. Nothing here is cheat-proof, and that is by design:
authority moves server-side in Phase 3/4 of the multiplayer plan.

## Controls

| Input | Action |
| --- | --- |
| `WASD` / arrows | Move |
| On-screen stick | Move (phones) |
| `1` `2` `3` / the buttons | Quick chat ("Hi!", "Catch me!", "Nice!") |

Quick chat rather than free text: it exercises the same networked-signal path, works on a phone
without a keyboard overlay, and stays inside the fabric's 2 signals/second peer quota.

## How it is wired

| File | Role |
| --- | --- |
| `src/assets/prefabs/player.pix3scene` | The avatar. `core:NetworkedNode` + `core:ReplicatedTransform` + `user:PlayerAvatar`. This is the project's only spawnable prefab, so its wire `Kind` is `0`. |
| `src/assets/scenes/arena.pix3scene` | Field, 8 spawn markers, the `Players` container, and the HUD. |
| `scripts/ArenaController.ts` | Spawns this client's avatar; on the host, runs tag/score/round rules and broadcasts `arena:state`. |
| `scripts/PlayerAvatar.ts` | Owner-only movement, name label, colour, "it" halo, emote bubble. |
| `scripts/ArenaHud.ts` | Read-only HUD: room, ping, players, timer, scoreboard, feed. |
| `scripts/arena-shared.ts` | Match state and the live avatar registry the three scripts share. |

Three details are worth copying into your own game:

- **Only the owner writes `node.position`.** A remote avatar's position comes from
  `core:ReplicatedTransform`'s interpolation; a script that also writes it fights the network and
  jitters. `PlayerAvatar.onUpdate` returns early when the avatar is not ours.
- **Spawn position is set between `instantiate()` and the component's `onStart`.** Components start
  a tick after instantiation, and `core:NetworkedNode` mints the entity at wherever the node stands
  at that moment — so placing the node first is what puts the entity on the right spawn point.
- **Peer signals are quota'd at 2/s.** State goes out at 1 Hz plus one immediate extra on a real
  change, and every emit passes through a local budget check.

## Requirements

"Play Online" needs a pix3-cloud with a Room Fabric configured (`ROOMS_ADMIN_URL`,
`ROOMS_SERVICE_TOKEN`, and an HS256 secret shared with the fabric). Without one the editor reports
`rooms_not_configured` and the sample still runs single-player.
