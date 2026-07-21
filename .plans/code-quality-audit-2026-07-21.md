# Аудит качества кода и архитектуры — 2026-07-21

Экономичный проход (knip + точечный grep, без тяжёлого fan-out). Масштаб: `src/` ≈ 146k LOC / 586 файлов, `packages/pix3-runtime/src` ≈ 43k / 176, 94 сервиса, 14 feature-областей.

Разметка: ✅ **уже сделано** · ⚠️ **обсудить** (сложное/спорное) · 🧠 **на Fable** (архитектурная стратегия).

---

## 0. Что уже исправлено (очевидное, безопасное) ✅

Проверено: у каждого — 0 ссылок по имени и 0 импортов по пути; бочка `fw/index.ts` их не реэкспортит; общих `.css` нет.

**Удалены мёртвые файлы (12):**
- `src/fw/engine-api.ts`, `src/fw/from-query.ts`, `src/fw/layout-component-base.ts`
- `src/ui/shared/pix3-background.ts` (+ `.ts.css`)
- `src/ui/shared/pix3-dropdown.ts` (+ `.ts.css`) — жив только `<pix3-dropdown-button>`, сам `<pix3-dropdown>` нигде не вставляется
- `src/ui/viewport/transform-toolbar.ts`
- `src/ui/collab/pix3-share-access-control.ts` (+ `.ts.css`)
- `src/features/scene/CreateAnimationAssetCommand.ts` — команда нигде не регистрируется/импортируется
- `src/features/properties/UpdateAnimationMetadataOperation.ts`

> ⚠️ `engine-api.ts` формально мёртв (IntelliSense/Playable-билд тянут API-типы из `packages/pix3-runtime/src/**` через `import.meta.glob`, а не из `src/fw`). Если это был задел под будущий фасад — вернуть из git. Помнить: в MEMORY.md запись `code-editor-intellisense` упоминает «engine-API types» — но фактический источник рантайм-пакет.

**`package.json`:**
- убрал неиспользуемый dep `y-indexeddb` (0 обращений; `IndexeddbPersistence` не используется)
- убрал неиспользуемый devDep `@eslint/eslintrc`
- добавил незадекларированный `@eslint/js` (реально импортируется в `eslint.config.js`)

**Действие после мержа:** `npm install` (обновить lock) + `npm run build`. Новых tsc-ошибок быть не может — файлы были без входящих рёбер.

---

## 1. Мёртвый код — остаток (нужно решение) ⚠️

Полный вывод: `scratchpad/knip-full.txt`. knip без конфига считает единым проектом `samples/` (скрипты грузятся динамически) и `tools/pix3-agent-bridge/` (отдельный пакет) — их 41 «unused file» это **шум**, не трогать.

**1.1. Бочка `src/services/index.ts` — write-only артефакт.**
**187 из 216** «unused exports» указывают на неё: символы реэкспортятся, но всё приложение импортирует напрямую из модулей, минуя бочку. Это чистый мейнтенанс-долг: каждый новый сервис обязывает править ещё и барель, который никто не читает.
→ **Предложение:** либо удалить бочку целиком (если публичного API-контракта у `src/services` нет), либо свести к явному «public surface» из 5–10 позиций. Требует одного прохода по импортам — низкий риск, но объёмный. 🧠 согласовать политику барелей с Fable (см. §4).

**1.2. Оставшиеся ~29 non-barrel unused exports** — смесь:
- **Ложные (не трогать):** Lit-классы (`SceneTreePanel`, `InspectorPanel`, `AssetsPanel`, `NumberField`, `Vector2Editor`…) — используются как кастом-элементы по тегу, knip их не видит.
- **Реальные кандидаты на `export`→локальный / удаление:** `isMac`/`isWindows`/`isLinux` (`fw/platform.ts`), `transformOf` (`core/agent-introspection.ts`), `easingValueToY` (`ui/animation-timeline/easing-curve.ts`), `escapeRegExp` (`library/library-path-remap.ts`), `THEME_IDS`/`DEFAULT_THEME` (двойной реэкспорт `state/AppState.ts` + `state/index.ts`), телеметрия команд `registerCommandTelemetryHook`/`emitCommandTelemetry`/`resetCommandTelemetryHooks` (`core/command.ts`) — либо фича не достроена, либо тесты выпилены.

