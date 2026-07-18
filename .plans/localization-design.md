# Pix3 Localization (i18n/l10n) — Implementation Design

Status: DESIGN (not implemented). Author: architecture pass, 2026-07-18.
Test target: `samples/SkyDefender` (Label2D strings + sprite-baked button text).
Model: Godot's TranslationServer/`tr()`/auto-translate adapted to Pix3's
operations-first editor and the editor-agnostic `@pix3/runtime` package.
Unity String Tables are the secondary reference (per-locale tables + fallback).

---

## 0. Summary of the recommended approach

- **Per-locale JSON tables** in a project `locales/` directory
  (`locales/en.json`, `locales/ru.json`), flat dot-namespaced keys, with a
  `strings` section and a `sprites` section (key → `res://` path). Locale
  list/default/fallback live in `pix3project.yaml` (`localization:` block).
- **`LocalizationService` in the runtime package**
  (`packages/pix3-runtime/src/core/localization/`): `locale`, `setLocale()`,
  `tr(key, params?)`, `trSprite(key)`, fallback chain, change listeners. Loads
  tables through `ResourceManager.readText()` so embedded resources in exported
  builds work for free.
- **Module-global "active localization" pointer** (same proven pattern as
  `project-texture-filtering.ts`) so nodes resolve text without service
  plumbing; the editor sets a preview instance, `SceneRunner` swaps in the
  play-mode instance on start and restores on stop.
- **Explicit `labelKey` property on `UIControl2D`** (not Godot's
  auto-translate-the-literal): when set, `updateLabel()` renders
  `tr(labelKey)`; the literal `label` stays as designer fallback. 100%
  backward compatible. Sprites get a `textureKey` (Sprite2D) /
  `stateTextureKeys` (Button2D, later phase) resolved through the locale
  table's `sprites` section.
- **Editor**: `LocalizationEditorService` + a `pix3-localization-panel`
  (Golden Layout) for table editing, missing-translation view, and a preview
  locale switch; an inspector `localization-key` editor widget with
  autocomplete + "extract from literal". All mutations via Command+Operation
  under `src/features/localization/`.
- **Scripts** call `this.scene.localization.tr('mission.name.2')` (surfaced on
  `SceneService` like `audio`/`juice`); `Label2D.setTextKey(key, params?)`
  keeps dynamic labels re-resolvable on locale change.
- **Export**: `ProjectBuildService.collectAssetPaths` additionally enumerates
  `locales/*.json` and the sprite paths referenced inside them; the playable
  HTML path then embeds them automatically via the existing base64 embedded
  assets module.

---

## 1. Locale data model & storage format

### 1.1 Files on disk

```
<project root>/
  locales/
    en.json          ← default locale (also serves as the "POT template")
    ru.json
    de.json
  pix3project.yaml   ← gains a `localization:` block
```

Loaded via `res://locales/<locale>.json`, i.e. resolvable by
`ResourceManager.normalize` / `readText` (`packages/pix3-runtime/src/core/ResourceManager.ts:41,65`)
exactly like any other project asset — which also makes exported-build
embedding free (`readText` prefers the embedded map, `ResourceManager.ts:66-70`).

### 1.2 File format (per-locale JSON)

```jsonc
// locales/en.json
{
  "$meta": { "locale": "en", "name": "English", "direction": "ltr" },
  "strings": {
    "menu.play": "Play",
    "menu.shop": "Shop",
    "mission.name.1": "Prologue",
    "mission.name.2": "On Guard",
    "briefing.m2.1": "Well, Joe... We have a little problem. …",
    "hud.gold": "Gold: {amount}"
  },
  "sprites": {
    "menu.btn.play": "res://sprites/ui/en/btn_play.png",
    "menu.btn.shop": "res://sprites/ui/en/btn_shop.png"
  }
}
```

Rules:
- Keys are flat strings, dot-namespaced by convention
  (`<area>.<element>[.<n>]`). No enforced hierarchy — the panel groups by
  first segment for display. Sorted on save → clean git diffs.
- `{param}` placeholders for interpolation (simple token replace, no ICU
  dependency).
- A locale file may omit keys; resolution falls through the fallback chain
  (§2.3). The **default locale file is the template** — the extraction tool
  (§4.5) keeps it complete; other locales are diffed against it for the
  "missing translations" view. No separate POT file needed.
- `sprites` maps a sprite key to a `res://` texture path per locale. A locale
  that omits a sprite key falls back the same way; final fallback is the
  node's own authored `texturePath`/texture ref.

