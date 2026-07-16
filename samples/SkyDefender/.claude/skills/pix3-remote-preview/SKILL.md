---
name: pix3-remote-preview
description: Run and debug this Pix3 game — restart it, reload your file edits, read runtime logs and performance metrics, take screenshots — over the remote preview HTTP API. Use whenever you need to verify the game actually runs, reproduce a bug, see your changes, or check performance.
---

# Running and debugging the game via Remote Preview

## Setup: find the session

When a preview session is active, the Pix3 editor writes `.pix3/preview-session.json`
into this project:

```json
{
  "sessionId": "…",
  "apiBaseUrl": "http://localhost:8123/api/preview",
  "agentToken": "…",
  "joinUrl": "http://localhost:8123/player.html?session=…&token=…",
  "expiresAt": 1750000000000
}
```

Read it and export for convenience:

```bash
SESSION=$(jq -r .sessionId .pix3/preview-session.json)
BASE=$(jq -r .apiBaseUrl .pix3/preview-session.json)
AUTH="Authorization: Bearer $(jq -r .agentToken .pix3/preview-session.json)"
```

Verify the session is alive (the editor must stay open — it serves the project
files to players):

```bash
curl -s -H "$AUTH" "$BASE/sessions/$SESSION"
# → { "hostOnline": true, "playerCount": 1, "playModeStatus": "running", ... }
```

**If the file is missing, the request returns 401, or `hostOnline` is false:**
ask the user to open the project in the Pix3 editor and run
**Project → Start Remote Preview**, then re-read the file. There is no fallback
without an open editor.

**If `playerCount` is 0:** there is nobody running the game. Ask the user to
open the `joinUrl` (or scan the QR shown in the editor's Game tab) on a phone
or in another browser tab. Logs/metrics/screenshots all come from a connected
player. The session status also lists connected devices under `players[]`
(clientId + reported device info: model/GPU/screen).

## The iteration loop

After editing scenes/scripts on disk:

```bash
# 1. Push your on-disk changes to all players (recompiles scripts, reloads scenes)
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"action":"reload-from-disk"}' "$BASE/sessions/$SESSION/commands"

# 2. Watch what happened (cursor-based; keep the lastSeq from the previous call)
curl -s -H "$AUTH" "$BASE/sessions/$SESSION/logs?since=0"
# → { "entries": [{ "seq": 12, "level": "error", "message": "…" }], "lastSeq": 12 }

# 3. Check performance (1-second aggregates from the player)
curl -s -H "$AUTH" "$BASE/sessions/$SESSION/metrics"
# → { "sample": { "fps": 59.8, "frameMs": 4.1, "drawCalls": 63,
#      "maxFrameMs": 21.3, "longFrameCount": 0, "jsHeapUsedMb": 38.2, ... } }
# maxFrameMs / longFrameCount expose hitches that 1s averages hide — check them
# when diagnosing stutter on a real device.

# 4. See the game
curl -s -H "$AUTH" "$BASE/sessions/$SESSION/screenshot?fresh=true" -o shot.jpg
```

Then read `shot.jpg`, fix issues, repeat. Saving a scene in the editor also
pushes updates automatically — `reload-from-disk` is for *your* edits made
directly on disk.

## Other commands

All commands: `POST $BASE/sessions/$SESSION/commands` with
`{"action": "...", "params": {...}}`. The response carries `ok` plus
`result`/`error` from the peer that executed it.

| action | params | effect |
| --- | --- | --- |
| `restart` | — | restart the scene on all players (does not re-read files) |
| `reload-from-disk` | — | recompile scripts + reload scenes from disk, then restart players |
| `screenshot` | — | capture a fresh JPEG into the session buffer (then GET `/screenshot`) |
| `set-property` | `{nodeId, propertyPath, value}` | live-edit a property on the running scene |
| `snapshot` | — | game state overview via the game's `__PIX3_GAME_DEBUG__` provider |
| `inspect` | `{query, args?}` | named read query on the game debug provider |
| `game-action` | `{name, args?}` | named debug action on the game debug provider |

`snapshot`/`inspect`/`game-action` require the game to register a debug
provider (`registerGameDebug` from `@pix3/runtime`) — add one to your game's
main script when you need deep diagnostics; `set-property` and everything else
work without it.

## Rules

- Always check logs after `reload-from-disk` — scene parse and script compile
  errors show up there and as `playModeStatus: "error"`.
- Screenshots are JPEG frames of the actual player canvas; use them to verify
  layout/visuals instead of guessing.
- Commands return 409 when no player (or no host) is connected and 504 when the
  peer does not answer in time — surface that to the user instead of retrying
  blindly.