**1.3. 371 «unused exported types»** — преимущественно тот же барель + type-only реэкспорты, структурно используемые. Низкий приоритет; чистится заодно с §1.1.

---

## 2. Дублирование ⚠️

**2.1. Пары нод 2D/3D в рантайме** — параллельные иерархии без общего носителя логики:
- `AnimatedSprite2D` (553) / `AnimatedSprite3D` (292) — общий стейт-машина покадровой анимации: `play/stop/pause`, `advance`, `setFrame`, `currentFrame`, `playbackMode`, `playbackDirection`, тайминг кадра. Различие — только материал/носитель текстуры (mesh-quad vs `THREE.Sprite`).
- `Sprite2D` (519) / `Sprite3D` (314) — загрузка/применение текстуры, размеры, pivot.

Оба спека (`AnimatedSprite2D`, `AnimatedSprite3D`) были правлены в текущем рабочем дереве — классический признак «правим в двух местах». 🧠 кандидат на извлечение фреймворк-агностичного `SpriteAnimationController` / миксина (см. §4). Осторожно: 2D-путь обязан гонять текстуры через `configure2DTexture()` (mipmaps off) — общий код не должен это ломать.

> ✅ **Сделано** — извлечён `FrameSequencePlayer` (композиция, не миксин/база). Детали в §10.

**2.2. Проверить точечно (не подтверждено метрикой):** дубли редакторных прокси в `ViewportRenderService` vs рантайм-ноды (редактор рисует отдельные прокси-визуалы — это by design, но паросочетание «нода ⇄ прокси» может содержать копипасту установки материалов/renderOrder).

---

## 3. God-объекты и размер файлов 🧠 (главное для обсуждения)

| Файл | LOC | Симптом |
|---|---|---|
| `services/ViewportRenderService.ts` | **8328** | ~1051 метод-сигнатур. Монолит: рендер-луп, прокси 2D/3D, адорнменты, framing, скриншоты, конфиг текстур, dirty-tracking, превью. |
| `ui/object-inspector/inspector-panel.ts` | 4532 | панель + вся логика раскладки редакторов свойств |
| `ui/animation-timeline/animation-timeline-panel.ts` | 2690 | |
| `ui/animation-editor/animation-panel.ts` | 2419 | сосуществует с timeline-panel — проверить пересечение ответственности |
| `services/agent/AgentToolRegistry.ts` | 2366 | реестр тулов агента — просится разбивка по доменам тулов |
| `ui/assets/asset-tree.ts` | 2199 | |
| `ui/agent-chat/pix3-agent-chat-panel.ts` | 2167 | |
| `ui/sprite-editor/sprite-editor-panel.ts` | 2004 | |

**Приоритет №1 — `ViewportRenderService` (8328).** Декомпозировать по швам, которые уже названы в CLAUDE.md: (a) rAF/dirty-loop, (b) 2D proxy + `assign2DVisualRenderOrder`, (c) 3D proxy, (d) editor adornments, (e) framing/screenshot (`frameNodes`/`captureFramedScreenshot`), (f) texture config. Риск высокий (это горячий путь + on-demand рендер) — нужна стратегия извлечения без регрессий (dirty-marking, порядок 2D-пейнта, `requestRender()` синхронный путь). → передать Fable как отдельную задачу.

**Приоритет №2 — `inspector-panel` (4532):** вынести property-editor-фабрики/layout в отдельные модули, панель оставить оркестратором.

