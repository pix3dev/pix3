# Session prompt — Localization: commit Phase 2+3 + post-MVP polish

> Paste the section below as the first message of a fresh Claude Code session in the `pix3` repo.
> Everything above this line is a note; everything below is the prompt.

---

Continue the **unified localization (i18n/l10n) system for Pix3**. **All planned phases (0–3) are implemented and live-verified**, but the Phase 2+3 work sits **uncommitted in the working tree** — your first job is to review and commit it in sensible increments, then take the post-MVP polish backlog.

## Authoritative context — read first
- **`.plans/localization-design.md`** — the full design (source of truth for data model, API, phases §8, open decisions).
- `docs/pix3-specification.md` **§6.17 Localization** (v1.22) and the Localization section in `docs/nodes-and-systems.md` — describe exactly what shipped.
- Auto-memory `localization-i18n.md` has the condensed history + debug lessons.
- `AGENTS.md` / `CLAUDE.md` as always; `pix3-ui-conventions` before touching panel UI, `pix3-game-dev` before runtime work.

## What is DONE and in the working tree (uncommitted) — commit it, don't rebuild

Run `git status` first; roughly the changeset is:

**Runtime (`packages/pix3-runtime`)** — after committing: `npm run yalc:publish` + `yalc update` in `../DeepCore` (already done for the current tree, repeat only if you amend):
- `Sprite2D.textureKey` + `Button2D.stateTextureKeys` (schema props `textureNormalKey`/`textureHoverKey`/`texturePressedKey`/`textureDisabledKey`, editor hint `localization-key`) with `getEffectiveTexturePath()` / `getEffectiveStateTexturePath(state)` as the single source of truth; SceneLoader resolves through them, SceneSaver persists them.
- `apply-locale-to-tree.ts` takes an optional `LocaleTextureLoader` and re-resolves keyed sprite textures on locale change (stale async loads dropped).
- `LocalizationService.trPlural(key, count, params?)` — `Intl.PluralRules` suffix keys `.one/.few/.many/.other`, falls to `.other` → bare key, `{count}` auto-token. Spec tests incl. ru one/few/many.
- **`SceneRunner`: `runGraph` is now async and AWAITS the seed locale table before the first frame** (`setupLocalization` async). This kills the frame-1 raw-key flash. Critical detail: an unfocused/paused session freezes the Game canvas on frame 1, so without this the game *looks* unlocalized (cost us an hour of debugging — see Verification below).
- `main.ts` bootstrap reads `runtimeLocalization` from the generated scene-manifest and calls `setLocalizationConfig` before `startScene`; placeholder `generated/scene-manifest.ts` gained the export.

**Editor (`src/`)**:
- Localization panel `src/ui/localization-view/` with **Strings/Sprites section tabs**; service + `UpdateLocaleEntry`/`RemoveLocalizationKey` commands/ops take `section: 'strings' | 'sprites'`.
- `AddLocale`/`RemoveLocale`/`RemoveLocalizationKey`/`OpenLocalizationPanel` commands+ops (`src/features/localization/`), LayoutManager panel registration (`revealLocalizationPanel` docks before Inspector), View-menu entry.
- `ViewportRenderService`: sprite proxies + Button2D skins render effective (localized) texture paths; `refreshLocalizedLabels()` also refreshes keyed sprite proxies.
- `ProjectBuildService`: `collectLocaleAssetPaths` ships `locales/*.json` + every `sprites`-section texture; bakes `runtimeLocalization` into the generated scene-manifest.
- `LocalizationEditorService.keyResolvesInPreview` checks both `strings` and `sprites` (inspector status glyph fix).

**SkyDefender migration (`samples/SkyDefender/`)** — the Phase-3 proof:
- `SdBalance.ts`: `BriefingLine = { speaker, textKey }`, `goalKey`, helpers `missionNameKey(n)`/`speakerKey(s)`, missions 4–30 collapsed into `stubMeta(n)`.
- `MapController`/`GameFlow`/`ShopController` → `setTextKey`/`tr(...)` with params; wave-failed banner uses `trPlural`; shop item names/descs via `shop.item.<id>.*` keys.
- `locales/en.json` + `ru.json` (~190 keys each; EN generated from SdBalance data, RU авторский перевод). Generator script (one-off) was in the session scratchpad — regenerate by hand-editing the JSONs directly if needed.
- Authored `labelKey` on menu subtitle + map mission-title; `localization:` block in `pix3project.yaml`.

