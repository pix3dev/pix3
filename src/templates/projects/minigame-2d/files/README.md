# {{PROJECT_NAME}}

A Pix3 project created from the **Minigame 2D** template.

## What's included

- **Menu screen** (`menu-screen`) — title, PLAY and SETTINGS buttons, driven by `scripts/MenuFlow.ts`.
- **Game screen** (`game-screen`) — a placeholder with a BACK button; put your gameplay here.
- **Settings window prefab** (`src/assets/scenes/settings-window.pix3scene`) — instanced into the main scene; Music/SFX checkboxes mute the engine audio buses, wired by `scripts/SettingsWindow.ts`. Reuse it from any scene via `instance: res://src/assets/scenes/settings-window.pix3scene`.

## Project structure

- `design/` — put your game design document and visual references here
- `scripts/` — game scripts (`export class X extends Script`, used as `user:X`)
- `src/assets/scenes/` — scene files; `main.pix3scene` is the startup scene
- `AGENTS.md` — rules and pointers for AI agents working on this project