**Проверить дубль ответственности:** `animation-timeline-panel` (2690) vs `animation-panel` (2419) — две крупные панели вокруг анимации; уточнить, не два ли это поколения одной фичи.

---

## 4. Архитектурные вопросы для Fable 🧠

Согласовано с памятью (`route-architecture-to-fable`): дизайн/стратегию — на Fable, механику — на Opus-агентов.

1. **Декомпозиция `ViewportRenderService`** — план извлечения сервисов без регрессий горячего пути (§3).
2. **Политика барелей** (`services/index.ts` + `state/index.ts`): нужен ли публичный surface у `src/services`, или переходим на прямые импорты и удаляем барель (§1.1).
3. **94 сервиса в одном плоском `src/services/`** — есть ли смысл в доменной группировке (agent/, library/, collab/, project/ уже частично есть) и нет ли «сервисов-однодневок». Оценить, какие сервисы правильнее свернуть в feature-Operation'ы (mutation gateway) — сейчас часть логики живёт в сервисах в обход Command→Operation.
4. **2D/3D дедупликация нод** — форма общего носителя (базовый класс vs миксин vs композиция контроллера), с учётом требования `configure2DTexture` и раздельных путей рендера (§2.1).

---

## 5. Оптимизации (кандидаты, требуют замера)

- **`import.meta.glob` в `PlayableHtmlBuildService`** тянет `three/build/**`, `three/examples/jsm/**`, `rapier3d-compat/*`, `yaml/browser/**` как `?raw`. Проверить, что это не раздувает основной бандл (должно быть lazy — подтвердить в `vite build --report`/rollup-visualizer).
- **`@huggingface/transformers` + `@imgly/background-removal`** — тяжёлые. Убедиться, что грузятся только в воркере bg-removal лениво (по памяти — да, но перепроверить split-chunk).
- Bundle-анализ вообще не настроен — стоит добавить `rollup-plugin-visualizer` разово для инвентаризации.

---

## 6. Приоритизированный план

| # | Задача | Риск | Объём | Кто | Статус |
|---|---|---|---|---|---|
| P0 | dead-файлы + `package.json` | низ | — | сделано | ✅ |
| P1 | Прогнать `npm install` + `npm run build`, подтвердить 0 новых ошибок | низ | S | Opus/я | ✅ (`ab0b5ac`, §7) |
| P1 | Настроить `knip.json` (workspaces, исключить `samples/`,`tools/`,`docs/`) — чтобы отчёт стал воспроизводимым и без шума | низ | S | я | ✅ (`ab0b5ac`, §7) |
| P2 | Барель `services/index.ts`: решение + чистка (§1.1) | сред | M | Fable реш. → Opus | ✅ (`3a2c716`, §7) |
| P2 | Микро-dead-exports §1.2 (export→local / delete) | низ | S | Opus | ✅ (`ab0b5ac`, §7) |
| P3 | Дедуп `FrameSequencePlayer` для AnimatedSprite2D/3D (§2.1) | сред | M | Fable дизайн → Opus | ✅ (ветка `refactor/frame-sequence-player`, §10) |
| P3 | Декомпозиция `inspector-panel` (§3 №2) | сред | M | Opus | ⬜ не начато |
| P4 | Декомпозиция `ViewportRenderService` (§3 №1) | **выс** | L | Fable стратегия → поэтапно | ⬜ не начато (safety-net commit0 сделан, §8 Item 1) |
| P4 | Bundle-анализ + вывод по §5 | низ | S | я | ✅ (ветка `perf/bundle-runtime`, §9, смержена) |

**Следующий шаг:** P3 осталось — декомпозиция `inspector-panel` (не требует дизайна от Fable, план §3 №2 достаточен для старта). После неё — P4 (`ViewportRenderService`, стратегия уже готова в §8 Item 1).

---

## 7. Прогресс исполнения (2026-07-21) — ветка `chore/code-quality-audit`