**Docs**: spec §6.17 + v1.22 changelog + header bump; nodes-and-systems Localization section (incl. trPlural + SkyDefender reference).

**Verified live** (chrome-devtools MCP on SkyDefender): panel authoring writes sorted `$meta` JSONs; editor preview switch flips authored labels AND `textureKey` sprite proxies (en→CONTINUE / ru→CREDITS); play mode starts in the preview locale with frame 1 already translated; mission-1 briefing shows «Миссия 1 — Пролог», «Король», RU dialog. Full suite: 1212 passed, 1 pre-existing fail (`UpdateCheckService`); lint clean; tsc at the ~32-error baseline.

**Commit plan suggestion** (confirm with me first): (1) runtime sprites+trPlural+first-frame-await, (2) editor panel/commands/viewport/export, (3) SkyDefender migration + locales, (4) docs. End commit messages with the standard Co-Authored-By line.

## Post-MVP backlog (after committing — pick with me)
1. **`ExtractLocalizationKeysCommand`** (design §4.5): scan `.pix3scene` files for UIControl2D `label:` literals without `labelKey` and scripts for `tr('…')`/`setTextKey('…')` literals; report into the panel (unlocalized list with per-item Extract); add missing keys to non-default locales as `""`.
2. **`RenameLocalizationKeyCommand`/Operation** (design §4.4): rename across all locale tables + rewrite `labelKey`/`textureKey` in open scenes via the property op.
3. **Per-locale Button2D skins for the SkyDefender menu** — blocked on RU-baked button art; the `generate-sprites-in-editor` skill can produce it (needs the in-editor AI key configured).
4. `locales` category in `src/core/asset-categories.ts` (asset-browser by-type grouping).
5. (Optional, design §1.2) PO/CSV import-export converters over the JSON model.

## ⚠️ Verification environment (hard-won lessons)
- **Frozen-first-frame trap**: an MCP-driven (unfocused) Chrome pauses the game render loop; the Game canvas keeps the FIRST frame forever. If play mode "shows raw keys", check the live nodes first: `globalThis.__PIX3_RUNTIME_SCENE__.traverse(o => ...)` — read `renderState.text`/`getDisplayText()`; if those are translated, the localization is fine and you're looking at a stale frame. (The await-seed fix makes frame 1 correct, so this should no longer bite for locale text specifically.)
- User-script registration needs the page compiled state — check the Logs panel for "Scripts compiled and loaded successfully" before judging play mode; `d.agentTools.execute('check_scripts', {})` type-checks all project scripts.
- `window.__PIX3_DEBUG__.command(id)` takes NO args (`executeById`) — parameterized commands can't be driven through it; drive the panel/inspector DOM directly (dispatch `change` events) or use `d.agentTools.execute(name, argsObject)` (e.g. `create_node` wants `{nodeType, name, parentNodeId}`).
- `d.setProperty({nodeId, propertyPath: 'textureKey', ...})` returned `false` in one session while the inspector-widget path worked — unresolved bridge quirk; prefer the widget input.
- The `create_node` agent tool **auto-saves the scene** — after MCP experiments, `git checkout` test scenes and delete stray test nodes/locales from real sample projects.
- Editor renders on demand: MCP `take_screenshot` forces a paint; screenshot after every state change. Preview-locale switch: Localization panel → `select[aria-label="Preview locale"]`.
- SkyDefender opens via the persisted local project in the MCP Chrome profile (`http://localhost:8123`, dev server `npm run dev`); if the profile lost it, ask me to re-pick `samples/SkyDefender`.

## Conventions
- Mutation gateway (Command+Operation) for every editor state change; DI; Light-DOM Lit + IconService (never emoji) + theme tokens; no `any`.
- Runtime package stays editor-agnostic; `yalc:publish` + DeepCore `yalc update` after runtime changes.
- tsc stays at the ~32-error baseline; ignore repo-wide CRLF `Delete ␍` lint noise; keep the full vitest suite green (1 known `UpdateCheckService` fail).
- Backward-compatible: projects with no locales stay byte-identical in behavior.

Start by running `git status` + `git diff --stat`, propose the commit split for my confirmation, commit, then present the post-MVP backlog and let me pick.
