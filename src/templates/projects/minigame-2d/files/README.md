# {{PROJECT_NAME}}

A Pix3 project created from the **Minigame 2D** template.

## Scenes and the flow

The menu and the game are **separate scenes**, so you can play the game on its own
while iterating and still ship the full menu → game flow in a build:

- **Game scene** (`scenes/main.pix3scene`) — the gameplay. This is the
  editor's startup scene: it opens first and is what you (and agents) play directly,
  with no menu in the way. Build your minigame here. Driven by `scripts/GameFlow.ts`
  (its MENU button transitions back to the menu; extend it with your win/lose flow).
- **Menu scene** (`scenes/menu.pix3scene`) — title, PLAY and SETTINGS
  buttons. This is the project's **entry scene** (Project Settings → Default Export
  Scene Path): a build and *Start Game* boot here so you can debug the whole flow.
  Driven by `scripts/MenuFlow.ts`: PLAY transitions to the game scene, SETTINGS
  opens the settings window.
- **Settings window** (`scenes/ui/settings-window.pix3scene`) — the modal,
  in its own file so the menu opens clean. The menu carries it as a one-line
  `instance: res://scenes/ui/settings-window.pix3scene` marked `visible: false`
  (an editor-only hide; `MenuFlow` shows it at run time). Music/SFX checkboxes
  mute the engine audio buses, wired by `scripts/SettingsWindow.ts`. Reuse it
  from any scene the same way.

Scenes switch at runtime with a fade transition:
`this.scene.changeScene('res://scenes/main.pix3scene', { transition: 'fade' })`.

## Project structure

- `design/` — game design document and reference images
- `design/tests/` — agent-testing material: `routines/*.json` (named, replayable
  step + assertion scripts) and `reachability.json` (the journal of on-screen
  controls physically proven reachable). Routines are executed by the gameplay
  test harness, which is still in development — the format and location are
  fixed now so a routine written today keeps working.
- `scenes/` — scene files; `main.pix3scene` (game) is the startup scene,
  `menu.pix3scene` is the build entry point
- `scenes/ui/` — full-screen / modal overlays (`settings-window.pix3scene`),
  instanced into host scenes with `visible: false`
- `sprites/` — images and textures
- `scripts/` — game scripts (`export class X extends Script`, used as `user:X`)
- `audio/` — music and sound effects
- `AGENTS.md` — rules and pointers for AI agents working on this project