Порядок: от дешёвого к дорогому. Все шаги верифицированы (tsc 0, тесты 1290 pass / 3 pre-existing fail, сборка зелёная).

**Сделано и закоммичено:**
- `ab0b5ac` — **чинена красная сборка** (P1). `npm run build` падал на 32 pre-existing tsc-ошибках (11 в исходниках + 21 в спек-фикстурах) ещё до `vite build`. Все 32 исправлены. + knip.json (scoped, samples/tools noise 41→0; unused files 53→1; pinned knip@6 devDep + `npm run knip`). + микро-dead-exports §1.2 (удалён мёртвый command-telemetry, isMac/isWindows/isLinux; export→local для transformOf/easingValueToY/escapeRegExp; убран лишний THEME_IDS/DEFAULT_THEME реэкспорт из барела state).
- `bcb8e79` — **perf сборки** (§5): `manualChunks` по подстроке ловил `?raw`/`?url` glob-иды playable-export'а и вмерживал export-only исходники в eager-чанки `three`/`pix3-runtime`. Guard на query-суффикс. Итог: three-чанк 18.8MB→811KB, pix3-runtime 2.1MB→532KB, eager JS редактора ~21MB→~3.8MB. Playable-export не сломан (spec зелёный).
- `6b45555` — **мёртвый vitest exclude** удалён: все 3 пути указывали на несуществующие файлы. `src/services/ViewportRenderService.spec.ts` (34 теста) на самом деле УЖЕ шёл и проходил. Правлена и стале-заметка в CLAUDE.md. → это **safety net для §3№1**.
- `3a2c716` — **§1.1 / Item 2 барель**: `src/services/index.ts` удалён (502 deep-импорта vs 18 barrel-импортов в 15 файлах). 18 импортов → deep-path; 2 спека с `vi.mock('@/services')` перенацелены; политика в AGENTS.md. knip unused-exports 185→99. `src/state/index.ts` СОХРАНЁН (это не барель — владеет `appState`).

**Ещё §5-наблюдение (не трогали):** PWA service worker прекэширует ~60MB, включая split export-only vendor-чанки — можно исключить из `globPatterns` (следствие, есть офлайн-импликации).

---

## 8. Стратегия Fable для отложенных элементов (готово к исполнению Opus)

### Item 3 — дедуп 2D/3D спрайтов (§2.1) · effort M · нужен yalc-раунд в DeepCore · ✅ **сделано** (§10)
Fable уточнил аудит: дублирование `уже` — общий только кадровый kernel в `tick()`. **Извлечь `FrameSequencePlayer`** (композиция, НЕ базовый класс/миксин — ноды наследуют разные базы, DeepCore полагается на `instanceof Sprite2D`).
- Новый `packages/pix3-runtime/src/core/FrameSequencePlayer.ts` (без импорта three): владеет `timeAccumulator`, `direction` (ping-pong), `playing`; метод `advance(dt, clip, currentIndex) → {nextIndex, framesAdvanced[], finished}` (возвращает СПИСОК пройденных кадров — чтобы 2D мог эмитить frame-events по каждому пройденному кадру только на play-driven advance, не на scrub из сеттера `currentFrame`). Floor `Math.max(0.001, …)` и ping-pong-грани (`getNextFrameIndex`) переносятся дословно.
- `finished:true` ровно один раз на non-loop конце; НОДА решает: 2D эмитит `'animation-finished'` с `clip.name`, 3D — без аргумента; оба потом свой `freeOnFinish→queueFree()`.
- Ноды сохраняют ВСЕ публичные поля/аксессоры. **Caution:** превращение публичного поля `isPlaying`/`playing` в аксессор — единственное изменение формы; проверить, что никто не делает `Object.keys(node)`/spread по нему (grep в editor + DeepCore).
- Опц. `core/texture-natural-size.ts` — вынести дублирующийся `naturalWidth??width` блок из `Sprite2D.setTexture`/`Sprite3D.setTexture`. НЕ делать общий «SpriteSizing» (2D scale-quad vs 3D rebuild-PlaneGeometry расходятся). `configure2DTexture()` НЕ двигается — остаётся в 2D-путях (mipmap-инвариант структурно защищён).
- Шаги: (1) player + его spec; (2) переключить AnimatedSprite2D, гейт = `AnimatedSprite2DAnimation.spec.ts` (в `core/`!) + `AnimatedSprite2DFrameEvents.spec.ts` + `ViewportRenderService.spec.ts`; (3) AnimatedSprite3D (`pingPong:false`); (4) texture-natural-size; (5) `yalc:publish` → `yalc update` в DeepCore → tsc там; (6) НЕ экспортировать player из runtime index (внутренний).

