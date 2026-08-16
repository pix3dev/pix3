# Contributing to Pix3

Thanks for your interest in Pix3. Please read the licensing section before
opening a pull request — it affects what you are agreeing to.

## Licensing model

Pix3 is **open core**. Different parts of this repository are under different
licences, and a contribution is governed by whichever applies to the files it
touches:

| Path | Licence |
|---|---|
| `src/` — the editor | Apache-2.0 |
| `packages/pix3-runtime/` — `@pix3/runtime` | Apache-2.0 |
| `packages/pix3-collab-server/` — `@pix3/collab-server` | Proprietary (see its LICENSE) |
| `tools/pix3-agent-bridge/` | MIT |

## Contributor Licence Agreement

Before a pull request can be merged, you need to sign the Contributor Licence
Agreement (CLA). The CLA bot will comment on your PR with a link the first time
you contribute.

**Why a CLA rather than a DCO.** A DCO certifies you have the right to submit
your patch, which is enough for a project that is permissively licensed
end-to-end. Pix3 is not: parts of it are licensed commercially. To be able to
include a contribution in a commercially licensed component — or to relicense
a component later — the project needs an explicit grant from you covering that.
A DCO does not provide one. This is the same reason projects like Qt and
Elastic use CLAs.

What the CLA does and does not do:

- You **keep the copyright** in your contribution. It is a licence grant, not
  an assignment.
- You grant the project a perpetual, worldwide, irrevocable licence to use,
  modify, sublicense and distribute your contribution, including under
  commercial terms.
- You confirm you have the right to grant that — in particular, that your
  employer does not own the work, or that you have their permission.

That last point is worth taking seriously rather than clicking through. In many
jurisdictions code written by an employee can belong to the employer by default,
regardless of whether it was written on company time or equipment.

## Before you start

For anything beyond a small fix, please open an issue first. Engine-level
changes especially: adding a node type or a runtime system touches the scene
file format, the property schema, serialization and the inspector at once, and
it is better to agree the shape before the code exists. See the engine-vs-game
decision guide in `CLAUDE.md` and `docs/nodes-and-systems.md`.

## Development

Node 24 is required.

```bash
npm install
npm run dev          # editor on :8123
npm run test         # vitest
npm run lint         # eslint over src + packages
npm run type-check   # tsc --noEmit
```

`AGENTS.md` is the binding code-rule set — read it before writing code.

## Dependencies

Adding a dependency is a licensing decision as much as a technical one.

- **Permissive only** (MIT, BSD, ISC, Apache-2.0, Zlib) for anything that ends
  up in the editor or the runtime.
- **No copyleft** — GPL, LGPL and especially AGPL are not acceptable in shipped
  code. AGPL obliges disclosure of the source of the combined work, which is
  incompatible with the commercial component. (`@imgly/background-removal` was
  removed for exactly this reason.)
- **Check the weights separately from the code** when adding an ML model. A
  model card's `license` field is frequently copied from the training code's
  licence and says nothing about the checkpoints. Verify the upstream terms for
  the weights themselves, and record what you found.
- Update `THIRD-PARTY-NOTICES.md` — run `npm run licenses:report` to regenerate
  the inventory.