**Why JSON, not Godot CSV/PO or YAML:**
- CSV (Godot's spreadsheet workflow): quoting/comma escaping for prose with
  `\n` and quotes (SkyDefender briefings are full of both), terrible merge
  diffs, no natural place for sprite tables or metadata. Godot itself
  compiles CSV into binary `.translation` resources — we'd be keeping the
  worst part (the source format) without the good part.
- PO/gettext: mature external tooling, but msgid-as-English-string couples
  copy to code, needs a parser dependency in the runtime, and plural syntax
  is overkill for the MVP. If a studio needs PO round-trip later, it's an
  editor-side import/export converter over the same JSON model (Phase 4
  candidate).
- YAML: consistent with `.pix3scene`/`pix3project.yaml`, but the **runtime**
  would need `js-yaml` in the engine bundle just to read locale files; JSON
  parses natively and strictly. The editor still writes it pretty-printed +
  key-sorted, so hand-editing stays pleasant.

### 1.3 Project configuration (`pix3project.yaml`)

Extend `ProjectManifest` (`src/core/ProjectManifest.ts:33`) — and its
`normalizeProjectManifest` — with:

```yaml
localization:
  defaultLocale: en      # locale used at boot and as template
  fallbackLocale: en     # final string fallback (usually = default)
  locales: [en, ru]      # declared locales; drives panel + export
```

Normalization defaults: absent block ⇒ `{ defaultLocale: 'en',
fallbackLocale: 'en', locales: [] }` — i.e. localization fully inert for
existing projects. The runtime never reads `pix3project.yaml` itself; the
config reaches the runtime via `LocalizationService.configure()` — called by
the editor (from the loaded manifest) and by the exported-game bootstrap
(config baked into the generated entry module the same way `quality` already
flows through `ProjectBuildService.buildGeneratedFiles`,
`src/services/ProjectBuildService.ts:102,438`).

### 1.4 Discoverability / round-trip

- Asset browser: `locales/` is a normal project directory; `.json` files are
  visible/editable. The classifier (`src/core/asset-categories.ts`) gets a
  `locales` category so by-type grouping shows them (nice-to-have, Phase 2).
- The Localization panel is the primary editor; it reads/writes the same
  files via the editor FS service, so external edits (git pull, hand edits)
  are picked up on project reload or a panel "reload" action.

---

## 2. `LocalizationService` (runtime)

### 2.1 Files (new, all under `packages/pix3-runtime/src/core/localization/`)

| File | Contents |
| --- | --- |
| `localization-types.ts` | `LocaleTable`, `LocalizationConfig`, `TrParams` types |
| `LocalizationService.ts` | the service class (below) |
| `active-localization.ts` | module-global active-instance pointer (§2.4) |
| `LocalizationService.spec.ts` | unit tests (pure, no DOM) |

Exported from `packages/pix3-runtime/src/index.ts` (`export * from
'./core/localization/...'`) — this automatically reaches in-editor user
scripts through the existing runtime import map
(`core/runtime-import-map.ts`), no extra wiring.

### 2.2 API

```ts
export interface LocalizationConfig {
  defaultLocale: string;              // 'en'
  fallbackLocale?: string;            // defaults to defaultLocale
  locales?: readonly string[];        // declared set (informational)
  tablePathTemplate?: string;         // default 'res://locales/{locale}.json'
}

export interface LocaleTable {
  locale: string;
  strings: Record<string, string>;
  sprites: Record<string, string>;
  meta?: { name?: string; direction?: 'ltr' | 'rtl' };
}

export type TrParams = Record<string, string | number>;

export class LocalizationService {
  configure(config: LocalizationConfig): void;
  attachResources(resources: ResourceManager | null): void; // loader source

  get locale(): string;                       // current locale id
  get locales(): readonly string[];
  setLocale(locale: string): Promise<void>;   // load-if-needed + notify
  setTable(table: LocaleTable): void;         // direct injection (editor/tests)

  tr(key: string, params?: TrParams): string; // strings lookup + interpolation
  trSprite(key: string): string | null;       // sprites lookup (res:// path)
  has(key: string): boolean;                  // in current-or-fallback chain

  onChange(listener: () => void): () => void; // locale switched / table edited
  dispose(): void;                            // clear listeners + caches
}
```

Notes:
- Plain class, **no editor DI decorators** — the runtime package doesn't use
  `@/fw/di` (consistent with `AudioService`, `Collision2DService`).
- `setLocale`: if the table isn't cached, `await
  resources.readText(tablePathTemplate.replace('{locale}', locale))` →
  `JSON.parse` → validate shape (missing/broken file ⇒ keep an empty table,
  `console.warn`, still switch — fallback chain covers rendering). Tables are
  cached in a `Map<string, LocaleTable>`; a second switch is synchronous.
- `tr` resolution: current table → fallback table → **the key itself**
  (Godot behavior; never throws, never returns empty for a typoed key).
  Interpolation replaces `{name}` tokens from `params`; unknown tokens are
  left as-is.
- Pluralization (Phase 3): convention-based suffix keys
  (`key.one`/`key.few`/`key.many`/`key.other`) selected via
  `Intl.PluralRules(locale)` behind `trPlural(key, count, params?)`. Not in
  MVP — SkyDefender doesn't need it, and the suffix convention needs no
  format change later.
- `onChange`: simple listener `Set`; fired by `setLocale` and `setTable`
  (the editor uses `setTable` for live table edits, giving instant viewport
  refresh while typing translations).

### 2.3 Fallback chain

`tr(key)`: `strings[current] → strings[fallbackLocale] → key`.
`trSprite(key)`: `sprites[current] → sprites[fallbackLocale] → null`
(caller keeps the node's authored texture — see §3.3).

### 2.4 Active instance — how nodes reach it

`active-localization.ts`, modeled 1:1 on
`packages/pix3-runtime/src/core/project-texture-filtering.ts` (globalThis
sink shared by runtime and editor without a service instance):

```ts
const KEY = '__PIX3_ACTIVE_LOCALIZATION__';
export function setActiveLocalization(svc: LocalizationService | null): void;
export function getActiveLocalization(): LocalizationService | null;
/** tr() through the active service; returns fallbackLiteral when no service
 *  is active or the key is empty. The one call nodes actually make. */
export function resolveLocalizedText(key: string, fallbackLiteral: string): string;
```

Lifecycle of the pointer:
- **Editor**: `LocalizationEditorService` (§4.1) creates one instance at
  project load, configures it from the manifest, loads the preview locale,
  and `setActiveLocalization(it)`. Editor-viewport label proxies therefore
  render translated text with zero node-side plumbing.
- **Play mode / exported game**: `SceneRunner.startScene` creates the game
  instance (fresh state — game `setLocale` calls must not leak into editor
  preview), seeds it with the *current preview locale* in-editor (so "preview
  ru → press Play" behaves as expected) or `defaultLocale` in exports, calls
  `setActiveLocalization(game)` and stashes the previous pointer;
  `SceneRunner.stop()` restores it and disposes the game instance.

Rationale vs alternatives: propagating a service reference down the node tree
(the `NodeBase.input` setter pattern, `nodes/NodeBase.ts:94-110`) works but
touches every attach path and still leaves the *editor* graph (which never
gets play-mode services) unserved; the globalThis sink pattern is already the
project's answer for exactly this "runtime nodes + editor viewport both need
a project-level setting" shape.

### 2.5 Surface on `SceneService` (script access)

Mirroring the lazy `get audio()` facade (`core/SceneService.ts:203-208`) and
delegate getters (`getAudioService` `:442`):

- `SceneServiceDelegate` gains `getLocalizationService(): LocalizationService | null`
  (implemented by `SceneRunner`, returning the play-mode instance).
- `SceneService` gains:

```ts
get localization(): LocalizationService {
  return (
    this.delegate?.getLocalizationService() ??
    getActiveLocalization() ??           // editor preview instance
    this.inertLocalization ??= new LocalizationService() // null-safe fallback
  );
}
```

Scripts (via `this.scene`, `core/ScriptComponent.ts:133`):
`this.scene.localization.tr('mission.name.2')`,
`await this.scene.localization.setLocale('ru')`,
`this.scene.localization.onChange(() => this.refreshHud())`.

### 2.6 Locale-change re-render (runtime)

`SceneRunner` subscribes to its instance's `onChange` in `startScene` and, on
fire, walks the live root nodes once:

- every `UIControl2D` with `labelKey !== ''` (or a Label2D with a stored
  dynamic key, §3.2) → `updateLabel()`;
- every node with a sprite key (§3.3) → re-resolve `trSprite`, and if the
  path changed, `assetLoader.loadTexture(newPath)` → `setTexture`/
  `setStateTexture` (async; textures cache by path in
  `AssetLoader.loadTexture`, `core/AssetLoader.ts:197`, so switching back is
  instant).

The walk lives in a small helper `applyLocaleToTree(roots, svc, assetLoader)`
in the localization dir so the editor reuses it verbatim (§4.2). Unsubscribe
in `stop()`.

---

## 3. Node integration

### 3.1 Text: explicit `labelKey` on `UIControl2D` (recommended)

**Decision**: an explicit key property, *not* Godot's "auto-translate treats
the literal as key" toggle.

- Backward compatible by construction — existing scenes have no `labelKey`,
  nothing changes.
- No accidental translation when a literal happens to equal a key.
- The literal `label` remains as the designer-visible fallback and as the
  extraction source ("extract" copies `label` into the default-locale table).
- It's a schema property ⇒ prefab override diffs work automatically
  (`SceneSaver.captureComparableProperties` `:685` walks the schema).

Changes in `packages/pix3-runtime/src/nodes/2D/UI/UIControl2D.ts`:

- `UIControl2DProps` + field: `labelKey?: string` / `labelKey: string`
  (default `''`), next to `label` (`:37`).
- New protected resolver used by every paint path:

```ts
protected getDisplayText(): string {
  return this.labelKey
    ? resolveLocalizedText(this.labelKey, this.label)
    : this.label;
}
```

- `UIControl2D.updateLabel()` (`:302`) and `Label2D.updateLabel()`
  (`Label2D.ts:133`, currently `const text = this.label ?? ''`) switch to
  `this.getDisplayText()`. That is the **only** render-side change — every
  subclass (Button2D, Slider2D, Bar2D, Checkbox2D, Joystick2D,
  InventorySlot2D) inherits it because all label painting funnels through
  `updateLabel()`.
- Property schema: add `labelKey` to the UIControl2D schema (`label` setValue
  block is at `:380-389`; `labelKey`'s setValue assigns and calls
  `this.updateLabel()`), `ui: { group: <same group as label>, editor:
  'localization-key' }` — a **new `PropertyUIHints.editor` variant**
  (`fw/property-schema.ts:72-77`), which is the sanctioned extension point
  for custom inspector widgets.
- Serialization: `SceneSaver.serializeCommonUIControlProps`
  (`core/SceneSaver.ts:761`) adds
  `if (node.labelKey !== '') props.labelKey = node.labelKey;`
  `SceneLoader.createNodeFromDefinition` passes `labelKey` through in the
  UIControl2D props branch (same place `label` is read today).

Precedence rule (documented in the inspector tooltip): **key wins over
literal when both are set**; the literal renders only when the key is empty
or no localization is active.

### 3.2 Dynamic text from scripts: `Label2D.setTextKey`

`setText(text)` (`Label2D.ts:67`) keeps literal semantics **and clears any
stored key** (least surprise: an explicit literal overrides localization).
Add:

```ts
/** Bind the label to a translation key; re-resolves on locale change. */
setTextKey(key: string, params?: TrParams): void {
  this.labelKey = key;
  this.labelKeyParams = params ?? null;  // runtime-only, NOT serialized
  this.updateLabel();
}
```

`getDisplayText()` on Label2D overrides the base to pass `labelKeyParams`
into `tr()`. The SceneRunner locale-change walk (§2.6) re-runs
`updateLabel()` for these nodes, so `setTextKey('hud.gold', { amount })`
survives a mid-game locale switch, whereas plain `setText(tr(...))` renders
correctly but goes stale on switch — the docs will steer scripts to
`setTextKey` for persistent labels and `setText` for one-frame/interpolated
text they re-set every frame anyway.

### 3.3 Localized sprites: `textureKey` indirection (recommended)

**Decision**: a per-node sprite key resolved through the locale table's
`sprites` section — *not* a filename convention (`btn_play.{locale}.png`).
The table centralizes what is localized (panel can list/validate it), lets
export enumerate per-locale sprite files (a naming convention is invisible to
the `res://` regex scan in `ProjectBuildService.collectResourcePathsFromText`),
and permits locales to share one file (fallback) without duplicate assets.

- `Sprite2D`: new `textureKey: string` (default `''`) + schema entry
  (`editor: 'localization-key'`, `group: 'Rendering'`). Resolution order in
  `SceneLoader` at the Sprite2D texture step (`SceneLoader.ts:1096`):

```ts
const localized = def.textureKey
  ? getActiveLocalization()?.trSprite(def.textureKey) : null;
const path = localized ?? authoredTexturePath;   // TextureResourceRef.url
assetLoader.loadTexture(path) ...
```

  The authored `texture` ref (`core/TextureResource.ts:1-4`) stays untouched
  as the universal fallback.
- `Button2D` (Phase 2): `stateTextureKeys: Partial<Record<Button2DSpriteState,
  string>>` resolved the same way at the state-texture load site
  (`SceneLoader.ts:1414`) and re-applied via `setStateTexture`
  (`Button2D.ts:137`) on locale change. For the SkyDefender MVP the three
  menu buttons are `Sprite2D`-skinned `Button2D`s with `label: ''`
  (`samples/SkyDefender/src/assets/scenes/menu.pix3scene:155-190`) — MVP can
  localize them with the normal-state key only, or restack them as Sprite2D
  under the button; the design includes `stateTextureKeys` so the proper fix
  is Phase 2, not a redesign.
- Locale-change re-resolution: the shared `applyLocaleToTree` walk (§2.6).
- Serialization: `SceneSaver`'s Sprite2D branch writes `textureKey` when
  non-empty; loader passes it through. Schema-registered ⇒ prefab diffs work.

Rejected alternative (documented for the record): `{locale}` token inside
`texturePath` (`res://ui/{locale}/play.png`). Less plumbing but opaque to
tooling, can't fall back per-key, and every consumer of the raw path
(AssetLoader cache keys, export scan, asset browser) would need token
awareness. Could still be added later as sugar that *generates* sprite-table
entries.

### 3.4 Editor viewport

The editor draws proxy label meshes, not runtime meshes
(`ViewportRenderService` mirrors label layout at `:5966-5987, :6092+`). Two
touches:

- `createUIControlLabelMesh` / `measureLabel2DBox` read `node.label` today —
  switch to `node.getDisplayText()` (make it public-ish via a
  `getDisplayText()` accessor; it's already the runtime's render source, so
  editor/runtime can't drift).
- On preview-locale change or table edit, the editor service (§4.2) calls the
  shared `applyLocaleToTree` on `SceneManager`'s roots, asks
  `ViewportRenderService` to rebuild the affected label visuals (same path
  property edits use — `updateUIControlLabelVisual`,
  `ViewportRenderService.ts:3627`), then `requestRender()` (mandatory per the
  on-demand render loop).

---

## 4. Editor authoring UX

### 4.1 `LocalizationEditorService` (new, `src/services/LocalizationEditorService.ts`)

`@injectable()` singleton with `dispose()`. Responsibilities:

- Load `locales/*.json` + the manifest `localization` block at project open
  (hook: same place `ProjectService.loadProjectManifest`
  (`ProjectService.ts:828`) consumers run); watch for project close.
- Own the **editor-preview `LocalizationService` instance**; call
  `setActiveLocalization()`; keep it fed via `setTable()` on every table edit
  so the viewport is live while typing.
- Expose the *authoring* model to panel/ops: `getTable(locale)`,
  `setEntry(locale, key, value)`, `removeKey(key)`, `addLocale(id)`,
  `removeLocale(id)`, `getMissing(locale): string[]` (diff vs default
  locale), `save(locale)` (pretty JSON, sorted keys, via the project FS
  service). Write-through on each op (MVP; dirty-tracking + Ctrl+S batch is a
  refinement).
- Mirror UI-relevant state into a new **`appState.localization`** slice:
  `{ locales: string[]; defaultLocale: string; previewLocale: string;
  missingCounts: Record<string, number>; revision: number }` — IDs/counters
  only, tables stay in the service (same state-vs-graph separation as the
  scene). Panels `subscribe(appState.localization, cb)`.

### 4.2 Preview locale switch

- UI: a locale dropdown in the Localization panel header **and** a compact
  selector in the viewport toolbar (globe icon via
  `IconService.getIcon('globe', IconSize.SMALL)` — Feather has `globe`).
- Flow: `SetPreviewLocaleCommand` → `SetPreviewLocaleOperation` (under
  `src/features/localization/`). The operation calls
  `localizationEditorService.setPreviewLocale(id)` (which awaits
  `setLocale`, runs `applyLocaleToTree`, refreshes label proxies,
  `requestRender()`) and returns undo/redo closures restoring the previous
  locale. It is an editor-view setting, so the operation is registered as
  **non-dirtying** (does not mark the scene modified), following the
  `UpdateEditorSettingsOperation` precedent (`src/features/editor/`).

### 4.3 Localization panel (Golden Layout)

New panel `pix3-localization-panel`
(`src/ui/localization-view/localization-panel.ts` + sibling `.ts.css`,
`ComponentBase`, Light DOM, theme tokens):

- Register `localization: 'localization'` in `PANEL_COMPONENT_TYPES`
  (`src/core/LayoutManager.ts:13-30`) + component factory + a Window-menu
  `OpenLocalizationPanelCommand` (menu comes from command metadata —
  `menuPath`/`addToMenu`, no hardcoding).
- Layout: toolbar (locale tabs + add/remove locale, filter input,
  "missing only" toggle, preview-locale dropdown, Extract button) over a
  grid: **rows = keys, columns = default locale + selected locale(s)**;
  missing cells get a warning tint derived from theme tokens; count badges
  per locale tab from `missingCounts`.
- Second tab "Sprites": key rows with a per-locale `res://` path cell using
  the existing texture picker affordance (`pix3-texture-resource-editor`
  pattern, `src/ui/object-inspector/property-editors.ts:497`).
- Every cell edit dispatches `UpdateLocaleEntryCommand` (§4.4). No direct
  service mutation from the component.

### 4.4 Commands + Operations (`src/features/localization/`)

| Command | Operation | Undo |
| --- | --- | --- |
| `UpdateLocaleEntryCommand` | `UpdateLocaleEntryOperation` | restore previous value / delete added key |
| `RemoveLocalizationKeyCommand` | `RemoveLocalizationKeyOperation` | reinsert removed values in all locales |
| `AddLocaleCommand` | `AddLocaleOperation` | delete created file + manifest entry |
| `RemoveLocaleCommand` | `RemoveLocaleOperation` | restore file content + manifest entry |
| `SetPreviewLocaleCommand` | `SetPreviewLocaleOperation` | restore previous preview locale (non-dirtying) |
| `RenameLocalizationKeyCommand` (P2) | `RenameLocalizationKeyOperation` | rename back (also rewrites `labelKey` in open scenes via the property op) |
| `ExtractLocalizationKeysCommand` (P2) | `ExtractLocalizationKeysOperation` | remove added template keys |

All operations mutate through `LocalizationEditorService` (which persists +
feeds the preview instance + bumps `appState.localization.revision`), and are
pushed through `OperationService`/`HistoryManager` like every other feature.
Setting a node's `labelKey`/`textureKey` from the inspector needs **no new
op** — it rides the existing `UpdateObjectPropertyCommand`/`Operation`
because it's a schema property.

### 4.5 Inspector affordance + extraction

- New widget `pix3-localization-key-editor` in
  `src/ui/object-inspector/property-editors.ts`, dispatched by the
  `editor: 'localization-key'` hint in `inspector-panel.ts`: text input with
  autocomplete over known keys (from `LocalizationEditorService`), a status
  glyph (IconService `check`/`alert-triangle`) showing whether the key
  resolves in the preview locale, and an **Extract** button — visible when
  the node has a literal `label` and empty `labelKey` — which (one command,
  two chained ops) creates `key = suggested from node path` in the default
  locale with the literal as value, then sets `labelKey` via
  `UpdateObjectPropertyOperation`.
- `ExtractLocalizationKeysCommand` (POT analog, Phase 2): scans all
  `.pix3scene` files for UIControl2D `label:` literals without `labelKey`,
  and project scripts for `tr('…')`/`setTextKey('…')` string literals
  (regex, same approach as `ProjectBuildService.collectResourcePathsFromText`),
  then reports into the panel (unlocalized literals list with per-item
  Extract) and adds missing keys to non-default locale tables as `""`
  (missing) so translators see the full template.

---

## 5. Script-facing API & SkyDefender migration

Scripts get the service two ways (both already-existing patterns):
`this.scene.localization` (any Script), or
`import { getActiveLocalization } from '@pix3/runtime'` (data modules like
`SdBalance.ts` that have no scene reference — resolved lazily at call time,
never at module init).

**Before** (`samples/SkyDefender/scripts/SdBalance.ts:348`):

```ts
export const MISSION_NAMES: readonly string[] = [
  'Prologue',
  'On Guard',
  // …
];
// consumer (MapController):
missionTitle.setText(MISSION_NAMES[missionIndex]);
```

**After**:

```ts
export const missionNameKey = (mission1Based: number): string =>
  `mission.name.${mission1Based}`;
// consumer:
missionTitle.setTextKey(missionNameKey(missionIndex + 1));
```

with `locales/en.json` → `"mission.name.1": "Prologue", "mission.name.2":
"On Guard", …` (generated once by a small migration script or the extraction
tool), and `locales/ru.json` holding translations.

**Briefings** (`SdBalance.ts:498-614`) keep their *shape* but store keys:

Before:

```ts
briefing: [
  { speaker: 'King', text: 'Joe, we have little time, so I will be brief. …' },
],
goal: 'Destroy all enemy forces.',
```

After:

```ts
briefing: [
  { speakerKey: 'speaker.king', textKey: 'briefing.m1.1' },
],
goalKey: 'mission.goal.1',
// display site (GameFlow briefing dialog):
speakerLabel.setTextKey(line.speakerKey);
textLabel.setTextKey(line.textKey);   // typewriter reveal starts on set
```

Speaker names become shared keys (`speaker.king`, `speaker.fargo`,
`speaker.joe`) — one translation reused everywhere. Scene-authored literals
(e.g. `menu.pix3scene:206` `label: 'Sky Defender Remaster — M0 flow
skeleton'`) migrate via the inspector Extract button (sets `labelKey`, keeps
the literal as fallback). Menu button sprites (`label: ''`, baked text) get
`sprites` keys per §3.3 with `en/`+`ru/` PNG variants.

---

## 6. Build / export

- `ProjectBuildService.collectAssetPaths` (`ProjectBuildService.ts:197`):
  1. add `locales/*.json` via the existing
     `discoverFilesByExtension('locales', '.json')` helper (`:251`);
  2. parse each discovered table and add every `sprites` value to the file
     set (these paths are *not* visible to the `res://` regex scan of scenes/
     scripts — this is the one mandatory export change);
  3. they then appear in `asset-manifest.json` (`:460`) automatically.
- `PlayableHtmlBuildService`: nothing localization-specific — locale JSONs
  ride the embedded-assets base64 module
  (`PlayableHtmlBuildService.ts:375-405`), and
  `ResourceManager.readText` already prefers embedded entries, so `setLocale`
  works offline inside the single-file HTML.
- Bootstrap config: `buildGeneratedFiles` (`:438`) bakes the manifest's
  `localization` block into the generated entry module (like `quality`); the
  generated bootstrap calls `localization.configure(cfg)` +
  `await setLocale(cfg.defaultLocale)` before `startScene` so the first
  frame renders translated (avoids a visible key→text flash).
- Later (P3, optional): export dialog checkbox set "include locales" to ship
  a subset; per-locale sprite pruning falls out of step 2 filtering.

---

## 7. Edge cases & risks

| Case | Behavior / mitigation |
| --- | --- |
| Missing key | `tr` falls through current → fallback → returns the key itself; never throws. Panel surfaces missing counts; optional `debugMissing` flag renders `[[key]]` in editor preview. |
| Key set AND literal set | Key wins (documented; inspector shows resolved text as the input's live preview). Literal is the no-service/no-key fallback — old scenes and non-localized projects behave identically to today. |
| Prefab overrides | `labelKey`/`textureKey` are schema properties ⇒ `captureComparableProperties`/diff (`SceneSaver.ts:685`) handles instance overrides automatically. Gotcha: overriding the *literal* on an instance whose prefab sets a key changes nothing visually (key wins) — the localization-key inspector widget shows a hint when a non-empty key shadows an overridden literal. |
| Typewriter reveal (`Label2D.typewriterSpeed`) | `updateLabel()` re-layout restarts the reveal on locale switch mid-print — acceptable (rare), but guard: skip typewriter restart when the resolved text is unchanged (already true: `setText` early-returns on equal text; `updateLabel` tracks `renderState.text`). |
| Canvas repaint cost on locale switch | One canvas layout+paint+GPU upload per keyed control. SkyDefender scale (≤ dozens visible) is trivial; the walk runs once per switch, then a single `requestRender()`. No per-frame cost — resolution happens only inside `updateLabel()`, not in `tick`. |
| Sprite switch latency | `loadTexture` is async; old texture stays until the new one lands (no flash of nothing). Paths cache in `AssetLoader.textureCache`, so toggling locales back is instant. Memory grows by locales×localized-sprites — bounded, note in docs. |
| Fonts / glyph coverage | Canvas 2D uses `labelFontFamily`; system fallback covers Cyrillic/CJK, but custom game fonts may lack glyphs. Note-only for now; future: optional `$meta.fontFamily` per locale applied by `getDisplayText` consumers. |
| RTL | `fillText` renders bidi runs, but box alignment/mirroring is not handled. Deferred; `$meta.direction` is already in the format so no migration later. |
| Editor/play instance leak | `SceneRunner.stop()` must restore the stashed editor pointer even on abnormal stop (place in the same teardown that already handles cutscene cancel). |
| Locale file broken JSON | Service warns + treats as empty table; editor panel shows a load-error banner instead of silently dropping translations. |
| Two `ProjectManifest` shapes | Only the editor one (`src/core/ProjectManifest.ts`) gains the block; the runtime never parses the manifest (config injected). No drift risk. |

---

## 8. Phased plan

### Phase 0 — Runtime core + node text path (MVP part 1)

Add:
- `packages/pix3-runtime/src/core/localization/localization-types.ts`
- `packages/pix3-runtime/src/core/localization/LocalizationService.ts`
- `packages/pix3-runtime/src/core/localization/active-localization.ts`
- `packages/pix3-runtime/src/core/localization/apply-locale-to-tree.ts`
- `packages/pix3-runtime/src/core/localization/LocalizationService.spec.ts`

Edit:
- `packages/pix3-runtime/src/index.ts` — export the new module.
- `packages/pix3-runtime/src/nodes/2D/UI/UIControl2D.ts` — `labelKey` prop/
  field/schema (+ `editor: 'localization-key'` hint), `getDisplayText()`,
  `updateLabel()` reads it.
- `packages/pix3-runtime/src/fw/property-schema.ts` — add
  `'localization-key'` to `PropertyUIHints.editor`.
- `packages/pix3-runtime/src/nodes/2D/UI/Label2D.ts` — `updateLabel` text
  source, `setTextKey`, `setText` clears key.
- `packages/pix3-runtime/src/core/SceneSaver.ts` — persist `labelKey`
  (`serializeCommonUIControlProps`).
- `packages/pix3-runtime/src/core/SceneLoader.ts` — read `labelKey`.
- `packages/pix3-runtime/src/core/SceneRunner.ts` — create/configure/activate
  service, delegate getter, locale-change walk, restore-on-stop.
- `packages/pix3-runtime/src/core/SceneService.ts` — `get localization()`,
  delegate interface.

Exit criteria: unit tests green; a script can `setLocale('ru')` in play mode
and every keyed Label2D re-renders.

### Phase 1 — Editor preview + inspector + manifest (MVP part 2)

Add:
- `src/services/LocalizationEditorService.ts` (+ spec)
- `src/features/localization/SetPreviewLocaleCommand.ts` / `...Operation.ts`
- `src/features/localization/UpdateLocaleEntryCommand.ts` / `...Operation.ts`

Edit:
- `src/core/ProjectManifest.ts` — `localization` block + normalization.
- `src/state/AppState.ts` — `localization` slice.
- `src/ui/object-inspector/property-editors.ts` +
  `src/ui/object-inspector/inspector-panel.ts` — `pix3-localization-key-editor`
  widget for the `localization-key` hint (autocomplete, status icon, Extract).
- `src/services/ViewportRenderService.ts` — label proxies render
  `getDisplayText()`; refresh hook on locale change.
- Viewport toolbar component — preview-locale dropdown (globe icon).

Exit criteria: switch preview locale in the editor and see scene labels
change in the viewport; set `labelKey` from the inspector (undoable).

### Phase 2 — Localization panel + sprites + extraction + export

Add:
- `src/ui/localization-view/localization-panel.ts` + `.ts.css`
- `src/features/localization/{AddLocale,RemoveLocale,RemoveLocalizationKey,ExtractLocalizationKeys}Command/Operation.ts`

Edit:
- `src/core/LayoutManager.ts` — panel type + registration; Window-menu command.
- `packages/pix3-runtime/src/nodes/2D/Sprite2D.ts` — `textureKey` (+schema);
  `packages/pix3-runtime/src/nodes/2D/UI/Button2D.ts` — `stateTextureKeys`.
- `packages/pix3-runtime/src/core/SceneLoader.ts` — sprite key resolution at
  the Sprite2D (`:1096`) and Button2D states (`:1414`) load sites;
  `SceneSaver.ts` — persist them.
- `src/services/ProjectBuildService.ts` — locale files + sprite-table paths
  in `collectAssetPaths`; bake `localization` config into generated bootstrap.

Exit criteria: SkyDefender menu buttons swap EN/RU sprite skins with locale;
exported zip/playable HTML boots in `defaultLocale` with locales embedded.

### Phase 3 — SkyDefender migration (the proof) + polish

- `samples/SkyDefender/locales/en.json` + `ru.json` (generated via extraction
  + briefing migration script).
- `samples/SkyDefender/scripts/SdBalance.ts` — key helpers replace
  `MISSION_NAMES` literals; `MISSION_META` briefings/goals move to
  `speakerKey`/`textKey`/`goalKey`.
- `GameFlow`/`MapController`/`HudController`/`ShopController` — `setText(...)`
  → `setTextKey(...)` where persistent.
- Scene files — `labelKey` on authored labels; sprite keys on menu buttons.
- Polish: `trPlural`, rename-key refactor op, `locales` asset-browser
  category, missing-key debug decoration.
- **Docs** (required by AGENTS.md): update `docs/nodes-and-systems.md`
  (LocalizationService + labelKey/textureKey + script API),
  `docs/pix3-specification.md` (manifest block, locale file format), and the
  `pix3-game-dev` skill notes. `yalc:publish` + DeepCore `yalc update`.

### Open product decisions (recommendation first)

1. **Explicit `labelKey` vs Godot-style auto-translate toggle** — recommend
   explicit `labelKey` (backward-compatible, collision-proof, prefab-diff
   friendly). Auto-translate could be added later as a project setting that
   pre-fills keys, without format changes.
2. **Per-locale JSON vs CSV/PO/YAML** — recommend JSON (native runtime parse,
   embedded-export-friendly, merge-friendly with sorted keys); PO/CSV become
   editor-side import/export converters if a translation vendor needs them.
3. **Sprite localization via table indirection (`textureKey` + `sprites`
   section) vs `{locale}` path token** — recommend the table (visible to
   panel + export enumeration, per-key fallback); the token stays a possible
   later sugar.
4. (Minor) **Locale-file save policy** — recommend write-through on each
   panel/operation edit (matches undo closures 1:1); revisit batching only if
   FS churn is noticeable.