### Item 1 — декомпозиция `ViewportRenderService` (§3№1) · effort L · 13 коммитов
Файл 8328 LOC, класс `ViewportRendererService` (имя файла≠класса, оставить), `@injectable()` singleton, инжектится в 45 файлах, ~45 публичных методов.
**Подход: facade + owned collaborators (НЕ DI-сервисы).** Класс сохраняет DI-токен и все публичные методы (тонкие делегаты) → ноль изменений в 45 консюмерах. Кластеры стейта уезжают в `src/services/viewport/*` через узкий `viewport-render-context.ts` (живые геттеры на renderer/scene/camera + `requestRender()`/`markDirty()`).
**Инварианты горячего пути (сохранить дословно):** (1) `requestRender()` рендерит СИНХРОННО если `animationId===undefined` (луп остановлен — pause/blur/hidden); (2) `renderLoopTick` скип если не dirty/не превью/не heartbeat≥500ms; (3) canvas-листенеры ставят `renderRequested=true` напрямую (без sync-render) — не трогать асимметрию; (4) `DefaultLoadingManager.onLoad→requestRender` (глобальный хук, один раз); (5) порядок `renderFrameBody`: mixers→тикеры→controls.update→billboards→AO→3D-pass→**`assign2DVisualRenderOrder(roots)` прямо перед 2D-pass**→clearDepth→2D-pass→inset→HUD; (6) `suppressGizmosForCapture`; (7) `isRenderingFrame` re-entrancy guard (screenshot зовёт renderFrame напрямую).
**Порядок извлечения (по риску, каждый коммит зелёный):** Commit0 = safety-net (СДЕЛАНО, `6b45555`). 1) `ViewportGpuTimer`; 2) `viewport-framing-math` (чистые функции); 3) `ViewportScreenshotter`; 4) `ViewportSelection2DOverlayHud` (~1250 LOC, очень когезивный, крупнейший выигрыш); 5) `ViewportPreviewTicker`; 6–7) `Viewport2DProxyRegistry` (~2600 LOC, в 2 коммита — фабрики+`configureSpriteTexture`/`reapply2DTextureFiltering`+render-order, затем sync-ветки `updateNodeTransform`; ВЫСШИЙ риск, гейт = proxy-тесты + ручная проверка 2D paint-order); 8) `Viewport3DContentSync`; 9) `ViewportAdornments`; 10) `ViewportNavigation` (сверить с существующим `Navigation2DController`); 11) `ViewportPicking`; 12) `ViewportTransformSession`; 13) sweep + `docs/architecture.md`.
Остаётся в фасаде НАВСЕГДА: `ensureInitialized` (+Valtio-подписки+focus-хэндлеры), весь loop (`requestRender`/`renderFrame`/`renderFrameBody`/`renderLoopTick`/pause/resume), `syncSceneContent`/`processNodeForRendering`, `updateSelection`/`updateNodeTransform` (тонкие диспетчеры), `dispose`. Финал фасада ≈900–1200 LOC. Commits 1–5 = ~3 дня, снимают ~2300 LOC, независимо шипабельны.

