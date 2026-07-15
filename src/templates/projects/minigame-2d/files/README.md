# {{PROJECT_NAME}}

A Pix3 project created from the **Minigame 2D** template.

## Scenes and the flow

The menu and the game are **separate scenes**, so you can play the game on its own
while iterating and still ship the full menu → game flow in a build:

- **Game scene** (`src/assets/scenes/main.pix3scene`) — the gameplay. This is the
  editor's startup scene: it opens first and is what you (and agents) play directly,
  with no menu in the way. Build your minigame here. Driven by `scripts/GameFlow.ts`
  (its MENU button transitions back to the menu; extend it with your win/lose flow).
- **Menu scene** (`src/assets/scenes/menu.pix3scene`) — title, PLAY and SETTINGS
  buttons. This is the project's **entry scene** (Project Settings → Default Export
  Scene Path): a build and *Start Game* boot here so you can debug the whole flow.
  Driven by `scripts/MenuFlow.ts`: PLAY transitions to the game scene, SETTINGS
  opens the settings window.
- **Settings window prefab** (`src/assets/scenes/settings-window.pix3scene`) —
  instanced into the menu; Music/SFX checkboxes mute the engine audio buses, wired
  by `scripts/SettingsWindow.ts`. Reuse it from any scene via
  `instance: res://src/assets/scenes/settings-window.pix3scene`.

Scenes switch at runtime with a fade transition:
`this.scene.changeScene('res://src/assets/scenes/main.pix3scene', { transition: 'fade' })`.

## Project structure

- `design/` — put your game design document and visual references here
- `scripts/` — game scripts (`export class X extends Script`, used as `user:X`)
- `src/assets/scenes/` — scene files; `main.pix3scene` (game) is the startup scene,
  `menu.pix3scene` is the build entry point
- `AGENTS.md` — rules and pointers for AI agents working on this project
