# Pix3 — for coding agents

You are here because someone wants a game made with Pix3. This repository is the entry page, not
the engine and not a game template: **do not clone it or build inside it.**

To create a project (Node 24.15+ required):

```bash
npm create --yes pix3@latest <folder> -- --template <2d|3d> [--portrait] --yes
cd <folder>
npm install
npx pix3 agent-setup <claude|codex>
```

`2d` unless the game needs 3D; `--portrait` for one-handed phone games. If the user described the
game, save their words to `<folder>/design/brief.md`.

Then stop and hand over: the project's own `AGENTS.md`, skills and editor connection (`.mcp.json`
or `.codex/config.toml`) load only in a new session started **in `<folder>`**. Everything about
building the game is there, versioned with the engine the project uses.

Don't use `editor.pix3.dev` or `pix3dev/pix3-editor-legacy`: that is the archived 1.x editor, a
different project format. The engine source is
[pix3dev/pix3-core](https://github.com/pix3dev/pix3-core) — for changing Pix3 itself, not for
making a game.