### §4.3 (не разбирал детально) — 94 плоских сервиса: доменная группировка + аудит «логика в обход Command→Operation». Отдельная задача Fable при желании.

---

## 9. Оптимизация загрузки/бандла — ветка `perf/bundle-runtime` (2026-07-21, от смерженного `main`)

Фокус сессии сменился на §5 (perf). Сделано и закоммичено:

- `d0c56fe` — **PWA precache раздут**: `PlayableHtmlBuildService` эмбедит ~1500 vendor/runtime исходников как raw-текст (`?raw`/`?url` glob) для playable-export — никогда не исполняются редактором, но их контент-хэшированные имена чанков выглядели как обычные lazy-чанки и Workbox их прекэшировал. Завёл `chunkFileNames` в `vite.config.ts`, разводящий такие чанки в `assets/export-vendor/**`, и добавил `globIgnores: ['**/export-vendor/**']`. **Precache: 1732 записи (60.0MB) → 155 записей (36.7MB).** Реальные eager/lazy чанки редактора (main/editor.main/three/pix3-runtime/Monaco-воркеры/esbuild.wasm) подтверждены как остающиеся в прекэше.
- `2a50854` — **bundle-инвентаризация**: `rollup-plugin-visualizer` добавлен dev-only за `process.env.ANALYZE` (`ANALYZE=1 npm run build` → `dist/stats.html`), в обычную сборку не попадает (проверено).
- `17c7d4d` — **lazy-load контента шаблонов проекта**: `ProjectTemplateService` грузил КАЖДЫЙ файл каждого бандл-шаблона + агентский overlay (AGENTS.md/CLAUDE.md/skills) + 2 doc-справочника (`nodes-and-systems.md`, `node-types-reference.md`) эagerly (~150KB в `main`), хотя это нужно только в момент реального создания проекта, не при листинге шаблонов в диалоге (там нужны только метаданные из `template.yaml`). Глобы `TEMPLATE_TEXT_MODULES`/`AGENT_OVERLAY_MODULES`/`AGENT_DOC_REFERENCE_MODULES`/`AGENT_GITIGNORE_MODULES` переведены eager→lazy; добавлены `getTemplateTextFiles(id)`/асинхронный `getAgentOverlayFiles()` с кэшем, используются только в уже-`async` `ProjectService.createProjectStructure()`. Диалог создания проекта и `ProjectLifecycleService` трогали только метаданные — 0 изменений там. **`main`: 2514KB → 2408KB.** Верифицировано временным spec'ом (создан/прогнан/удалён, не закоммичен) — реальный контент резолвится корректно, кэшируется по identity.

### Инвентаризация `main`-чанка (2.4MB) — что разобрано, что осталось на будущее

Через `rollup-plugin-visualizer`, сгруппировано по вкладу в eager `main`:

| Группа | Размер (несжато) | Вердикт |
|---|---|---|
| collab-стек (yjs + hocuspocus + lib0) | 414 KB | **НЕ быстрая правка.** `ProjectStorageService` импортирует `yjs` на верхнем уровне модуля безусловно (`Y.Doc`/asset-events используются даже вне cloud-бэкенда). Лени-загрузка требует переписать core project-storage/collab-код на async — архитектурная правка. |
| golden-layout | 349 KB | Ядро докинг-шелла — нужен eagerly, не кандидат. |
| Monaco IntelliSense libs (`monaco-runtime-libs.ts`) | 242 KB | **Проблема DI-связывания.** Панель code-editor уже лениво грузится (`LayoutManager` → `import('@/ui/code-editor/code-tab')`), но `ProjectDiagnosticsService` делает `@inject(MonacoIntelliSenseService)` — а `@inject()` в этой кодовой базе (`src/fw/di.ts`) требует статический импорт класса в месте инжекции → тянет Monaco lib-defs eagerly независимо от того, открыт ли редактор кода. Починка = либо lazy-resolve паттерн в самом DI-фреймворке, либо ручной `await import()` + ручное разрешение через контейнер в этом конкретном месте — отклонение от стандартной конвенции `@inject`, не конфиг-правка. |
| feather-icons (весь набор) | 159 KB | `IconService` рендерит иконки повсюду — ожидаемо, не кандидат. |
| `PlayableHtmlBuildService.ts` (сам код, БЕЗ export-vendor-раве-сорсов — те уже вынесены в п.1 выше) | 153 KB | Export — редкое действие по требованию, но та же DI-проблема: сервис инжектится в вещи, которые создаются eagerly. |
| esbuild-wasm JS-glue | 125 KB | Нужен для in-editor компиляции скриптов — вероятно, действительно always-on; не проверял, отложена ли компиляция до первого реального открытия скрипта. |
| `src/templates/**` + `docs/**` | 149 KB | ✅ **Сделано** (см. `17c7d4d` выше). |

