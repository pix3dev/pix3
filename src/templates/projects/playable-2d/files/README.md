# {{PROJECT_NAME}}

A Pix3 project created from the **Playable 2D** template — a portrait playable-ad blank.

## What's included

- **Tap-to-start intro** (`intro-overlay`) — the first tap unlocks browser audio and starts the game (`scripts/GameFlow.ts`).
- **Gameplay placeholder** — replace the animated logo sprite in `main.pix3scene` with your game.
- **End screen with CTA** (`end-screen`) — the PLAY NOW button reports game end (`playable.gameEnd()`) and logs the click. It opens nothing: the ad network decides the store target at delivery time (`mraid.open` / `dapi.openStoreUrl`), so wire its SDK in `CtaButton.ctaClick()` when you package the ad.
- `GameFlow` shows the end screen automatically after `autoWinAfterSec` seconds — replace that with your real win/lose condition.
- **Readable state** — `GameFlow` publishes a `registerGameDebug` snapshot (phase, timer, overlay visibility, session end), so tooling reads the run's state instead of judging it from a screenshot. Add your own fields as you add state.
- **Intent-first handlers** — every reaction to the player is a named method (`GameFlow.start/finish/restart`, `CtaButton.ctaClick`) that the event handler merely calls; keep that shape and the game stays drivable by intent.

## Project structure

- `design/` — game design document and reference images
- `design/tests/` — agent-testing material: `routines/*.json` (named step +
  assertion scripts, written on the highest channel the game offers) and
  `reachability.json` (controls proven reachable on a live run). The harness
  that runs them is still in development; format and location are fixed now.
- `scenes/` — scene files; `main.pix3scene` is the startup scene
- `sprites/` — images and textures
- `scripts/` — game scripts (`export class X extends Script`, used as `user:X`)
- `audio/` — music and sound effects
- `AGENTS.md` — rules and pointers for AI agents working on this project
