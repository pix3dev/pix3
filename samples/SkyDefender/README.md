# SkyDefender

Remaster of **Sky Defender: Joe's Story** — a 2010–2011 Flash side-view tower-defense /
arcade shooter — rebuilt on the Pix3 engine as a showcase sample project.

The player manually aims the castle's main gun at waves of air and ground enemies,
earns gold, and buys castle floors, auto-turrets and new weapons between waves.
Original art (650+ sprites), sounds and design docs are preserved from the author's
archive; the development specification lives in
[`design/remaster-spec.md`](design/remaster-spec.md).

## Project structure

- `design/` — put your game design document and visual references here
- `scripts/` — game scripts (`export class X extends Script`, used as `user:X`)
- `src/assets/scenes/` — scene files (`.pix3scene`, YAML)
- `src/assets/textures/` — sprites and textures
- `AGENTS.md` — rules and pointers for AI agents working on this project

## Getting started

1. Open the project folder in the Pix3 editor.
2. `src/assets/scenes/main.pix3scene` is the startup scene — press Play to run it.
3. Drop your GDD and reference art into `design/`, then ask an AI agent to build the game.
