# {{PROJECT_NAME}}

A Pix3 project created from the **Playable 3D** template — a portrait playable-ad blank.

## What's included

- **Tap-to-start intro** (`intro-overlay`) — the first tap unlocks browser audio and starts the game (`scripts/GameFlow.ts`).
- **Gameplay placeholder** — replace the demo box and ground in `main.pix3scene` with your game.
- **End screen with CTA** (`end-screen`) — the PLAY NOW button reports game end (`playable.gameEnd()`) and logs the click. It opens nothing: the ad network decides the store target at delivery time (`mraid.open` / `dapi.openStoreUrl`), so wire its SDK in `CtaButton.ctaClick()` when you package the ad.
- `GameFlow` shows the end screen automatically after `autoWinAfterSec` seconds — replace that with your real win/lose condition. `skipIntro: true` starts already playing while you iterate; turn it off before shipping, since that first tap is what unlocks audio.
- **Bookkeeping, already built** (`scripts/GameRules.ts` + `scripts/ScoreHud.ts`) — score, lives, an optional clock, the win/lose decision and the HUD that shows them. Your mechanic calls `addScore(1)` / `loseLife()` / `finish(true)`, or emits `score-added` / `life-lost` on `hud-root`; don't write a second score counter or result screen.
- **Readable state** — `GameFlow` publishes the one `registerGameDebug` snapshot (phase, timer, overlay visibility, session end, plus the rules' score/lives/time), so tooling reads the run's state instead of judging it from a screenshot. Add your own fields there — a second provider would silently replace this one.
- **Intent-first handlers** — every reaction to the player is a named method (`GameFlow.start/finish/restart`, `CtaButton.ctaClick`) that the event handler merely calls; keep that shape and the game stays drivable by intent.
- **Canonical roots** — `game-root` holds the 3D scene, `hud-root` the 2D overlay layer (intro gate, HUD, end screen); routines and assertions address them by those ids.

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
