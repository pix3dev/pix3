# {{PROJECT_NAME}}

A Pix3 project created from the **Playable 2D** template — a portrait playable-ad blank.

## What's included

- **Tap-to-start intro** (`intro-overlay`) — the first tap unlocks browser audio and starts the game (`scripts/GameFlow.ts`).
- **Gameplay placeholder** — replace the animated logo sprite in `main.pix3scene` with your game.
- **End screen with CTA** (`end-screen`) — the PLAY NOW button calls the engine Playable SDK (`playable.openStore`); set your store URL in the `user:CtaButton` component config on `cta-button`.
- `GameFlow` shows the end screen automatically after `autoWinAfterSec` seconds — replace that with your real win/lose condition.

## Project structure

- `design/` — put your game design document and visual references here
- `scripts/` — game scripts (`export class X extends Script`, used as `user:X`)
- `src/assets/scenes/` — scene files; `main.pix3scene` is the startup scene
- `AGENTS.md` — rules and pointers for AI agents working on this project