**Общий вывод для Fable:** большинство крупных eager-вкладов — не небрежность, а следствие DI-конвенции `@inject()` (требует статического импорта в месте инжекции). Чтобы вынести Monaco IntelliSense / `PlayableHtmlBuildService` в lazy без нарушения архитектуры, нужен **lazy-resolve паттерн в `src/fw/di.ts`** (например, `@injectLazy(ServiceClass)` возвращающий `() => Promise<T>`, резолвящий класс через динамический `import()` + контейнер только при первом обращении) — это системная правка DI-фреймворка, а не точечный фикс. Аналогично коллаб-стек (yjs/hocuspocus) зашит в `ProjectStorageService` на уровне архитектуры хранения, не только collab-фичи — вынесение потребует различать "CRDT-модель всегда в памяти" от "сетевой sync опционален", что тоже архитектурное решение, не рефактор.

**Следующий шаг (не начат):** обсудить с Fable, стоит ли овчинка выделки — lazy-resolve DI паттерн даёт доступ к ~400KB (Monaco+PlayableHtmlBuildService) ценой усложнения `src/fw/di.ts` и потенциального размытия "прямого импорта = очевидная зависимость" читаемости кода. Альтернатива: оставить как есть, т.к. это одноразовая загрузка при холодном старте редактора (не хот-пасс), и 400KB из ~3.8MB eager JS — не доминирующий вклад.

### Профилирование холодного старта — chrome-devtools MCP, продакшн-сборка (`vite preview`)

Важный методологический момент: трейс через `npm run dev` НЕ репрезентативен (Vite отдаёт неминифицированные ESM-модули без наших чанк-оптимизаций) — профилировать нужно `vite preview` (реальный `dist/`).

- `bb3fa29` — **Yandex.Metrika (index.html) блокировала холодный старт**: профиль показал Metrika как №1 источник forced-reflow (32мс) и №1 по main-thread времени среди 3rd-party скриптов (~247мс) внутри окна render-delay (~950-1050мс до LCP). Причина: `ym('init', …)` только кладёт вызов в очередь стаба — реальная тяжёлая работа (webvisor DOM/session-recording, clickmap-листенеры) выполняется, когда догрузится `tag.js` и разберёт очередь, что происходит конкурентно с холодным стартом редактора. Фикс: `referrer`/`url` захватываются синхронно как раньше (до того как клиентский hash-роутинг переписывает `location.hash`), а сам вызов `ym('init', …)` отложен на `requestIdleCallback` (фоллбэк — `window.load`). Поведение трекинга не меняется — те же данные, просто после критического пути. **Верифицировано повторным трейсом: вклад Metrika в forced-reflow на критическом пути 32мс→2мс** (суммарное время не изменилось — 283мс, ожидаемо: работу не убирали, только сдвинули).
- Попутная находка при живом тестировании (реальный E2E прогон `17c7d4d` через chrome-devtools MCP на `vite preview`): создание нового проекта (шаблон Empty 3D, backend "In Browser"/OPFS) прошло без единой console-ошибки, сцена/AGENTS.md/CLAUDE.md/README.md/`.claude/skills/**` записались корректно — lazy-loaded аксессоры `ProjectTemplateService` работают в реальной проды-сборке, не только в юнит-тестах.
- `runtime-panel-spawn-lag` (память) перепроверена: фикс (`pos` вынесен из хэша, императивная запись позиций через `syncPositions()`) уже **закоммичен** в истории (`044c4ef` и потомки) — ничего дополнительно делать не нужно, память была написана до того как это замержили.
- Не успел/не начал: throttled-CPU трейс play-mode со спавнами (нужен реальный проект со спавнером типа SkyDefender, не 5-минутный Empty-3D); детальный breakdown `main-CGOBXrZh.js` внутренних функций (`_n`/`syncActiveState`/`scrollToBottom`), которые остались топ forced-reflow contributors ПОСЛЕ фикса Metrika — вероятно Golden Layout / вкладки, не проверял глубже.

