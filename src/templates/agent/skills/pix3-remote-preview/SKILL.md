---
name: pix3-remote-preview
description: Run and debug this Pix3 game — start/restart the game, read runtime logs and performance metrics, take screenshots — while iterating on scenes and scripts. Use whenever you need to verify the game actually runs, reproduce a bug, or check performance.
---

# Running and debugging the game

## Current status (v1)

The remote preview API is not available yet. To verify your changes:

1. **Ask the user** to open this project in the Pix3 editor
   (https://editor.pix3.dev or their local instance) and press **Play**.
2. Tell them exactly what to check (screens, interactions, expected behavior)
   and ask for a screenshot or a description of what happened, including any
   errors from the browser console.
3. If you changed files while the editor was open, ask the user to reopen the
   scene (or the project) so the editor picks up the on-disk changes.

## Coming soon

When a preview session is active, the editor writes `.pix3/preview-session.json`
into this project:

```json
{ "sessionId": "…", "apiBaseUrl": "https://cloud.pix3.dev/api/preview", "agentToken": "…" }
```

With that file present you will be able to drive the game over HTTP (restart,
reload-from-disk, logs, metrics, screenshot). If the file is missing or expired,
ask the user to press **Start Remote Preview** in the editor.
