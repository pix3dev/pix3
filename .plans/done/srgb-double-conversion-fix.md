# Fix: engine-wide sRGB double conversion of authored colours

Status: in progress · Owner: runtime · Breaking visual change (accepted by the user)

## The bug, in one paragraph

three.js r152+ (`three@0.183.2` here) has `ColorManagement.enabled = true` by default and this repo
never disables it. Every `new Color('#hex')` / `color.set('#hex')` / `setHex()` therefore ALREADY
applies the sRGB → Linear-sRGB transfer function, and every `getHexString()` / `getHex()` ALREADY
converts working space → sRGB (`setHex(hex, colorSpace = SRGBColorSpace)`,
`getHexString(colorSpace = SRGBColorSpace)` in `three/src/math/Color.js`). A cluster of runtime sites
adds a manual `.convertSRGBToLinear()` on write and `.convertLinearToSRGB()` on read on top of that,
double-applying the transfer function. Measured: authored `#a8d8f0` reaches the material as
(0.127, 0.429, 0.732) instead of the correct (0.392, 0.687, 0.871) — every authored 3D colour renders
darker and more saturated than authored ("pastel looks acid").

Light nodes are worse than the mesh: their write side double-converts but their read side
(`getHexString()`) un-converts only once, so every save re-writes a once-darkened hex into the
`.pix3scene`. Light colours drift darker by one transfer step per save/load cycle, and that drift is
already committed into the sample scenes.

**The rule after this fix:** authored colours are sRGB hex strings; `Color.set()` / `new Color()` /
`getHexString()` do all conversion themselves. `convertSRGBToLinear` / `convertLinearToSRGB` are
banned in runtime source, enforced by a guard spec.

## Decisions

1. **No wrapper helper.** The fix is deletion, not abstraction. `new Color(hex)`, `color.set(hex)`,
   `'#' + color.getHexString()` are already the one-liners a helper would wrap, and most of the
   runtime (all 2D nodes, `Particles3D`, `InstancedMesh3D`, juice, `batch-2d`) already uses them
   bare. A wrapper would be a second convention to police and would not stop anyone calling
   `.convertSRGBToLinear()` on its return value. Enforcement comes from a source-scanning guard spec
   plus a CLAUDE.md entry.

2. **Three-layer regression tests** (`packages/pix3-runtime/src/core/color-convention.spec.ts`):
   (a) pin three.js behaviour — `new Color('#a8d8f0')` components ≈ (0.392, 0.687, 0.871), so the
   spec fails if `ColorManagement` is ever disabled; (b) authored-hex round-trip identity for
   GeometryMesh and all five light nodes **plus** a component assertion — the hex round-trip alone
   passes under symmetric double conversion, which is exactly how this bug hid; (c) a source guard
   that fails on any new `convertSRGBToLinear|convertLinearToSRGB` in non-spec runtime sources
   (precedent: `src/services/export/strippable-runtime-modules.spec.ts` walks runtime sources the
   same way).

3. **Sample scenes: migrate by *un*-darkening light colours once — the opposite direction from the
   obvious fix.** The tempting move is to re-darken the stored hexes so the demos render exactly as
   they do today. That is wrong here, because the stored values are not eyeball-tuned intent; they
   are already one cycle of save-drift away from intent. Evidence from
   `samples/HelloWorld/scenes/demo-01-primitives-materials.pix3scene` — applying `linearToSRGB` once
   to each stored light colour recovers a sane authored value in every single case:

   | stored (drifted) | one step back | reads as |
   |---|---|---|
   | `#040406` ambient @ intensity 0.4 | `#222226` | sane neutral ambient (near-black at 0.4 is nonsense) |
   | `#80afff` skyColor | `#bcd8ff` | classic sky blue |
   | `#0b0604` groundColor | `#3b2a22` | warm ground bounce |
   | `#ff2500` point accent | `#ff6a00` | orange accent |
   | `#ffe7be` key light | `#fff4e0` | classic warm key |

   Five out of five landing on conventional values at exactly one step back pins the drift count at
   n = 1. Two steps back gives washed-out near-whites. So the migration is
   `newHex = hex(linearToSRGB(oldHex))` over **light colours only**, skipping the fixed points
   `#ffffff` / `#000000`. This restores the look the demos were *authored* for, which is brighter
   than today — consistent with the accepted premise that the fix brightens every existing 3D scene.