---

## 10. P3 Item 3 — `FrameSequencePlayer` (2026-07-22) — ветка `refactor/frame-sequence-player`

Реализовано по стратегии §8 Item 3 (Opus-агент, дизайн уже был зафиксирован — исполнение без отклонений от него). Проверено сессионной моделью: диффы прочитаны, гейт-спеки перезапущены независимо (64/64 passed), `npm run type-check` чистый.

**Коммиты (не смержено в `main`):**
- `d936412` — `FrameSequencePlayer` (`packages/pix3-runtime/src/core/FrameSequencePlayer.ts` + spec, без импорта `three`) + переключён `AnimatedSprite2D`.
- `f5a3b1e` — переключён `AnimatedSprite3D` (`playbackMode:'linear'`, без per-frame duration/событий).
- `5fb7817` — опциональный шаг §8: `core/texture-natural-size.ts` (`getNaturalTextureSize`), выделен из `Sprite2D`/`Sprite3D.setTexture`.

**Отклонения от плана (обоснованные, не блокеры):**
- `isPlaying`/`playing` остались обычными публичными полями (НЕ аксессоры) — плановый риск «поле→аксессор» просто не возник, а не был обойдён post-factum.
- yalc-раунд в DeepCore **пропущен сознательно**: DeepCore на самом деле уже мигрировал с yalc на настоящий npm-пакет `@pix3/runtime@^0.1.0` (см. память `pix3-npm-publishing` — CLAUDE.md в этой части устарел). Вместо yalc-round-trip — статическая проверка: DeepCore зависит от спрайтов только через `child instanceof Sprite2D` (`InventoryBehavior.ts`, `ShopPanelBehavior.ts`), публичный API/идентичность класса не менялись → риск нулевой. DeepCore не тронут (`git status` чист).
- 3D получил незапланированный, но строго положительный побочный эффект: catch-up нескольких кадров за один `tick()` при большом `dt` (раньше — максимум один кадр за тик) + защитный guard `fps <= 0` (уже был в 2D).
- Найдена и осознанно принята архитектурная деталь: `finished`-латч в `FrameSequencePlayer` держит состояние «уже закончилось» до явного `reset()` — если скрипт вручную выставит `isPlaying = true` после конца non-loop клипа без смены клипа, повторного проигрывания не будет (старый код вместо этого мог повторно файрить `animation-finished` при достаточном `dt` — тоже не «рабочий рестарт», а баг). В кодовой базе такого паттерна нет; документированный способ рестарта — заспавнить новый нод через `freeOnFinish`/`core:FreeOnSignal` (см. `docs/nodes-and-systems.md`). Не блокер, но если когда-то понадобится restart-in-place — сюда вернуться.

**Не сделано:** мерж в `main` — ждёт решения пользователя.
