# pix3-core: редакция Pix3 как Vite-плагин + runtime + kit

Дата: 2026-10-08, ревизия 6 (после ревью 1–9 и спайков P0; отчёты — `pix3-core-spikes/reports/` и решения владельца о модели правки, журнал — §J). Статус: P0 завершён, P1 идёт (репо `pix3-core` засеян).

**Основа:** brief «pix3-core» (решения 1–6 не пересматриваются); coupling map; `.plans/essential-restructure.md` rev 4 (B.1/B.2 — «что портировать», D.5 — протокол MVP; серверная, hosted-, pair-, offline- и channel-часть отменена); ревью `.plans/pix3-core-review.md`.

Пути без префикса — в текущем репо `pix3`, который после посева становится `pix3-full`.

## 0. Коротко

1. **Продукт.** Обычный Vite+TS проект плюс `@pix3/vite-plugin` (редактор на `/__pix3/` того же dev-сервера, файловый API, sync, сборка), `@pix3/runtime`, `@pix3/cli`, `create-pix3` и prebuilt `@pix3/editor-core` за интерфейсом `EditorHost`.
2. **Один экземпляр runtime** подтверждён S1 (Vite 7.3.7 и 8.3.3, шаблон и DeepCore-образный проект); план C не нужен.
3. **Скрипты** — Vite-модули, без esbuild.wasm. **Вариант Б по умолчанию** (редактор без `/@vite/client`, свой WS, ~60 строк по S1); А — fallback.
4. **Play внутри страницы.** `pix3_sync` = flush редактора → rescan → барьер (S1, 13–26 мс: hard-инвалидация корня, `environment.reloadModule`, ack со штампами исполненного). Во время play — `stale` с владельцем сессии.
5. **Файлы — истина в каждой точке синхронизации, память — ограниченная транзакция:** история в памяти как сейчас; write-behind (простой 1,5 с / ≤10 с, Ctrl+S, play/build, sync; никогда во время жеста); flush — сплайс-патч YAML от baseline с `If-Match` (S12: 378/390); несохранённое — дельта состояния, слияние по ключам; черновик в IndexedDB; changeset — staging и восстановление; серверный `writerId` для вкладок.
6. **Агент: Chrome DevTools MCP 1.10.1**, 3p-инструменты страницы (S4: экранирование 0 %, с первой попытки 98 %; inline `evaluate_script` — fallback, 95 %). Своего MCP нет. Токен-прокси CDP обязателен до stranger-теста и для SSH.
7. **Сборка** — `vite build` с плагином: single-file HTML или zip, strip по `mentionedNames`; проверка в preview, `file://`, `<iframe sandbox>`. Vite 7 и 8, шаблон на 8.3.3.
8. **Сроки** (арифметика в G.6):

   | Путь | Рабочих дней | Недель |
   |---|---|---|
   | полный, от 2026-10-08 | 78–88,5; 75–85,5 с наложением C2 на P2 | 15–17,7 |
   | без документов сцен при сборке (B.6.4 после P4) | 75–85,5; 72–82,5 | 14,4–17,1 |
   | кратчайший до dogfood `alpha.1` (C1 Igor'я) | 39–44 | 7,8–8,8 |
   | питч на dogfood-альфе (G.6, решение владельца) | 39–44 до питча | 7,8–8,8 |

9. **Главные риски:**
    - порт editor-core (оценка 11–14 дней — самая ненадёжная);
    - контракт записи: baseline, нормализация, слияние дельты, flush в полёте, транзакции. Поэтому его гейты стоят в P1 до dogfood;
    - опора на экспериментальный 3p-флаг chrome-devtools-mcp.

## A. Форма продукта и репозиторий

### A.1 Пакеты `pix3-core`

| Пакет | Ответственность | Контракт |
|---|---|---|
| `packages/runtime` → `@pix3/runtime` | движок (62,6k) | API без изменений. Удаляются player-шаблоны `src/main.ts`, `register-project-scripts.ts`, `virtual-modules.d.ts` (исключены в `tsconfig.json`, это не API) — они переезжают в плагин. `engines` → `>=20.19`. Сеть остаётся. `three` закрепляется `~0.183` (API `TransformControls` менялся). **`lit` объявляется** (peer или dependency): `src/index.ts:158` реэкспортирует `lit/decorators.js`, и без этого чистый шаблон не проходит пре-бандл (S1) |
| `packages/cli` → `@pix3/cli` | `validate`, `check`, `smoke`, `tree`, `sfx`, `kit` (+ `--migrate`), `character-compile`, `editor`, `agent-setup` | Удаляются `serve/` (маршруты → плагин), `workspace-agent/`, `mcp*.ts`, `link-server.ts`, `ack`, `new`. **Гейт версий:** `smoke`/`check` сверяют свой забандленный runtime (`scripts/build-smoke.mjs`) с `node_modules/@pix3/runtime` проекта, иначе `E_RUNTIME_VERSION` |
| `packages/vite-plugin` → `@pix3/vite-plugin` | dev-middleware, редактор, sync, virtual-модули, build; подпуть `./player` | `pix3({ resRoot='.', editor=true, build='html'\|'zip'\|false, compress=false, allowRemote=false })`. Virtual-модули `virtual:runtime-{embedded-assets,spine,postprocessing,network}` (имена сохранены, при `build:false` **не объявляются** — DeepCore объявляет свои), `virtual:pix3/{scene-manifest,project-scripts,editor-host,editor-scripts,spine-loader}`. HTTP `/__pix3/api/*`. События `pix3:*` |
| `packages/editor-core` → `@pix3/editor-core` | Lit-редактор, prebuilt ESM `dist/` | `mountEditor(el, host: EditorHost)`, `EditorHost = {files, events, sync, scripts, build?, openInEditor?, info}`. В `dist/`: `optimize-deps.json` (все bare-подпути externals), ассеты редактора, `THIRD_PARTY_NOTICES` |
| `packages/create-pix3` → `create-pix3` | `npm create pix3@latest <dir> -- --template <id> --yes` | шаблоны (с историей) и kit, код бандлится внутрь |
| позже `packages/vscode` | webview-хост | после P4 |

Имена `create-pix3`, `@pix3/vite-plugin` и `@pix3/editor-core` на npm свободны (E404, 2026-10-07).

### A.2 Посев

1. **runtime, cli, docs, шаблоны** переносятся с историей: `git filter-repo` по клону:
   ```
   --path packages/pix3-runtime/ --path packages/pix3-cli/ --path docs/ --path src/templates/projects/
   --path-rename packages/pix3-runtime/:packages/runtime/
   --path-rename packages/pix3-cli/:packages/cli/
   --path-rename src/templates/projects/:packages/create-pix3/templates/
   ```
   После этого в `pix3-core`:
   - `scripts/copy-templates.mjs:10` и `src/templates.ts` перенаправляются, сейчас там захардкожен `../../src/templates/projects`;
   - спеки шаблонов (`recipes.spec.ts:9-10` импортирует `flow/PrototypeBootstrapService`, `agent/game-routines`) переводятся на копии `RECIPE_CATALOG` и `parseRoutine` в `create-pix3`.
2. **editor-core** заводится копированием каталогов F.1, без истории. SHA источника — в первом коммите.
3. **`agent-skills/{engine-api-map,verify-and-fix,game-prototype}.md`** → `packages/cli/kit-src/`.
4. **Документы `pix3-core`.**
   - Корень: `CLAUDE.md` — роутер, урезанный до core; `AGENTS.md` — правила кода; `README.md`.
   - **Version of record** — Change Log в `docs/pix3-specification.md` **pix3-core**, начиная с 2.0. В `pix3-full` спек получает шапку «заморожен на 1.6.x, актуальный — pix3-core».
   - `.claude/skills`:
     - `debug-running-game` переписывается под 3p-инструменты (сейчас вызывает `agentTools.execute`);
     - в `pix3-game-dev` удаляются ссылки на Sprite Editor;
     - `pix3-ui-conventions` переносится как есть;
     - `generate-sprites-in-editor` удаляется.
5. **`pix3-full`** получает один коммит (~1 день) и замораживается:
   - зависимости `@pix3/runtime@~1.6.3`, `@pix3/cli@~1.6.3` из npm;
   - алиасы и globs `PlayableHtmlBuildService.ts:157-224`, `ProjectBuildService.ts:176`, `ensure-agent-kit.mjs` указывают на `node_modules`;
   - далее только security-фиксы.

   При провале (б) `pix3-full` может перейти на runtime 2.x: API не меняется, ~1 день.

### A.3 Версии, публикация, лицензии

- **Версии.** Lockstep `2.0.0-alpha.N`, источник — корневой `package.json`.
- **Гейт плагина.** Для пререлизов версии `@pix3/runtime` проекта и `editor-core` должны совпадать **точно**, для релизов — по minor. Иначе `/__pix3/` показывает «`npm i @pix3/runtime@X`».
- **Публикация:** OIDC trusted publisher для `@pix3/runtime`/`@pix3/cli` перерегистрируется на `pix3dev/pix3-core`; три новых имени — первая публикация вручную с 2FA; пререлизы — `--tag next`.
- **Лицензии:** `editor-core` инлайнит lit, valtio, golden-layout, yaml — сборка пишет `THIRD_PARTY_NOTICES`, `licenses:report` в CI.
- **CI:** lint, type-check, vitest; `npm pack` со сканом на Spine; сборка DeepCore на runtime 2.x; браузерный гейт (с P2).

### A.4 Миграция DeepCore (`^1.6.2` → 2.0)

1. `@pix3/runtime@2` — без изменений кода (у DeepCore свои `src/main.ts` и `register-project-scripts.ts`).
2. `npx pix3 kit --migrate`: убирает `.mcp.json` (`@pix3/cli@1.6.2 mcp --workspace`) и `.claude/skills/pix3-verify`, чистит `metadata.agentKit`/`pix3Hybrid`, ставит kit 2.0.
3. По желанию `pix3({ resRoot: 'src/assets', build: false })`; взаимодействие `alias ^three$` с `dedupe` проверяется в S1. Позже — `build: 'html'`.

### A.5 Отклонённые форм-факторы (brief)

| Вариант | Почему нет |
|---|---|
| Photino.NET | WKWebView на macOS без CDP; неподписанный exe ловит SmartScreen/Gatekeeper; +C#; Node всё равно нужен для `check`/`smoke`/`validate`/`kit` |
| PWA + тонкий MCP | LNA-промпт https→localhost (Chrome ≥138); персистентность FSA под вопросом; только Chrome; нет CDP в обычный профиль → свой канал; версия редактора отвязана от CLI |
| Tauri | WKWebView, нет CDP |
| CLI-hosted редактор с сервером под MCP (rev 4) | сложность жизненного цикла была симптомом отсутствия FS у рендерера |
| Electron | только fallback, если зависимость от Chrome станет трением |

## B. Vite-плагин

### B.0 Хуки

Используются только стабильные хуки (vite.dev, v8.3):
- `configureServer`, `server.middlewares`; `/__pix3/` подключается **pre**-middleware, с учётом `base`;
- `server.ws.send`;
- `server.watcher`;
- `server.transformIndexHtml`;
- `config`;
- `resolveId`/`load` с `\0`;
- `configurePreviewServer`, `generateBundle`/`closeBundle`;
- `handleHotUpdate`.

Environment API (RC) не используется. Под Vite 8 опции идут через совместимый `rollupOptions`; `codeSplitting`/`inlineDynamicImports` выбираются по `this.meta.rolldownVersion`. Поддерживаются `peer vite ^7 || ^8`, шаблон на 8.3. Vite 5/6 — нет. `server.fs.allow` дополняется `editor-core/dist` (на случай hoisting и pnpm). CSS редактора отдаётся статикой мимо PostCSS проекта.

### B.1 Dev-сервер

- **`/__pix3/`** — HTML редактора.
  - Ассеты редактора — с `/__pix3/assets/` через `new URL(…, import.meta.url)`: сейчас `ViewportAdornments.ts:63-77` грузит `/cam.png` и др. от корня, то есть из чужого `public/`. Так же в каркасе W от корня запрашивался `esbuild.wasm` — компилятор скриптов не загрузился, агент в S4 нашёл это сам; гейт — ни одного запроса редактора вне `/__pix3/` в network-логе.
  - `mountEditor` грузится из `virtual:pix3/editor-host`.
- **Файловый API** `/__pix3/api/*` с контрактом `pix3 serve` (`packages/pix3-cli/README.md`):
  - `file` GET/HEAD/PUT с ETag = sha256 и `If-Match` / `If-None-Match:*`;
  - `manifest`, `hash`, `mkdir|move|delete`, `hello`;
  - **`changeset`** (C.4): preflight `If-Match` всех файлов, staging, intent-журнал, rename, групповое событие;
  - **`sync`** (B.3), `history`/`restore` (C.3), `build` (B.6).

  Маршруты — порт `serve/workspace-server.ts` и соседей **уже в P0** (walking skeleton); клиент — `WorkspaceClient.ts` с базой `/__pix3/api`, без токена.
- **Защита записи:** Host-check (loopback + `server.allowedHosts`); мутации требуют `X-Pix3: 1` и свой `Origin`; с не-loopback адресов — только при `allowRemote`.
- **События.**
  - Watcher фильтрует `resRoot` и каталоги скриптов; стабилизация — два хеша через 300 мс (`STABILITY_INTERVAL_MS`).
  - Затем `pix3:fs {seq, path, op, sha, author, changeset?}`; `author=editor`, если sha совпал с последней записью плагина. Changeset даёт **одно** групповое событие после завершения.
  - Отслеживаются сцены, ассеты, скрипты, bot-политики (`design/tests/bots/**`) и **транзитивные локальные исходники** корней `editor-scripts`/`bot-policies` по графу Vite, включая add/delete.
- **Обнаружение:** `.pix3/dev.json` `{url, editorUrl, port, pid, versions}` (пишется на `listening`, удаляется на `close`) и строка `Pix3 editor: …/__pix3/` в stdout. `/__open-in-editor` (встроен в Vite) заменяет Monaco.
- **Ключи генерации картинок** — в `~/.pix3/keys.json` (0600), подставляются прокси плагина `/__pix3/api/proxy/{gemini,openai}`; в localStorage их нет (origin = порт, его делят проекты и код игры). Ключи UI-состояния префиксуются `projectId`. Если песочница не даёт писать в `~` (S3) — `.pix3/local/keys.json` (gitignore).

### B.2 Один экземпляр runtime, скрипты, `full-reload`

**Подтверждено S1** (`pix3-core-spikes/reports/pix3-core-p0-s1.md`): шесть проверок `instanceof` и один чанк `three` в шаблонном и DeepCore-образном проекте (с `alias ^three$`) на Vite 7.3.7 и 8.3.3, в вариантах А и Б. Нет «new dependencies optimized» ни при первом, ни при повторном открытии. TTI на 4 vCPU с SwiftShader: холодный 0,4–0,6 с, тёплый 0,23–0,5 с, повторное открытие 55–70 мс — запас ×5 к порогу 5 с / 2 с. Вариант Y и план C не нужны.

**Механизм.** `config()` плагина:
- `resolve.dedupe: ['three', '@pix3/runtime']`;
- `optimizeDeps.include: ['@pix3/runtime', 'three', ...dist/optimize-deps.json]` (OrbitControls, TransformControls, GLTFLoader и всё, что найдёт сборка). По S1 без `include` reload'а нет, но подпути отдаются сырыми исходниками; `include` нужен для пре-бандла тяжёлых подпутей;
- `optimizeDeps.exclude: ['@pix3/editor-core']`.

`editor-core/dist`:
- externals — `@pix3/runtime`, `three`, `three/*`, `postprocessing`, `virtual:pix3/*`;
- **Spine — только через `virtual:pix3/spine-loader`** (`this.resolve` → загрузчик или `null`): S1 показал, что литеральный `import()` отсутствующего optional peer убивает модуль целиком;
- `postprocessing` и `lit` ставит шаблон.

**Скрипты.** `virtual:pix3/editor-scripts` — eager `import.meta.glob` по `scripts`, `src/scripts` без `*.spec.ts`/`*.test.ts`/`*.d.ts`, экспортирует `__pix3Revision`. `transform` дописывает **каждому скрипту** штамп исполненного содержимого:

```js
(globalThis.__pix3Executed ??= {})[path] = sha
```

Только этот штамп доказывает исполнение вложенных модулей: `__pix3Hashes` корня — нет (S1, негативный контроль). Bot-политики (`GameBotHost.ts:43,88`) — `virtual:pix3/bot-policies` по `design/tests/bots/**`, с тем же штампом.

**Ловушка `full-reload` и выбор.** Тупиковая цепочка любой вкладки шлёт `full-reload` всем, включая редактор (у DeepCore `main.ts → register-project-scripts.ts → scripts/*`).
- **(Б) — по умолчанию.** Страница редактора отдаётся сырым HTML без `transformIndexHtml`, модули запрашиваются у Vite напрямую, события идут через свой WS `httpServer` `upgrade` `/__pix3/ws`. S1: ~60 строк + `ws`, на 7 и 8, обычная правка доходит за 26–28 мс, контрпример барьера проходит. Ни `full-reload`, ни reload после реконнекта до редактора не доходят. Тупик игры даёт `page reload` только вкладке `/`.
  - **Контракт Б.** В цепочке редактора нет `import.meta.hot`, CSS-импортов и **нелитеральных `import()`**: Vite оборачивает их в `injectQuery` из `/@vite/client` (S1, находка 3). Литеральные `import('./chunk.js')` безопасны. `check` предупреждает о трёх случаях в скриптах; страница при загрузке проверяет, что `/@vite/client` нет среди ресурсов.
- **(А) — fallback**, если контракт Б окажется неудобен. `transformIndexHtml`, самопринимающий `editor-scripts`; плагин дописывает в entry-модули `index.html` `import.meta.hot?.accept(() => location.reload())` (S1: `hmr update` вместо `page reload`, и для DeepCore). Остаточный риск А — reload после реконнекта WS — закрывается черновиком C.1.

**Удаляется:** `ScriptCompilerService`, `ProjectDiagnosticsService`, `MonacoIntelliSenseService`, `CodeDocumentService`, `ui/code-editor`; `ProjectScriptLoaderService` 944 → ~200; `runtime-import-map.ts`, `lazy-rapier.ts`, `__PIX3_RAPIER_EXPORT_KEYS__`, `vite-plugin-wasm`, esbuild.wasm (12 МБ).

### B.3 Sync-барьер и play

`pix3_sync` (страница) и `POST /__pix3/api/flush` (CLI, через WS к подключённым вкладкам) → **0. Flush**: редактор записывает грязные сцены (C.2). Если идёт жест, flush ждёт pointerup до `timeoutMs`, иначе `{ok:false, reason:'gesture_in_progress'}`. **Не-ok ответ барьером не является**: при `gesture_in_progress` и `stale_modules` агент повторяет; при `expectMismatch` перечитывает несовпавшие файлы (их изменил дизайнер или другой писатель), согласует свою правку, пересчитывает `expect` и делает новый sync; при `stale` из-за play — правило ниже.

Затем `POST /__pix3/api/sync {expect?: {path: sha}}` — механизм, как его нашёл S1:
1. **Rescan** — stat + sha отслеживаемого набора (B.1), кэш по mtime+size, `rev++`, add/delete учитываются.
2. **Hard-инвалидация корня** — `graph.invalidateModule(root, new Set(), ts, true, false)`. Vite ≥5.1 soft-инвалидирует статических импортёров и отдал бы кэш корня со старым `rev`.
3. **Распространение** — для каждого изменённого файла `server.environments.client.reloadModule(mod)` по узлам **графа окружения** (`environment.moduleGraph.getModulesByFile`). Не по mixed-узлам `ctx.modules`: на Vite 8 они не штампуют цепочку. Не через `server.reloadModule`: он помечен future-deprecated. При add/delete — `reloadModule(корня)`. Позднее событие watcher'а с тем же sha гасится в `handleHotUpdate`.
4. **Подтверждение страницы.** Вкладка реимпортирует корень с `?t=<13-значный timestamp>`: Vite вырезает только `t=\d{13}`, иначе 404. Ack несёт `rev` и `__pix3Executed`. Sync отвечает ok, только если `rev ≥` ожидаемого **и** для каждого изменённого скрипта исполненный штамп равен sha на диске; иначе `{ok:false, reason:'stale_modules', paths}`.

Ответ — `{rev, seq, changed:{path: sha}, expectMismatch[]}`, сцены из `changed` перезагружены. Замер S1: 13–26 мс. Негативный контроль (только `onFileChange`) воспроизводит устаревший `leaf` и даёт `stale_modules`.

**Во время play** внешние изменения откладываются (`ExternalChangeService.ts:336-339`), и это остаётся. Повтор sync здесь ничего не меняет, поэтому ответ указывает, **чья** сессия. Владелец хранится **в состоянии страницы**, не в CDP-подключении: при старте play записываются `playOwner: 'agent' | 'designer'` (`designer` — только старт из UI) и `startedAt`, так что новый тред Codex управляет сессией агента. Эвристики по бездействию нет.
- `{ok:false, reason:'stale', playing:'agent', pending}` — агент делает `pix3_play restart` (stop → применить отложенное → start) или `stop`, затем снова sync;
- `{ok:false, reason:'stale', playing:'designer', pending}` — play дизайнера агент **не останавливает**: ждёт и опрашивает или спрашивает пользователя.

Любое подключение агента может остановить или перезапустить сессию с `playOwner:'agent'`; `pix3_play {action:'stop', force:true}` для `designer` отклоняется.

### B.4 Play в фазе 1

**In-page.** `GamePlaySessionService.startRuntime` (`:566-680`) строит `SceneRunner` на `SceneManager` редактора. game-test работает через `getActiveRuntime()` (`:366`).
- Убираются `NetworkService` (`:197`, `:600-604`) и `ProfilerSessionService`; popout остаётся.
- iframe `/` ломает game-test (другой `window`), Peek-sink, превью локали и атлас. В фазе 1 есть только кнопка «Открыть игру».

### B.5 Player и шаблон

`@pix3/vite-plugin/player` — перенесённый `runtime/src/main.ts` (116 строк), экспортирует `startGame(selector)`.
- Dev: `embedded-assets={}`, `ResourceManager('/')`; `scene-manifest` из `pix3project.yaml`.
- Глобал `window.__PIX3_PLAYER__ = {status, frames, errors}`.

**Шаблон:**
- `package.json`: зависимости `@pix3/runtime`, `three ~0.183`, `postprocessing`, `lit`; dev — `vite ^8`, `@pix3/vite-plugin`, `@pix3/cli`, `typescript`;
- `vite.config.ts` с `pix3()`, `index.html`, `src/main.ts` (3 строки), `tsconfig.json`;
- плоские `scenes/`, `sprites/`, `scripts/`, `audio/`, `design/`.

### B.6 Сборка

`build: 'html'`:
1. `buildStart` сканирует **все текстовые исходники проекта** вне `node_modules`, `dist`, `.pix3`: сцены, префабы, скрипты и `src/**` (DeepCore импортирует узлы runtime из `src/`). Результат — `mentionedNames`, ассеты, использование spine/postprocessing/network. Это Node-порт `ProjectBuildService.collectAssetPaths`/`scanMentionedNames`.
2. `load`-хук подменяет не упомянутые модули `…/@pix3/runtime/src/<path>.ts` из таблицы `strippable-runtime-modules.ts` (354, едет со spec'ом графа импортов) стабом `buildStrippedModuleSource`.

   **Зависимости вне скана** (N11: barrel-импорт `import { GeometryMesh } from '@pix3/runtime'` идёт через `index.ts`, и importer стаба внутренний). Пакеты из `node_modules` с `@pix3/runtime` в deps/peerDeps разбираются `this.parse`, их именованные импорты добавляются в `mentionedNames`. `import * as`, динамический импорт или ошибка разбора выключают strip с подсказкой `pix3({ strip: { keep } })`; страховка — `transform`-хук. 1 день, P2. В P1 strip включён, только если ни одна зависимость не объявляет runtime; `strip: false` — для чужих entry.
3. Virtual spine/postprocessing/network импортируются **статически**.
4. **Сцены как документы при сборке — P2 (3 дня), можно отложить за P4.** Сейчас player читает сцену текстом (`SceneRunner.ts:444-448` → `parseScene`), префабы тоже, а `SceneLoader.ts:1,302` статически импортирует `yaml`, поэтому `load`-хук на файлы сцен ничего не даёт (`.pix3anim` уже `JSON.parse`, `AssetLoader.ts:380`). Путь:
   - `SceneLoader` → `parseSceneText(text) → SavedSceneDocument` (отдельный модуль с `yaml`) + `buildGraph(document)`; `parseScene` остаётся обёрткой (аддитивно);
   - `virtual:pix3/scene-documents` — JSON-документы для entry, целей `changeScene` и вложенных префабов; `SceneManager` берёт документ из map;
   - `parseSceneText` стабится, когда сборка поставляет документы.

   Гейт: в bundle нет `yaml`; грузятся entry, `changeScene` и вложенный префаб; в отчёте «yaml: −N KiB». Выигрыш <15 KiB gzip → за P4.
5. Single-file:
   - P1 — `vite-plugin-singlefile` (2.3.3, peer `vite ^5…^8`) + порт DeepCore `classicScriptCompatibilityPlugin`;
   - P2 — `compress` (порт `renderCompressedHtmlDocument`, `PlayableHtmlBuildService.ts:1054`) и `dist/<name>.report.json`.

**Остальные форматы.**
- `zip` — без встраивания, архив `fflate`.
- **Экспорт «npm-проект» не делается:** проект и так npm-проект. Подтверждение владельца — в H.
- WebP-перекодирование (сейчас canvas, `:825`) — только optional `sharp`, P2+.

**Из UI:** `POST /__pix3/api/build` → flush редактора → `process.execPath node_modules/vite/bin/vite.js build` (не `vite.cmd`: на Windows это EINVAL) → прогресс `pix3:build`. **`npm run build`, `pix3 check`, `pix3 smoke`:** если `.pix3/dev.json` указывает на живой dev-сервер с редактором, сначала `POST /__pix3/api/flush` (до 15 с, иначе `E_EDITOR_UNSYNCED`; `--no-sync` пропускает). В CI без редактора — сборка с диска.

**Проверка артефакта:** `vite preview` во вкладке CDP (`__PIX3_PLAYER__.frames>0`, ошибок нет), `file://` и `<iframe sandbox="allow-scripts">` (opaque origin, как рекламный контейнер; харнес `/__pix3/verify`).

Из `PlayableHtmlBuildService.ts` (1 246) выживает ~350 строк. `?raw`-globs и `export-vendor` исчезают: из-за них нынешняя сборка редактора весит **112 МБ** (W). Spine-утечка закрыта.

## C. Файлы — истина в каждой точке синхронизации; память — ограниченная транзакция

### C.0 Формат сцен: решение

В 2.0 YAML остаётся форматом авторинга. Причины:
- в полевом тесте агенты писали валидный YAML с первой попытки 9 раз из 9 (`external-agent-authoring.md` §11);
- комментарии в шапках сцен шаблонов работают как онбординг;
- агенты читают сцены через `pix3 tree`.

**JSON отклонён:** теряет комментарии, ~30 % лишних токенов; JSONC — 1–2 недели миграции без измеренной выгоды.

**TSX/JSX отклонён.** Сцена стала бы кодом: правку инспектора для не-литерала некуда записать, и теряется «данность» (валидация без исполнения, стабильные id, `tree`, хеши для sync, диффы).

**Правило пересмотра.** Контракт формата — `SavedSceneDocument` (`SceneSaver.ts:45,68`), а не живой `SceneGraph` из `parseScene`; `SceneDocument` загрузчика сводится к нему в B.6.4. `.pix3scene.json` появляется, только если `.pix3/gaps.jsonl` покажет боль с YAML на примерах; дешёвый путь — JSONC через `jsonc-parser.modify`. `modify` тоже адресует массивы по индексу, поэтому слой «id узла → узел документа» из `ScenePatchWriter` нужен в любом формате: JSONC меняет только нижний слой записи.

### C.1 Модель правки

Решение владельца после rev 3: **in-memory история + отложенная запись (write-behind)**.

- **История в памяти остаётся как сейчас.** `HistoryManager` (202) и `OperationService` (628) не меняются, кроме удаления `Y.UndoManager`. Coalesce тоже остаётся. Ctrl+Z / Ctrl+Shift+Z — существующие undo/redo.
- Журнал версий в плагине нужен только для History → «Восстановить версию».
- N1 и N3 (ревью 2) закрыты по построению.

**Несохранённое — это дельта состояния, а не операции** (ревью 3, N8). Записи истории хранят замыкания (`HistoryManager.ts:11-18`), undo переносит запись в redo без новой операции (`:109-119`), coalesce заменяет запись (`:96-104`). Поэтому список «операций после flush» не определён. Пример: flush `x=1`, Ctrl+Z → `x=0`; агент переименовывает узел — повторять нечего.

Определение: `pending = diff(baseline.norm, norm(graph))` по id узла и ключевому пути. Дельта вычисляется в момент flush или reload, учитывает perform/undo/redo/coalesce автоматически и никакого учёта операций не требует.

**Когда пишется диск** (`FlushService`, ~350 строк вместо `AutosaveService`):

| Повод | Правило |
|---|---|
| (а) простой | 1,5 с после последней завершённой операции |
| (а′) верхняя граница | не позже 10 с от первой несохранённой правки при непрерывной работе |
| (б) Ctrl+S | немедленно |
| (в) play и build | перед стартом, включая `npm run build`/`check`/`smoke` из терминала (B.6) |
| (г) агент | `pix3_sync` сначала делает flush (B.3) |
| во время жеста | **никогда**; (а′) ждёт pointerup |

**Черновик.** `sessionStorage` не переживает закрытие окна (MDN), поэтому черновик пишется в **IndexedDB**: ключ `{projectId, scenePath, baseline.sha}`, содержимое — текст `patch(baseline.ast, pending)`.
- Checkpoint — каждые 2 с, пока сцена грязная, плюс на `pagehide`/`visibilitychange`.
- При открытии черновик предлагается, только если `sha` диска = `baseline.sha` черновика; иначе он уходит в журнал как `rejected-draft` с тостом.
- Гарантия — только **восстановление последней подтверждённой (`transaction.oncomplete`) ревизии checkpoint'а**. 2 с — целевой интервал, а не обещание: транзакция в полёте может быть прервана при завершении браузера (MDN, «Warning about browser shutdown»).

Черновик — копия для восстановления, а не документ.

**Индикатор «грязно»** — `pending` не пуст или flush в полёте.

### C.2 Flush = один патч от baseline

**Подтверждено S12** (`pix3-core-spikes/reports/pix3-core-p0-s12.md`): 378/390 случаев. Все 12 провалов — многоключевые действия saver'а, а не writer'а.

**Baseline** — последний подтверждённый документ диска `{sha, text, ast, norm: SavedSceneDocument}`. Обновляется при load, reload и **только успешном** flush. Если внешне изменился префаб, baseline всех сцен с его экземплярами пересчитывается: база override снимается при загрузке.

**`norm(text)`** = `serializeSceneDocument(parseScene(text))` в режиме `pix3 validate` (N2: `Group2D.width` 30/30). Натуральный размер текстур `norm` получает **из заголовка картинки на диске** (PNG/JPEG/WebP/SVG, без декодирования) в редакторе, CLI и плагине одинаково. Иначе у `Sprite2D` без `width`/`height` появляются ложные ключи `pending` (S12 §4.2). Ту же проверку проходят `AnimatedSprite2D`, `Sprite3D` и UI с автоподгонкой. Стоимость: шаблоны 0,6–13 мс, DeepCore `main-scene` 67 мс; после flush `baseline.norm := snapshot.norm` без разбора.

**Flush** (`ScenePatchWriter`, ~900 строк + ~400 строк тестов, 3,5 дня — подтверждено):
1. **снимок** `{revision: nodeDataChangeSignal, text, norm: norm(graph), pendingCutoff}` — неизменяемый;
2. diff `baseline.norm → snapshot.norm` по **id узла** (индекс `id → YAMLMap` по `root`/`children`, без индексов массивов) накладывается **сплайсами исходного текста**. AST используется только для поиска диапазонов и стиля кавычек: `Document.toString()` меняет 17–36 из 36 файлов без единой правки. Текст разбирается один раз, сплайсы идут с конца файла. Перенос узла несёт с собой его комментарии. Векторы override (`{x, y}`) — атомарные листья;
3. запись с `If-Match = baseline.sha`;
4. успех → `baseline := снимок`. Сцена становится чистой, **только если** `nodeDataChangeSignal` не изменился (перенос `SaveSceneOperation.ts:103-105,175-178`). Правки после cutoff остаются в `pending`.

**Fallback на полную сериализацию с предупреждением** — якоря и алиасы, непустые flow-`children`; kit запрещает якоря в сценах.

**Исправления saver'а** (+1–1,5 дня, G.2):
- идемпотентность `save(load(save(x)))` — 13 из 34 файлов нестабильны вокруг `transform`;
- многоключевые переключатели инспектора (`layoutEnabled`, `flowEnabled`) материализуют целые блоки и переписывают override экземпляров;
- размер из заголовка картинки.

Значения, производные от раскладки (stretch-размеры, позиции во flow), пока принимаются как многострочный flush (S12 §4.1б, после MVP). Префаб + сцена — один changeset (C.4). Ответ 412 → C.3, затем повтор flush.

### C.3 Внешняя версия: слияние дельты

**Чистая сцена** — `ReloadSceneCommand` как сегодня: граф заменяется (`ReloadSceneOperation.ts:191-199`), выделение по id сохраняется (`:151-164`), история очищается (`ReloadSceneCommand.ts:61`), изменённые узлы подсвечиваются 3 с.

**Грязная сцена** — база B, внешняя версия E, `pending = diff(B.norm, norm(graph))`:
1. Текущее состояние редактора пишется в журнал как `rejected-draft`: ничего не теряется.
2. Для каждого ключа `pending`:
   - `norm(E)[k] == B.norm[k]` → ключ **принят**;
   - иначе → **отброшен**, агент менял то же;
   - структурная дельта (узел добавлен, удалён, перемещён) отбрасывается при любой внешней версии (N5);
   - ключ узла, которого нет в E, отбрасывается.
3. `merged = patch(E.ast, принятые ключи)` → граф строится из `merged`, `baseline := E`. Принятые ключи становятся новым `pending`, затем обычный flush.
4. **История очищается полностью** (замыкания ссылаются на старые узлы); синтетической записи нет — undo с подменой графа уже убран (`ReloadSceneOperation.ts:193-197`). Откат принятых ключей — History «Восстановить версию».
5. Тост перечисляет отброшенные ключи.

**Затирание по устаревшему чтению.** Если E возвращает ключи последнего flush к значениям до него, — тост «Агент перезаписал вашу правку X [Вернуть]». Правило kit: начинать с успешного `pix3_sync`. Это регрессия относительно protected set: ловится только последний flush.

**Две вкладки — Web Locks** (~50 строк). `navigator.locks.request('pix3:write:<projectId>')`: первая вкладка — писатель, остальные read-only с баннером и кнопкой «Перехватить управление». Писатель держит блокировку в долгоживущем callback'е `request()`. **Авторитет — сервер, блокировка — сигнал UI.** У каждой вкладки есть `writerId`. Путь записи плагина (тот же mutex C.4) принимает changeset только от текущего писателя; остальным — `409 writer_superseded` независимо от `If-Match`. Первая вкладка делает claim при загрузке.

Передача A → B:
1. B: `request(…, {steal:true})`. Promise у A отклоняется с `AbortError` (callback не отменяется, `signal` отменяет только свой запрос). В `.catch` A перестаёт планировать flush, становится read-only, тост.
2. B: `POST /__pix3/api/handover/claim {writerId}`. Claim обрабатывается **под тем же mutex**, что и записи: уже принятый changeset A завершается первым. Затем сервер переключает писателя на B и возвращает `{seq, hashes}` получившегося диска.
3. Changeset A, пришедший после переключения, получает `writer_superseded`: A сообщает об этом и журналирует содержимое как `rejected-draft`.
4. B до ответа на claim — read-only; после ответа перечитывает baseline из возвращённого состояния и включает запись.

Клиентских таймаутов нет: упавшая A просто больше не пишет, её незавершённый changeset разбирает C.4. `BroadcastChannel` — только UX; `If-Match` — страховка для другого браузера.

**Смерть dev-сервера:** баннер, правки продолжаются в памяти и в IndexedDB-черновике. После `npm run editor` — flush (или предложение черновика, если страница перезагрузилась).

### C.4 Changeset: staging и восстановление

`temp+rename` в `workspace-server.ts:1239-1282` атомарен только для одного файла. Для многофайлового flush:
1. все записи плагина сериализуются mutex'ом;
2. preflight `If-Match` всех файлов;
3. staging: новые содержимые → `.pix3/tx/<id>/`, старые → `old/`, `intent.json {files, state:'prepared'}` с fsync;
4. rename по очереди → `state:'committed'` → уборка;
5. одно групповое событие `pix3:fs {changeset, files}`.

**Восстановление при старте плагина.** `prepared` с полным staging — roll-forward, иначе rollback из `old/`; запись в журнал.

**Граница.** Защищены только записи через плагин. Агент, пишущий напрямую, может прочитать промежуточное состояние между rename.

**Журнал** (Node-порт `RecoveryJournalService.ts`):
- хранилище `.pix3/history/<path>/<stamp>-<hash8>`, `index.jsonl`, 200 версий / 7 дней;
- авторы `editor|external|restore|rejected-draft`;
- только для панели History (вырастает из `pix3-recovery-menu.ts`).

### C.5 Что остаётся от машинерии

- **KEEP:** `HistoryManager` (202), `OperationService` (628, без `Y.UndoManager`), `features/history`; из `external-merge/` — `scene-doc`, `value-equality`, `hash`; из `workspace/` — `WorkspaceClient`, `workspace-protocol`.
- **Переделка:** `AutosaveService` (413) → `FlushService` ~350 + черновик ~150; `ExternalChangeService` (475) → ~250; `RecoveryJournalService` (294) → плагин ~220 + changeset-tx ~250; `WorkspaceSessionService` → ~150; `AgentKeepaliveService` → ~60; `SceneDiskStateService` поглощается baseline.
- **DROP:** `ProtectedSetService` (baseline → `FlushService`), `ExternalMergeService` (кроме `restoreVersion`/`listVersions`), `ProjectOwnership`, `Ack`, `MergeLog`, остальное `external-merge/` и `workspace/`, IndexedDB-fallback журнала.

## D. Транспорт агента: Chrome DevTools MCP

### D.1 Транспорт: 3p-инструменты страницы

Проверено по tarball `chrome-devtools-mcp@1.10.1` (последняя версия):
- у `evaluate_script` есть `function`, `args` (uid элементов), `filePath`, `dialogAction`, `waitForStableDom`; **`sourcePath` нет**;
- с `--categoryExperimentalThirdParty=true` доступны `list_3p_developer_tools` / `execute_3p_developer_tool {toolName, params: JSON-строка}`;
- страница отвечает на событие `devtoolstooldiscovery` через `event.respondWith({name, description, tools:[{name, description, inputSchema, execute}]})` (`McpPage.js:219-305`);
- параметры проверяются ajv по `inputSchema`;
- это два обычных статических MCP-инструмента. Инструменты страницы в MCP `tools/list` не попадают: их список агент получает вызовом `list_3p_developer_tools`. После перезагрузки страницы `window.__dtmcp` пропадает, поэтому kit вызывает `list_3p_developer_tools` **в начале каждого треда, после каждого `select_page` и после любой перезагрузки**: W показал, что без вызова в том же процессе MCP `execute_3p_developer_tool` отвечает «Tool … not found». 3p-инструменты требуют `pageId` из `list_pages`; кривой JSON или тип дают понятные ошибки JSON.parse/ajv;
- `params` — JSON-**строка**, которую `execute_3p_developer_tool` разбирает `JSON.parse` (`thirdPartyDeveloper.js:50`): модель экранирует JSON внутри строки. **S4: 0 ошибок экранирования на 55 вызовах** (Codex, gpt-6-astra) — порог 5 % не задет, 3p остаётся основным путём.

**Решение.** `__PIX3_DEBUG__` v1 регистрирует группу `pix3`:

| Инструмент | Что делает |
|---|---|
| `pix3_status` | версии, проект, активная сцена, `scriptsStatus`, число ошибок |
| `pix3_sync` | flush правок редактора → rescan → барьер (B.3), `{expect?, timeoutMs}`. Гарантия: диск отражает состояние редактора **на момент успешного sync**; последующие гонки обслуживает C.3. Дизайнеру не нужно помнить о сохранении |
| `pix3_scene` | `{path?, maxDepth, nodeId?, find?}` → DTO |
| `pix3_play` | `{action: start\|stop\|restart\|pause\|status, scenePath?, force?}`; `status` возвращает `playOwner` и `startedAt` из состояния страницы; `stop`/`restart` — для любой `agent`-сессии, для `designer` отклоняется даже с `force` (B.3) |
| `pix3_game_run` | `GameTestService.run(spec)`; `game.input` и `observe` — внутри spec |
| `pix3_screenshot` | `{target: game\|viewport}` — подготовить вид; снимок — штатный `take_screenshot`, **никогда** base64 в ответе 3p |
| `pix3_build` | `{format, compress, entryScene}` → `{path, bytes, sha}` |
| `pix3_errors` | `{clear?}` |

Тот же объект доступен как `window.__PIX3_DEBUG__.*` для `evaluate_script`.

**Fallback (флаг убрали или сломали).** S4: inline прошёл те же сценарии, 95 % с первой попытки и 0 ошибок JS, но склеивает несколько тулов в один `evaluate_script` (отказ одного валит вызов) и на многоходовом сценарии дороже: +73 % времени, +35 % токенов. Kit содержит **inline-тела** `function`, например `async () => await window.__PIX3_DEBUG__.sync({timeoutMs:15000})`, всегда с `waitForStableDom:false` (иначе до 3 с ожидания, `WaitForHelper.js:71`) и `pageId`.

**Риск экспериментального флага.** Категория может быть переименована или удалена в любом минорном релизе. Поэтому:
- версия закреплена (`chrome-devtools-mcp@1.10.1`), обновление только после прогона S4;
- fallback inline-JS работает на любой версии.

**Таймауты.** Codex `tool_timeout_sec = 300` для `pix3-browser` (по умолчанию 60; `game_run` и `build` дольше). `startup_timeout_ms = 20000`.

**Из `debug-bridge.ts` (1 286) удаляется:** `agent.*`, `tools.execute`, `eval.run`, `assetGen.*`, `model3d.*`, `scene3d.*`, `project.*`, `setProperty`, `command`, `imageStats`. Мутации — только файлами. Остаётся ~600 строк. **Отказ всегда с причиной** `{ok:false, reason, detail}` (`not_owner`, `unknown_property`, `invalid_value`, …): сегодня `setProperty` возвращает голый `false` и для неизвестного пути, и для окна-не-владельца (W), а `play_restart` — голый `{ok:false}` (S4, в обоих вариантах транспорта).

### D.2 Свой MCP — решение

**Не поставляется.** Триггер (S4 или C1): <90 % вызовов проходят с первой попытки **и** при 3p, и при inline. Тогда в P2 (2 дня) — `pix3 mcp`, stdio-процесс и только CDP-клиент с теми же 8 инструментами.

### D.3 Поиск вкладки

1. `.pix3/dev.json` → `editorUrl`.
2. `list_pages` → префикс URL → `select_page` → `list_3p_developer_tools`.
3. Если вкладки нет — `npm run editor`.

### D.4 Запуск и keepalive

`pix3 editor` (npm-скрипт `editor`):
1. **Dev-сервер.** Живой сервер из `dev.json` переиспользуется; иначе запускается `process.execPath node_modules/vite/bin/vite.js` **отсоединённо** с логом `.pix3/dev.log` и ожиданием `dev.json` ≤15 с. `--stop` останавливает.
2. **Chrome.**
   - Повторный запуск Chrome с тем же `--user-data-dir` и `--app=<url>` открывает app-окно в уже работающем процессе. `PUT /json/new` открыл бы обычное окно с адресной строкой.
   - Флаги:
     ```
     --app=<url> --user-data-dir=<profile> --remote-debugging-port=9333
     --no-first-run --no-default-browser-check
     --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows
     ```
   - macOS: `open -na "Google Chrome" --args …` (выводит из-под seatbelt). Профиль `~/.pix3/chrome`, иначе `$TMPDIR/pix3-chrome` (S3); Chrome ≥136 требует отдельный профиль.
   - **Проверка 9333.** Перед запуском `GET /json/version`, затем проверка, что это наш профиль: в `/json/list` есть страница-маркер `/__pix3/` или `--user-data-dir` процесса совпадает. Чужой или мёртвый процесс на 9333 → пробуются 9334–9339, `agent-setup --repair` переписывает `--browserUrl` в MCP-конфиге, печатается диагностика «9333 занят процессом X; используем 9335. Запущенный Codex держит старый `--browserUrl` — перезапустите Codex или начните новый тред».
   - **Несколько проектов — не коллизия.** Все они делят один профиль и один порт: второй проект открывается новым app-окном (повторный `--app`) в том же Chrome, а D.3 различает проекты по порту Vite в URL.
3. При `SSH_CONNECTION` Chrome не запускается (E.3).

**Keepalive остаётся:** `isDocumentActive = visible && hasFocus` (`page-activity.ts:16-20`) ставит редактор на паузу, как только дизайнер ушёл в Codex, а флаги Chrome этого не меняют. Сохраняются `page-activity`, `BackgroundTicker` и ~60 строк `AgentKeepaliveService`: вызов моста держит keepalive 60 с, play агента — до stop.

### D.5 Безопасность — прокси обязателен

**Без прокси** 9333 слушает только loopback; web-страницы не подключатся (проверка Host, WS без `--remote-allow-origins`), любой локальный процесс пользователя — подключится. Профиль пустой, ключей в нём нет (B.1).

**Прокси (P2, 1,5 дня, безусловно):** `pix3 editor` владеет Chrome через `--remote-debugging-pipe` и выставляет `ws://127.0.0.1:9333/pix3` с `Authorization: Bearer`; MCP — `--wsEndpoint` + `--wsHeaders`; CDP id ремапятся; токен в `~/.pix3/cdp-token` (0600), в конфиг его пишет `agent-setup`. **Обязателен** до любого stranger-теста на корпоративном ноутбуке и для Remote SSH (`RemoteForward` слушает loopback удалённого хоста, доступный всем его пользователям: это полный CDP к локальному Chrome, включая `file://`). Dogfood Igor'я до P2 — только локально; позиция ИБ MY.GAMES — в S6.

### D.6 Разовая настройка

`pix3 agent-setup [codex|claude]` запускает агент: AGENTS.md говорит «нет `pix3-browser` → запусти и попроси новый тред».
- **Codex:** таблица `[mcp_servers.pix3-browser]` — `npx -y chrome-devtools-mcp@1.10.1 --categoryExperimentalThirdParty=true --browserUrl=…` (после P2 — `--wsEndpoint`/`--wsHeaders`), на Windows `cmd /c`, таймауты D.1; таблица заменяется целиком, бэкап, проверка `codex mcp list`.
- **Claude:** `claude mcp add --scope user pix3-browser -- …`. Песочницу Codex не трогаем молча — печатаем инструкцию.

## E. Поток пользователя

### E.1 Дизайнер в Codex desktop, без терминала

1. **Онбординг** — одна фраза из вики MY.GAMES: «Сделай игру про X на Pix3: `npm create pix3@latest x-game -- --template recipe-tapper-2d --yes`, прочитай `x-game/AGENTS.md` и следуй ему». Для пустой папки треда — `create-pix3 .`.
2. Агент: `npm install`, `npm run editor` (одобрения песочницы — заранее в онбординге, S3) → app-окно с `entryScene`. Нет `pix3-browser` → `npx pix3 agent-setup codex` и новый тред (раз на машину).
3. **Цикл** (ревью 3, N10):
   1. **успешный** `pix3_sync`, затем свежее чтение файлов;
   2. правки YAML/TS;
   3. `pix3_sync`;
   4. `npm run check` → `pix3_play restart` / `pix3_game_run` → `pix3_errors` → `pix3_screenshot`.

   Не-ok sync — не барьер: повторить; при `expectMismatch` — перечитать несовпавшие файлы, согласовать, пересчитать `expect`, новый sync; при `playing:'agent'` — restart своего play и снова sync; при `playing:'designer'` — ждать или спросить пользователя. Правки дизайнера уходят на диск при простое, по Ctrl+S или по sync.
4. **Playable:** успешный `pix3_sync` → `npm run build` (сам делает flush редактора) → проверка (preview, `file://`, iframe) → `dist/x-game.html`.

### E.2 Инженер в VS Code с Claude Code

`npm run dev` и `…/__pix3/` в любом браузере. CDP — только для проверок агентом (`npm run editor` + `agent-setup claude`). Тесты — vitest и `npm run smoke`.

### E.3 Remote SSH (Igor) — только после прокси

Vite и Claude Code — на удалённой машине, VS Code пробрасывает 5173; локально `pix3 editor --chrome-only`; `RemoteForward 9333` только с токен-прокси (D.5); порт не 1:1 → `PIX3_PUBLIC_URL` в `dev.json`.

## F. Перенос editor-core

### F.1 Каталоги

| Источник | Итог |
|---|---|
| `ui/{viewport,scene-tree,object-inspector,assets,animation-timeline,logs-view,runtime,localization-view}` (~24k) | KEEP. Вырезаются карточки online/preview, collab-presence, `library-inspector`, `LibraryInsertService`, `GeneratedAssetDropService`, `openInSpriteEditor` (`assets-content.ts:576`). `contour-trace.ts` → `core/` |
| `ui/shared` (12,8k) | settings 2 455 → ~700. DROP `create-project-dialog`, `agent-handoff`, `agent-channel-indicator`, `merge-banner` — они блокируют компиляцию. Остальные мёртвые диалоги — после dogfood (F.3) |
| `ui/generate` (2,2k) | только секция картинок, ключи через прокси (B.1) |
| `services/{viewport,scene,assets,animation,atlas,localization,core}` (~23k) | KEEP |
| `services/editor` (3,3k) | без `WorkspaceMode`, `StudioViewportMount`, `UpdateCheck`; `EditorTabService` без `PreviewHostService` (`:20,52,439`) |
| `services/play` (5k) | DROP `OnlineSession`, `PreviewHost`, `RemotePreviewTelemetry`, `ProfilerSession` |
| `services/agent` → `services/game-test` (~15,2k) | MOVE; `GameBotHost` → Vite-политики (B.2) |
| `services/scripting` (3,1k) | KEEP `ScriptCreatorService`, `scene-nodes-dts` |
| `services/export` (3,5k) | Node-части → плагин; в редакторе Export → `host.build` |
| `services/project` (7,7k) | `ProjectService` → ~1 100 (бут из `host.info`); `ProjectStorageService` → ~250. DROP `FileSystemAPI`, `BrowserProjectStorage`, `LocalSync`, `ProjectLifecycle`, `ProjectHome`, `ProjectTemplate`, `FileWatch`; `ProjectSync` → sync |
| `project/{workspace,coauthoring,external-merge,autosave}` | C.5 |
| `services/image-gen` (5,9k) | Gemini/OpenAI через прокси; `image-ops.ts` → `core/` |
| `features/*` (~19,9k) | KEEP `scene`, `properties`, `scripts`, `viewport`, `alignment`, `selection`, `localization`, `animation-timeline`, `peek`, `effects`, `window`. `editor` и `project` — без команд вырезанных областей (Open*, SwitchWorkspaceMode, Connect, InstallAgentKit, ProjectSync, RemotePreview, MoveProjectToFolder, NewProject, BuildProject). DROP `flow`, `uikit`, `library`, `render` |
| `core`, `fw`, `state` | минус `agent-eval`, `dev-backend`, `tool-routes`, `remote-preview/`, `net-kind-paths`, `runtime-import-map`, `lazy-rapier`; срезы state collaboration/auth/workspaceMode/flowAutopilot |
| `LayoutManager` (1 368) | 10 панелей + History |
| `pix3-editor-shell.ts` (2 158) | REWRITE ~800 |
| **спеки** (~150 файлов в портируемых каталогах) | проходящие спеки переносимого поведения **остаются** (команды, inspector, alignment, сериализация, game-test, viewport). Удаляются только тесты вместе с исключёнными функциями. Сломанные из-за окружения — отдельным списком в описании PR порта, с починкой до `alpha.1` |
| не портируется | agent/flow/llm/chat, cloud/collab/library/platform, model-gen, sprite-editor, uikit*, bg-removal, strophe, ao-bake, profiler, home, welcome, auth, `src/player` |

### F.2 Швы

B.2 rev 4 построчно, плюс:
- `features/scene/{SaveAsScene*,SaveAsPrefabCommand,LoadSceneCommand}` → `FileSystemAPIService`: переводятся на `host.files`;
- `SaveSceneOperation` → Autosave / ExternalChange / RecoveryJournal: заменяется на `FlushService.flush`;
- `features/scripts/play-workspace.ts` → `ProjectScriptLoaderService`;
- `GameBotHost.ts:43,88` → `ScriptCompilerService`;
- `atlas/TextureAtlasService.ts:7` → `core/hash.ts`, `core/mime.ts`;
- `main.ts`, `register-runtime-services.ts:3-5`;
- `game-tab.ts:10,283`, `logs-panel.ts:4,110` → «Copy for agent»;
- `pix3-lightbox.ts:9,11`.

**Страж:** `optionalService`/`hasService` тихо деградирует без импорта — спек «после `mountEditor` зарегистрированы сервисы [список]».

### F.3 Отложить до dogfood (не блокирует компиляцию)

Мёртвые диалоги `ui/shared`, лишние провайдеры image-gen, остатки `external-merge` и `services/export`, knip — 1,5 дня в P2.

### F.4 Новый код

~5 500 строк, из них ~1 800 — порт:
- плагин: маршруты, sync, flush-API, WS, virtual, ассеты (~1 500); build (~1 100, порт); журнал и changeset-tx (~550);
- `EditorHost` и загрузка скриптов/ботов (~500);
- `ScenePatchWriter`, нормализация, `FlushService`, слияние дельты, черновик (~1 400; история и undo — существующий код);
- мост v1 с 3p и keepalive (~700);
- CLI (~800) и прокси (~300, P2).

### F.5 Kit

- **Удаляется:** `.mcp.json` с `pix3 mcp`, блок `mcp-tools` (правится `kit.spec.ts`), `pix3-verify`.
- **Добавляется:**
  - (а) skill `pix3-editor`: вкладка, 3p-инструменты, inline-fallback с `waitForStableDom:false`, цикл E.1 «sync → чтение → правка → sync», «не-ok sync = не барьер» с правилами `expectMismatch` и владельца play (B.3), sync перед сборкой, «не переписывай сцену целиком»;
  - (б) справочник `.pix3anim` со стражем по интерфейсам `AnimationResource.ts`;
  - (в) `pix3 character-compile` (`character-compiler.ts`, 342) → `.pix3anim` + префаб `core:CharacterVisual2D`;
  - (г) `verify-and-fix.md`, `game-prototype.md` под CDP;
  - (д) npm-скрипты `dev`, `editor`, `build`, `preview`, `check`, `smoke`.
- **`E_EMOJI_AS_ART` уже есть** (`validate/level1.ts:597-609`). Добавляется тот же страж на текстовых полях инспектора.

## G. Фазы и сроки

### G.1 P0 — статус на 2026-10-08

Код спайков — `pix3-core-spikes/`, отчёты — `pix3-core-spikes/reports/pix3-core-p0-{w,s1,s12,human}.md`; код P1 — в новом репо `pix3-core`, план — в `pix3/.plans`.

| # | Что | Pass | Статус |
|---|---|---|---|
| W | Walking skeleton: плагин отдаёт на `/__pix3/` сборку `pix3-full`; запись — через прокси `/ws/` к дочернему `pix3 serve` (маршруты в плагин **не** портированы, это P1) | правка = байты на диске; Codex её видит | **серверная половина pass**: правка на диске за 1,26 с; «Codex видит» — за человеком (S3/S4). Находки → C.3 (тики вкладок), D.1 (причина отказа), B.6 (112 МБ) |
| S1 | Один экземпляр, reload, барьер; `npm pack`; шаблон + DeepCore-образный; Vite 7.3.7/8.3.3; А/Б; контрпример с задержанным watcher'ом | шесть критериев | **pass по всем шести** во всех ячейках → B.2, B.3; план C не нужен; Б по умолчанию |
| S12 | `ScenePatchWriter` + `norm` на корпусе (36 файлов, 390 случаев) | ≤3 строк на ключ `norm`, комментарии целы, дефолты без ложных ключей | **pass 378/390**; провалы — многоключевые переключатели saver'а → C.2 |
| S4 | CDP-транспорт: 3p против inline-JS, доля ошибок экранирования `params` | ≥90 % с первой попытки, экранирование ≤5 %, время и токены ±20 % | **pass** (2026-10-08, Codex в VS Code на сервере + headless Chrome, 2 сценария × 2 варианта): 3p — 98 % с первой попытки, экранирование 0 %, «not found» 0; inline — 95 %, ошибок JS 0; все 4 прогона PASS. Время/токены ±20 % не сравнимы: сценарии адаптированы под tapper каркаса. 3p основной путь, свой MCP (D.2) не нужен. Находки → B.1 (`esbuild.wasm` от корня), D.1 (`play_restart` без причины), F.5 (старый kit сбивает агента). Отчёт — `pix3-core-p0-human.md` |
| S3 | Песочница Codex (macOS + Windows): listen, Chrome, профиль, выживание, сеть, AGENTS.md подкаталога | всё живёт, одобрений ≤3 | **закрыт владельцем** (2026-10-08), без прогона: E.1 остаётся как есть; при трении на dogfood — `npm run editor` в каждом треде |
| S6 | Не код: Node/Chrome на ноутбуках, npm-прокси, ключ картинок, позиция ИБ по CDP | ответы записаны | **закрыт владельцем** (2026-10-08) |

**Уровень 2** — параллельно с P1:
- S7 — `editor-core` ≤8 МБ в tarball;
- S9 — паритет сборки: tapper **и DeepCore** против `PlayableHtmlBuildService`, +5 %, одинаковые стабы;
- S10 — SSH (после прокси);
- S11 — `smoke`/`check` с typescript проекта.

### G.2 P1 → `2.0.0-alpha.1` (48,5–53,5 дня)

| Работа | Дни |
|---|---|
| Посев, CI, спеки шаблонов, коммит в `pix3-full`, docs/skills/NOTICES | 3 |
| Плагин dev: порт маршрутов `serve/` (в W был прокси, 1,5); sync-барьер по схеме S1 со штампами (B.3), `/api/flush` + flush в `buildStart`/`check`/`smoke`, транзитивный набор, свой WS варианта Б, `dev.json`, гейт, virtual, ассеты, `optimize-deps`, spine-loader (4,5) | 6 |
| Порт editor-core с отложенными тримами (F.3); история и `OperationService` переносятся как есть | 10,5–13,5 |
| Скрипты и bot-политики через Vite | 2 |
| Файлы как истина: `FlushService` — простой, верхняя граница, Ctrl+S, play/build, sync (1,5); черновик IndexedDB (0,5); `ScenePatchWriter` + `norm` + снимок в полёте + идемпотентность (3,5); слияние дельты и затирание (2); Web Locks (0,5); changeset-tx + восстановление (1,5); журнал для History (1); исправления saver'а по S12 (1–1,5) | 11–13 |
| **Гейт записи/undo/sync** (ниже), интеграционные тесты плагина и редактора | 2,5 |
| `create-pix3` + 4 рецепта (`tapper-2d`, `bouncer-2d`, `blank-2d`, `grid-3d`; `arena-2d` после MVP) | 2,5 |
| Мост v1, 3p, inline-fallback, `pix3 editor` с проверкой 9333, `agent-setup --repair`, keepalive | 4,5 |
| Kit: `.pix3anim`, `character-compile`, `kit --migrate`, гейт версий CLI | 2,5 |
| Минимальный build: singlefile, скан всех исходников, strip с защитой importer'ов | 2 |
| Итерации с Codex | 2 |
| **Сумма** | **48,5–53,5** |

**Гейт P1 — до dogfood.** Доказательства независимы от моста:

| Сценарий | Доказательство |
|---|---|
| Drag | ни одного PUT во время drag |
| Простой после drag | ≤2 с → новые координаты в YAML, `git diff` ≤3 строк, комментарии целы |
| Непрерывные правки 15 с | запись не позже чем через 10 с, ни одной во время жеста |
| Esc во время drag | записи нет |
| N10: дизайнер правит, агент сразу делает `pix3_sync` и чтение / `npm run build` | прочитанный файл и артефакт содержат правку |
| N8: flush `x=1` → Ctrl+Z → агент переименовывает узел | на диске `x=0` и новое имя |
| N8: perform → undo до flush → внешняя запись | ничего не воскресло, внешняя правка цела |
| N8: coalesce-ввод по обе стороны flush | итоговое значение верно, Ctrl+Z после — в памяти |
| N8: новая правка при задержанном ответе changeset | после ответа сцена грязная, следующий flush пишет правку; Ctrl+Z верен |
| Внешняя запись: тот же ключ / удалённый узел / структурная дельта | ключ отброшен, тост, `rejected-draft` |
| N2: опущенный дефолт у дизайнера + переименование агентом | обе правки, тоста нет |
| Ctrl+Z после flush | откат в памяти, снова грязно, следующий flush пишет |
| N6: ошибка второго rename / kill между rename | оба файла в old **или** оба в new, одно групповое событие |
| N4: контрпример S1 на реальном проекте | исполненное значение вложенного модуля новое к ответу sync; не-ok при play |
| Правка скрипта при открытой `/` | поле в инспекторе, редактор не перезагружен |
| Закрыть вкладку → открыть новую → первая правка | принята ≤1 с (сейчас 10,2 с из-за аренды, W) |
| Две вкладки, правка во второй | вторая read-only с баннером; ни одного 412; история первой цела; «Перехватить» передаёт запись |
| Changeset A задержан >5 с после preflight, B делает claim | либо A завершён до переключения (baseline B его содержит), либо A получил `writer_superseded`; запись A после первой записи B невозможна |
| A падает посреди changeset'а | восстановление C.4; B делает claim и пишет нормально |
| Sync агента с устаревшим `expect` | `expectMismatch` → перечитывание → новый sync ok |
| N9: закрыть окно после подтверждённого (`oncomplete`) checkpoint'а → `npm run editor` | предложена ревизия этого checkpoint'а и записана; при изменённом диске — `rejected-draft` |
| Play агента → правка файла → sync | `stale, playing:'agent'` → `pix3_play restart` → sync ok, новое значение в живой сцене |
| Play агента → новый тред Codex (новое подключение) → sync | `stale, playing:'agent'`, restart из нового подключения разрешён |
| Play дизайнера → sync | `stale, playing:'designer'`; play не остановлен; `stop` с `force` отклонён |

**Артефакт:** dogfood C1 — Igor, локально, в Codex desktop.

### G.3 P2 → `alpha.2` (18,5–23 дня)

| Работа | Дни |
|---|---|
| Полный build: compress, zip, отчёт, Export UI, `__PIX3_PLAYER__`, проверка preview / `file://` / iframe, матрица Vite 7/8 | 5 |
| Сцены как документы при сборке (B.6.4), можно перенести за P4 | 3 |
| Strip: импорты зависимостей через barrel (N11) | 1 |
| **Токен/pipe-прокси (обязательно)** | 1,5 |
| Браузерный гейт (ниже) | 2,5 |
| Windows/macOS | 1,5–3 |
| Фиксы по C1 | 2–3 |
| Отложенные тримы + knip | 1,5 |
| «Чего не хватает?» → `.pix3/gaps.jsonl` | 0,5 |
| Свой MCP (по триггеру) | 0–2 |
| **Сумма** | **18,5–23** |

**Браузерный гейт P2** — гейт P1 плюс:

| Сценарий | Доказательство |
|---|---|
| Окно свёрнуто → `pix3_game_run` | исход есть, кадров > 0 |
| `npm run build` | preview / `file://` / iframe: `frames>0`, ошибок нет, стабы верны; bundle без `yaml` (если B.6.4 сделан); entry + `changeScene` + вложенный префаб |
| N11: библиотека с обычным `import { GeometryMesh } from '@pix3/runtime'` | `GeometryMesh` не застаблен; с `import * as` strip выключен с сообщением |
| kill dev-сервера | баннер, правки продолжаются, черновик в IndexedDB; после `npm run editor` — flush |
| Вторая вкладка с устаревшим `If-Match` | 412, байты не перезаписаны |
| CDP без токена | соединение отклонено |

### G.4 P3 — MVP MY.GAMES (~10 дней, на `alpha.2`)

**Протокол — D.5 rev 4 без изменений** (`.plans/essential-restructure.md`; при архивации rev 4 текст переносится сюда дословно):
- письменная фиксация протокола и требования по времени;
- C1/C2 делает Igor, C3 — stranger;
- в форме продюсера арт не оценивается, идея отделена от прототипа;
- исходы (а)/(б)/(в) и kill-условия.

**Отличия:**
1. Пробелы — `.pix3/gaps.jsonl` и запросы агента к отсутствующему.
2. **До старта** в протокол как онбординг записываются одобрения песочницы, `agent-setup` и «новый тред». Число одобрений считается отдельно.
3. В (в) отдельно учитываются `npm install` и первый запуск.

### G.5 P4 — решение (1–2 дня)

Успех → `2.0.0` в `latest`, миграция DeepCore, LABS по пробелам. Провал (а) → повтор онбординга; (б) → внутренний инструмент инженеров.

### G.6 Арифметика

**Полный путь:**

| | min | max |
|---|---|---|
Считается **от 2026-10-08**: P0 завершён (W, S1, S12, S4 — pass; S3, S6 — закрыты владельцем).

| | min | max |
|---|---|---|
| P0 | 0 | 0 |
| P1 | 48,5 | 53,5 |
| P2 | 18,5 | 23 |
| P3 | 10 | 10 |
| P4 | 1 | 2 |
| **Итого** | **78** | **88,5** |

- 78–88,5 / 5 = **15,6–17,7 недели**.
- C2 в конце P2 (−3): 75–85,5 = **15–17,1 недели**.
- Плюс B.6.4 за P4 (ещё −3): 72–82,5 = 14,4–16,5 недели.

P0 добавил к P1 +1,5 дня (маршруты не портированы в W) и +1–1,5 (saver по S12); риски плана C и варианта Y сняты (в суммы не входили).


**Кратчайший путь до dogfood `alpha.1` (C1 Igor'я)** — выбор владельца:

| Срез | Экономия, дни |
|---|---|
| Только Vite 8 | −0,5 |
| Внешняя запись в грязную сцену отбрасывает **весь** `pending` (`rejected-draft` + тост), без слияния по ключам | −1 |
| Без проверки затирания | −0,5 |
| Структурные дельты — полной сериализацией (комментарии теряются) | −1 |
| Без генерации картинок и прокси ключей | −1 |
| Один рецепт (tapper) | −1,5 |
| Без `.pix3anim`/`character-compile`/`kit --migrate` | −2 |
| `agent-setup` вручную | −0,5 |
| Без панелей animation-timeline и localization | −1,5 |

Гейт P1, flush по sync/build, черновик и changeset-tx **не режутся**.

**Расчёт:** P1-кратчайший = 48,5–53,5 − 9,5 = 39–44; P0 закрыт. **Итого 39–44 дня (7,8–8,8 недели) до C1.** Срезанное возвращается в P2 (+~9,5 дня).

**Третий вариант — «питч на dogfood» (решает владелец).** Питч MY.GAMES на dogfood-альфе (7,8–8,8 недели): C1 Igor'я, записанное демо, замеры (время до играбельного, токены, размер playable, вмешательства). Stranger-тест и P2 — следующая, профинансированная фаза.
- **Сохраняет:** доказательство формы продукта и адекватности прототипа на одном концепте; реальный playable; честные замеры инструмента.
- **Теряет:** исход (а) — свидетельства самостоятельности дизайнера нет; время только Igor'я (верхняя граница); (б) — на одном концепте вместо трёх; без прокси CDP, полного экспорта и Windows демо возможно только на машине Igor'я.

## H. Риски и открытые вопросы

| Риск | Снятие |
|---|---|
| 9333 занят чужим или мёртвым процессом | проверка `/json/version` и профиля, 9334–9339, `agent-setup --repair`, диагностика (D.4); несколько проектов делят один профиль — не коллизия |
| Ошибки экранирования `params` в 3p | замер в S4; >5 % → inline `evaluate_script` основной путь |
| Две вкладки одного проекта | Web Locks, read-only + «Перехватить»; `If-Match` — страховка |
| Сроки длиннее окна внимания стейкхолдеров (6–8 недель) | вариант «питч на dogfood» (G.6) — решение владельца |
| Порт > 14 дней; Codex-процессы, пауза без фокуса (S3, D.4) | бут + viewport + inspector + commit первыми; тримы F.3 отложены; knip-отчёт до копирования |
| 3p-флаг удалён или переименован | версия закреплена; inline-fallback; WebMCP как преемник; S4 на каждом обновлении |
| Гонка `sync`, устаревшие вложенные модули, два экземпляра runtime | барьер B.3 (`reloadModule` проверен ревью 3 на Vite 7.3.2); S1 на `npm pack` с контрпримером; план C |
| `full-reload`/reconnect-reload | вариант Б; иначе А + черновик IndexedDB |
| YAML-диф, ложные конфликты от дефолтов | S12; `norm` на всех сторонах; гейт P1 |
| Окно потерь write-behind | flush по простою 1,5 с или ≤10 с; checkpoint IndexedDB с целевым интервалом 2 с; гарантия — только последняя подтверждённая ревизия |
| Слияние дельты теряет правку | `rejected-draft` до reload; тост с ключами; гейт N8 |
| Агент читает до flush | цикл «sync → чтение», flush в `buildStart`/`check`/`smoke`; гейт N10 |
| Затирание правки агентом, частичный changeset | C.3, C.4; внешние писатели не защищены — сказано явно |
| Сборка на чужом проекте | скан исходников + разбор импортов зависимостей (N11) + `keep`/`strip:false`; S9 на DeepCore |
| Боль с YAML в MVP | журнал пробелов → миграция на JSONC (~1–2 недели) |

**Открытые вопросы владельцу:**
1. полный путь или кратчайший до C1 (G.6);
2. отказ от экспорта «npm-проект» (B.6);
3. опора на экспериментальный 3p (D.1) — рекомендация: да, с fallback;
4. потеря комментариев, если S12 провалится;
5. имя `pix3-browser`.

## I. Анти-скоуп

1. Никакого чата, LLM-провайдеров и bridge в редакторе.
2. Никакого своего канала, workspace-сервера, lease, pairing, idle-таймаутов, offline-пути и PWA. Отсоединённый Vite из `pix3 editor` — обычный процесс с `--stop`.
3. Никаких FSA/OPFS/cloud — один `EditorHost`.
4. Никаких мутирующих сцену инструментов: сцену меняют файлами.
5. Не ломать публичный API `@pix3/runtime` (B.6.4 только добавляет), не выносить сеть.
6. Никакой in-browser компиляции, Monaco и in-browser экспорта.
7. Никаких «lite»-редакторов. LABS — только после P4.
8. VS Code-хост — не раньше P4.
9. Не переименовывать структуру шаблонов.
10. В `pix3-full` — только security-фиксы.
11. Никакого фреймворка плагинов.
12. Vite 5/6 не поддерживаются.
13. Никаких TSX/JSX-сцен. Выразительность уровня кода для агентов дают генераторы: TS-модуль, который выдаёт данные `.pix3scene`, запускается через CLI (направление ASCII-карт из плана tilemap). Результат редактор правит как данные.

## J. Журнал ревью

«Принято» = решение; подтверждает гейт.

| Ревью | Главное | Итог | Где |
|---|---|---|---|
| 1 (рецензент + координатор) | `sourcePath`, гонка sync, порядок P0, Vite-механика, saver, песочница, keepalive, швы, сборка, SSH, сроки, docs | приняты; lane в S4 — исторические замеры; «npm-проект» — за владельцем | A–G |
| 2 (Codex, 2.1) | N1–N7: drag, представления, undo, барьер, структура, атомарность, `yaml` в player | приняты; N1/N3 закрыты write-behind | B, C |
| Владелец | JSON/TSX-сцены — **отклонено**; write-behind — **принято** | | C |
| 3 (Codex, 4) | N8 дельта, N9 IndexedDB, N10 sync до чтения/сборки, N11 barrel | приняты | B, C, E.1 |
| 4 (Codex, 5) | sync при play; гарантия черновика | приняты | B.3, C.1 |
| 5 (Gemini, 5.1) | 9333, `params`-строка, вариант Б, две вкладки, JSONC, арт, сроки | приняты 9333, порог 5 %, А по умолчанию, Web Locks; сроки — вариант «питч на dogfood»; **отклонены**: механизм `tools/list`, JSONC «из коробки», арт | B.2, C, D, G.6 |
| 6 (Gemini, 5.2) | владелец play, `steal`, сообщение о порте | приняты | B.3, C.3, D |
| 7 (Codex, 5.3) | механизм `steal`, `expectMismatch`, 2 с — цель | приняты, гейты | B.3, C, H |
| 8 (Codex, 5.4) | `steal` и changeset в полёте | принято, заменено в 5.6 | C.3 |
| 9 (Codex, 5.5) | таймаут 5 с пропускает позднюю запись A; упавшая A не подтверждает | принято: серверный `writerId`, claim под mutex записей, `409 writer_superseded`; клиентский таймаут и маркер удалены | C.3, G.2 |
| P0 (спайки) | W: 10,2 с до записи новой вкладки, `false` без причины, 112 МБ. S1: pass, hard-инвалидация, штампы, Б дёшев, `lit`, spine-loader. S12: pass, сплайсы, размер из заголовка, saver. S4: `pageId`, list в начале треда; прогон — 3p 98 %, экранирование 0 % | приняты: Б по умолчанию, план C снят, P1 +2,5–3 дня; 3p основной путь; S3 и S6 закрыты владельцем без прогона; P0 завершён | B, C.2, D.1, G |
