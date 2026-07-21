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

| # | Задача | Риск | Объём | Кто |
|---|---|---|---|---|
| P0 | ✅ dead-файлы + `package.json` | низ | — | сделано |
| P1 | Прогнать `npm install` + `npm run build`, подтвердить 0 новых ошибок | низ | S | Opus/я |
| P1 | Настроить `knip.json` (workspaces, исключить `samples/`,`tools/`,`docs/`) — чтобы отчёт стал воспроизводимым и без шума | низ | S | я |
| P2 | Барель `services/index.ts`: решение + чистка (§1.1) | сред | M | Fable реш. → Opus |
| P2 | Микро-dead-exports §1.2 (export→local / delete) | низ | S | Opus |
| P3 | Дедуп `SpriteAnimationController` для AnimatedSprite2D/3D (§2.1) | сред | M | Fable дизайн → Opus |
| P3 | Декомпозиция `inspector-panel` (§3 №2) | сред | M | Opus |
| P4 | Декомпозиция `ViewportRenderService` (§3 №1) | **выс** | L | Fable стратегия → поэтапно |
| P4 | Bundle-анализ + вывод по §5 | низ | S | я |

**Следующий шаг:** обсудить §3/§4 и решить, запускаем ли P2/P3 сразу или сначала стратегию `ViewportRenderService` от Fable.