4. **No migration for GeometryMesh material colours.** Their write/read pair was symmetric
   (`convertSRGBToLinear` on set, `convertLinearToSRGB().getHexString()` on get), so the stored hex is
   bit-identical to what the author typed; only the rendered result was wrong. After the fix the same
   stored hex renders as authored. Same reasoning for shader-effect colour params: the read side
   serializes from the `effect.params` strings, never from the uniform, so nothing drifted.

5. **No compatibility shim, no opt-in flag.** The user has accepted that the fix brightens every
   existing 3D scene in every project. Only repo-owned sample data gets re-authored; consumer
   projects (DeepCore) are covered by the release note.

6. **Docs:** a CLAUDE.md "non-obvious" entry shaped like the existing "2D textures must disable
   mipmaps" one; a note on the `color` property type in `docs/property-schema-reference.md`; the
   wrong-convention comment at `shader-effect-types.ts` fixed in place; and
   `.plans/p1-m-feature-designs.md` amended where it documents the buggy convention for a future
   feature (otherwise the next implementer re-introduces the bug). `.plans/done/*` stays as history.

7. **Release mechanics:** versions in `packages/*` are lockstep with the root `package.json`
   (bump root, `npm run version:sync`, never hand-edit a workspace version). Record the change in
   `docs/pix3-specification.md` → Change Log, which is the release note of record (no CHANGELOG file
   exists and docs policy forbids new feature `.md` files). Publishing to DeepCore
   (`npm run yalc:publish` + `yalc update`) is a separate, explicitly-confirmed step.

## Work steps

### 1. Runtime fix — delete every manual conversion

`packages/pix3-runtime/src/nodes/3D/GeometryMesh.ts`

- ctor: `new Color(mat.color ?? '#4e8df5').convertSRGBToLinear()` → drop the conversion
- `serializeConfig()`: `colorMat.color.clone().convertLinearToSRGB().getHexString()` →
  `colorMat.color.getHexString()` (the `.clone()` was only there to protect against the mutating
  convert; `getHexString` does not mutate)
- property getter: same simplification, keep the `'#4e8df5'` fallback
- property setter: `mat.color.set(String(v)).convertSRGBToLinear()` → `mat.color.set(String(v))`

Light nodes — drop `.convertSRGBToLinear()` in constructor and setters; the getters are already
correct and need no change: `AmbientLightNode`, `DirectionalLightNode`, `PointLightNode`,
`SpotLightNode`, `HemisphereLightNode` (both `skyColor` and `groundColor`).

Shader effects — `ShaderEffectStack` uniform setter, the four `new Color(...)` uniform defaults in
`register-builtin-effects.ts` (three are `#ffffff`, a fixed point, but `#ffae42` is really wrong),
and the convention comment in `shader-effect-types.ts`.

`core/SceneSaver.ts` needs **zero** edits: its plain `getHexString()` becomes correct the moment the
write side stops double-converting.

### 2. Delete `packages/pix3-runtime/src/nodes/3D/light-property-helpers.ts`

Verified orphan: all five exported factories have zero call sites, the file is imported nowhere and
re-exported from no index, and every light node hand-rolls its own schema. Its only distinctive
content is a duck-typed encoding of the buggy convention (`convertSRGBToLinear: () => unknown` in the
type constraint). Fixing dead code that exists only to teach the wrong convention has negative value.

### 3. Fix the one spec that encodes the bug

`packages/pix3-runtime/src/core/GeometryMeshMaterialType.spec.ts` — the assertion that round-trips
through `convertLinearToSRGB()`. It is the only spec repo-wide using either convert call; every other
colour-asserting spec compares authored space to authored space and passes unchanged.

### 4. Sample scene migration

Apply `hex(linearToSRGB(oldHex))` once to light `color` / `skyColor` / `groundColor` in
`samples/**/*.pix3scene`, skipping `#ffffff` / `#000000`. Do not touch 2D colours, `backgroundColor`s,
GeometryMesh material colours, or script literals.

### 5. New regression specs

As described in decision 2.

### 6. Docs

As described in decision 6.

## Verification (state and data, not screenshots)

1. `npm run type-check` — also proves nothing imported the deleted helper file.
2. `npm run lint`.
3. `npx vitest run --pool=threads` (win32-arm64 needs `--pool=threads`), focused specs first.
4. Live editor check via dev server + chrome-devtools MCP: set a GeometryMesh colour to `#a8d8f0`,
   read `material.color` components off the live node and assert ≈ (0.392, 0.687, 0.871); assert the
   inspector getter echoes `#a8d8f0`; save and assert the stored hex is byte-identical to the authored
   hex (this is the assertion that kills the drift bug).
5. Drift regression: load a demo, save without edits, `git diff` the scene → no colour churn.
