# Pix3

Pix3 is an HTML5 2D/3D game engine with a visual editor, made for working with a coding agent
(Claude Code, Codex). You describe the game; the agent builds it in an ordinary Vite + TypeScript
project, and you can open the Pix3 editor at any time to see the scenes, move things and press
Play. The result is one HTML file you can put on any web portal.

> **Status: alpha.** Pix3 2.0 is published as `2.0.0-alpha.N` (`npm create pix3@latest`; `@pix3/runtime` and `@pix3/cli` under `next`, their `latest` is the archived 1.x). Things change between versions.

## Start a game

You need [Node.js 24](https://nodejs.org/), Google Chrome and a coding agent.

**Claude Code** — add the Pix3 plugin once:

```text
/plugin marketplace add pix3dev/pix3
/plugin install pix3@pix3
```

then say *"create a Pix3 project for a game where…"*. The agent creates the project and tells you
how to continue in it.

**Any agent** — ask it: *"Read https://github.com/pix3dev/pix3/blob/main/AGENTS.md and create a
Pix3 project."*

**By hand:**

```bash
npm create pix3@latest my-game -- --template 2d
cd my-game
npm install
npx pix3 agent-setup claude    # or: codex
```

Then open your agent in the `my-game` folder and describe the game: what the player does, what
they see, how they win or lose, which devices it is for. Attach pictures if you have them.

`npm run dev` shows the game at `http://localhost:5173/` and the editor at
`http://localhost:5173/__pix3/`; `npm run build` makes `dist/index.html`.

## Where things are

| | |
| --- | --- |
| [pix3dev/pix3-core](https://github.com/pix3dev/pix3-core) | The engine, editor, CLI and `create-pix3` — for changing Pix3 itself |
| [pix3dev/pix3-editor-legacy](https://github.com/pix3dev/pix3-editor-legacy) | The archived 1.x browser editor (editor.pix3.dev), npm 1.6.x |
| [pix3.dev](https://pix3.dev) | Project site |

Questions, bugs and ideas: [issues](https://github.com/pix3dev/pix3/issues) here.

## License

Apache-2.0. Copyright 2026 Igor Gritsenko.
