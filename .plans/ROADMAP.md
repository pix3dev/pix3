# Pix3 Roadmap

**Цель продукта:** максимально удобный инструмент для «сочных» (juicy) мини-игр и playable ads с премиум кат-сценами. Сверхцель — «не хуже Unreal, только в вебе, но с лучшим AI-agent pipeline». Качество картинки WebGL может уступать — главное вызывать эмоции.

**Принцип:** 80/20 — сначала те 20% возможностей, которые дают 80% эмоционального результата.

**Оси приоритизации:** 🧃 juice · 🎬 кат-сцены · 🤖 agent pipeline · 💰 бизнес (playable ads).

Верифицировано по коду на commit `d591e68` (2026-07-06).

---

## 1. Проверка гипотез из обсуждения

### Гипотеза 1: «Таймлайн — центр тяжести системы» — ✅ подтверждена, и даже сильнее

Модель данных ([keyframe-types.ts](../packages/pix3-runtime/src/animation/keyframe-types.ts)) уже спроектирована под расширение:

- `ClipTrack = PropertyTrack | AudioTrack` — discriminated union по `kind`; **аудио-треки уже есть** (ключ = res://путь + volume, с предзагрузкой и корректным wrap при loop).
- **Property-трек универсален**: бьёт по любому свойству property-schema любой ноды по относительному пути (`targetPath` + `property`). Значит камера, пост-эффекты, шейдер-параметры становятся анимируемыми **автоматически**, как только оформлены нодами/компонентами со схемами. Отдельная «анимационная система для камеры» не нужна.
- 20+ easing-функций на сегмент ([easing.ts](../packages/pix3-runtime/src/animation/easing.ts)): sine/quad/cubic/expo/back/elastic/bounce.
- Плеер ([AnimationPlayerBehavior.ts](../packages/pix3-runtime/src/animation/AnimationPlayerBehavior.ts)): play/stop/pause/seek/speed, сигналы `animation_started`/`animation_finished`, клипы сериализуются в YAML сцены.

**Вывод:** новые возможности делаем либо (а) property-схемой (анимируется бесплатно), либо (б) новым `kind` трека по образцу audio. Оба пути дёшевы.

### Гипотеза 2: «Hot reload свойств в game mode — множитель» — ✅ подтверждена, не реализовано

Play mode исполняет **изолированный клон** сцены ([SceneRunner.ts](../packages/pix3-runtime/src/core/SceneRunner.ts), см. комментарии у строк ~141/155/230). Правки в authored-графе до клона не доходят — итерация по тюнингу juice требует рестарта. Механизм понятен: форвардинг обновлений по `nodeId` в клон. Бонус: `__PIX3_DEBUG__.setProperty(...)` начнёт работать как живой тюнинг и для агента.

### Гипотеза 3: «Agent pipeline поверх CDP-моста» — ✅ подтверждена; мост продвинутее, чем предполагалось

[debug-bridge.ts](../src/core/debug-bridge.ts) (`window.__PIX3_DEBUG__` v2, dev-only, вырезается из prod-бандла) уже даёт: DTO-дерево сцены, инспекцию нод/компонентов, поиск, selection, live Three.js-дерево во время игры, physics debug, управление play mode, undoable `setProperty`, запуск команд по id, ring-buffer ошибок, **полный AI-пайплайн ассетов** (generate/resize/crop/compress/removeBackground/save) и game-specific debug provider ([game-debug.ts](../packages/pix3-runtime/src/core/game-debug.ts)). Скиллы уже опираются на это: `.claude/skills/debug-running-game`, `.claude/skills/generate-sprites-in-editor`.

**Реальные гапы моста:** `command(id)` не принимает аргументов; нет CRUD нод; нет authoring-API таймлайна; нет дампа YAML сцены; нет детерминированного скриншота вьюпорта; нет машиночитаемого каталога возможностей (capabilities).

### Гипотеза 4: «Экспорта под ad-сети нет → бизнес-P0» — ❌ опровергнута наполовину

Single-file экспорт **есть и серьёзный**: [PlayableHtmlBuildService.ts](../src/services/PlayableHtmlBuildService.ts) + [ExportPlayableHtmlCommand.ts](../src/features/project/ExportPlayableHtmlCommand.ts) собирают один HTML с инлайном runtime-исходников, three, rapier (+wasm), yaml и base64-ассетов; есть size-report (raw vs base64 по каждому ассету), предупреждения, даже iOS-haptics модуль.

**Реальный гап — адаптация под сети:** mraid/DAPI-обёртки, пресеты сетей (AppLovin, Unity, ironSource, Mintegral, Meta…), CTA-API (`openStore()`), orientation/resize-обработка, протокольные события, валидатор бюджета размера. Минификация бандла не обнаружена (`minify` в src/services не встречается) — дешёвый выигрыш по размеру.

---

## 2. Фундамент (что уже есть и на что опираемся)

| Подсистема | Состояние | Где |
|---|---|---|
| Keyframe-таймлайн + панель + preview | ✅ property/audio-треки, easing | [animation/](../packages/pix3-runtime/src/animation/), [animation-timeline](../src/ui/animation-timeline/animation-timeline-panel.ts), [AnimationTimelinePreviewService](../src/services/AnimationTimelinePreviewService.ts) |
| Префабы-инстансы | ✅ placement-overrides (Unity-style), unlink, open | [prefab-utils.ts](../src/features/scene/prefab-utils.ts), [UnlinkPrefabInstanceOperation](../src/features/scene/UnlinkPrefabInstanceOperation.ts) |
| Behaviors | ✅ Follow (smoothing, per-axis), Fade, PinToNode, Rotate, Sine, PlaySound, RadialProgress | [behaviors/](../packages/pix3-runtime/src/behaviors/) |
| UI-ноды | ✅ Button/Checkbox/Slider/Bar/Label/ScrollContainer/**Joystick**/InventorySlot; **nine-slice** в TiledSprite2D | [nodes/2D/UI/](../packages/pix3-runtime/src/nodes/2D/UI/), [tiled-sprite-geometry.ts](../packages/pix3-runtime/src/core/tiled-sprite-geometry.ts) |
| Flipbook-анимации спрайтов | ✅ клипы, fps, ping-pong, per-frame collision | [AnimationResource.ts](../packages/pix3-runtime/src/core/AnimationResource.ts) |
| 3D | ✅ Camera3D, 5 типов света, GeometryMesh/MeshInstance/InstancedMesh3D, Particles3D, Sprite3D | [nodes/3D/](../packages/pix3-runtime/src/nodes/3D/) |
| Физика | ✅ rapier (lazy, wasm вне основного бандла), debug-overlay | [lazy-rapier.ts](../src/core/lazy-rapier.ts) |
| Аудио | ⚠️ masterGain + volume + panner; **нет шин/снапшотов/random pitch** | [AudioService.ts](../packages/pix3-runtime/src/core/AudioService.ts) |
| Инпут | ⚠️ pointer/key события, virtual axes/buttons; **нет жестов** | [InputService.ts](../packages/pix3-runtime/src/core/InputService.ts) |
| Экспорт playable | ⚠️ single-file + size report; **нет сетевых адаптеров/минификации/компрессии** | [PlayableHtmlBuildService.ts](../src/services/PlayableHtmlBuildService.ts) |
| Debug-мост для агентов | ⚠️ богатый v2; гапы см. гипотезу 3 | [debug-bridge.ts](../src/core/debug-bridge.ts) |
| Пост-процессинг | ❌ отсутствует полностью (EffectComposer не используется) | — |
| Глобальный timeScale | ❌ отсутствует (нужен для hitstop/slow-mo) | — |
| Камера как система (vcams/blend/shake, Camera2D) | ❌ только Camera3D + FollowBehavior | — |

Плюс: operations-first гейтвей (undo/redo даром для любой фичи), сигналы/группы, автолоады, collab-сервер, PWA. Второй стратегический актив после таймлайна — **CommandDispatcher/OperationService**: любая новая команда автоматически доступна агенту через мост.

---

## 3. P0 — ядро «премиум кат-сцены» + бизнес-минимум

**Общий критерий готовности P0:** дизайнер собирает 3-секундный intro-синематик (наезд камеры, bloom-вспышка, slow-mo, звук, событие в геймплей) в таймлайне **без кода** — и экспортирует результат, проходящий валидацию хотя бы в 3 ad-сетях.

### P0.1 Виртуальные камеры (Cinemachine-lite) — 🎬🧃 — L

- **Есть:** [Camera3D](../packages/pix3-runtime/src/nodes/3D/Camera3D.ts); [FollowBehavior](../packages/pix3-runtime/src/behaviors/FollowBehavior.ts) уже реализует smoothing/per-axis follow — переиспользовать математику.
- **Делать:** нода `VirtualCamera3D` (priority, follow target + deadzone, lookAt + вес, confiner-box, FOV/orthoSize) + `CameraBrain` на активной камере (выбор по приоритету, бленд с easing при переключении). Всё — property-schema ⇒ таймлайн анимирует position/FOV/приоритеты **без строчки анимационного кода**.
- **Camera2D** для 2D-слоя (offset/zoom/limits/shake) — отдельный пункт, M: сейчас 2D-пасс вообще без камеры (фиксированная орто-проекция).
- Критерий: переключение двух vcam с блендом + follow за движущейся нодой собирается из инспектора.

### P0.2 Post-processing stack — 🧃🎬 — M

- Интеграция `pmndrs/postprocessing` в [RuntimeRenderer](../packages/pix3-runtime/src/core/RuntimeRenderer.ts) и editor-вьюпорт (ViewportRenderService, с учётом on-demand рендера и 2D-пасса поверх).
- Нода/секция scene settings `PostProcess` со схемой: **Bloom, Vignette, Chromatic Aberration, LUT** — интенсивности анимируются property-треками (bloom-вспышка = 3 ключа).
- ⚠️ Бюджет размера: подключать в экспорт условно (эффект не используется → код не инлайнится).
- Критерий: bloom-вспышка по таймлайну работает и в редакторе, и в экспортированном playable.

### P0.3 Библиотека juice-примитивов — 🧃 — M

- **Глобальный `Time.scale`** в SceneRunner (сейчас нет) → `hitstop(ms)`, slow-mo.
- `shake(node|camera, {amplitude, frequency, decay})` на Perlin; `flash()`, `punchScale()` (squash&stretch), `popIn()` — поверх существующего easing/tween.
- Оформить и как API для скриптов, и как behaviors/пресеты (двойное назначение: дизайнер и агент).
- Критерий: «удар»: hitstop 80 мс + shake камеры + flash — три вызова или три пресета.

### P0.4 Event-трек в таймлайне — 🎬🤖 — S

- Новый `kind: 'event'` по образцу `AudioTrack` ([keyframe-types.ts](../packages/pix3-runtime/src/animation/keyframe-types.ts)): в момент t → `emit(signal, args)` на host/target-ноде или `callGroup(...)`. Расширить [clip-evaluator.ts](../packages/pix3-runtime/src/animation/clip-evaluator.ts) + строка в панели таймлайна.
- Это клей кат-сцены: камера+VFX+звук+геймплей синхронизируются одним клипом. Сигнальный движок уже готов принимать.

### P0.5 Hot reload свойств в play mode — 🧃🤖 — M

- Форвардинг `UpdateObjectPropertyOperation` в рантайм-клон по `nodeId` при `isPlaying` (маппинг authored→clone в SceneRunner). Структурные изменения (add/remove node) — вне скоупа, отдельно в P1/P2.
- Мгновенно ускоряет тюнинг всего P0 (интенсивность shake, кривые, тайминги) и оживляет `__PIX3_DEBUG__.setProperty` во время игры.
- Критерий: изменение свойства в инспекторе видно в запущенной игре ≤1 кадра, без рестарта.

### P0.6 Ad-network адаптеры экспорта — 💰 — M

- **Есть:** single-file сборка + size report (см. гипотезу 4).
- **Делать:** слой адаптеров: mraid-обёртка (viewable/ready), протокольные события, пресеты сетей (AppLovin, Unity Ads, ironSource, Mintegral, Meta, Google — у каждой свои требования: inline vs zip, размер 2–5 MB, orientation); runtime CTA-API `Playable.openStore()`; аудит «нет внешних запросов»; валидатор бюджета в диалоге экспорта.
- Быстрый выигрыш там же: включить **минификацию** бандла (esbuild minify — не обнаружена).
- Критерий: экспорт одного проекта проходит тест-инструменты 3 сетей без ручной правки HTML.

**Рекомендуемый порядок P0:** P0.4 (S, быстрый клей) → P0.5 (множитель для всего дальнейшего тюнинга) → P0.3 → P0.1 → P0.2 → P0.6 (можно параллельно с камерой/пост-фх силами «второй руки» или агента).

---

## 4. P1 — полировка кат-сцен и пайплайна размера

| Пункт | Оси | Размер | Комментарий |
|---|---|---|---|
| Аудио-шины Master/Music/SFX + снапшоты + random pitch/volume | 🧃🎬 | M | Нужно для slow-mo из P0.3 (muffle-снапшот). Сейчас только masterGain |
| Cutscene Director API | 🎬 | M | `playCinematic(id, {skippableAfter, blendDuration})`, letterbox-оверлей, input lock, возврат управления. Поверх P0.1+P0.4 |
| Draggable-гизмо целей камеры/света | 🎬 | S | TODO partial: рендерятся, не таскаются. Критично для авторинга синематиков |
| Партиклы: trails + sub-emitters | 🧃 | M | [Particles3D.ts](../packages/pix3-runtime/src/nodes/3D/Particles3D.ts) |
| 3–4 встроенных шейдер-эффекта (dissolve, rim, UV-scroll, flash-tint) | 🧃 | M | Как опции материалов со схемами ⇒ анимируемы треками. Вместо shader graph |
| Animation events для AnimatedSprite2D (кадр → сигнал) | 🧃 | S | По образцу event-трека P0.4 |
| Device-preview: пресеты аспектов/ориентаций + safe area | 💰 | M | Из Unity Device Simulator; ad-контейнеры ресайзят iframe произвольно |
| Компрессия ассетов при экспорте: WebP re-encode, atlas packing, audio bitrate | 💰 | M | Пайплайн сжатия уже есть в AssetGenService (compress/resize) — переиспользовать в экспорте |
| Превью звуков в редакторе/браузере ассетов | UX | S | Из TODO.md |

---

## 5. P2 — AI-agent pipeline (дифференциатор против Unreal)

Транспорт уже выбран и работает: CDP → `evaluate_script` → `window.__PIX3_DEBUG__` (НЕ отдельный MCP-сервер). Задача — расширить поверхность и сделать её контрактом.

| Пункт | Размер | Комментарий |
|---|---|---|
| **Bridge v3**: `command(id, args)`, CRUD нод (create/remove/reparent/duplicate), authoring таймлайна (add clip/track/key), `sceneYaml()`, `screenshot(w,h)` → dataURL, `step(nFrames)`, `capabilities()` | M | capabilities генерируется из CommandRegistry-метаданных + ScriptRegistry + реестра нод — агент сам узнаёт, что умеет редактор |
| JSON Schema для `.pix3scene` + asset-манифест **с метаданными** (размеры, длительность, поликаунт) | M | TODO partial: manifest сейчас — только пути. Позволяет агенту писать валидный YAML напрямую |
| Мост game events → консоль редактора | M | TODO partial: панель логов есть, моста нет. Замыкает цикл «сгенерировал → посмотрел → поправил» |
| Библиотека пресетов/темплейтов: juice, VFX («coin collect», «explosion», конфетти), camera rigs | M | Одни кирпичи для drag-and-drop дизайнера и для агента текстом |
| Scene validate/lint команда (битые res://, missing targets треков) | S | Самопроверка для агента и CI |
| Headless run-and-report: запустить сцену N секунд → ошибки + скриншоты | M | Верификация агентских правок без человека |
| `docs/AGENT_API.md` — контракт моста | S | Документировать v3 как стабильный API |

---

## 6. P3 — масштаб (после того как P0–P2 приносят результат)

glb-инспектор размера (M, TODO) · Draco/meshopt + KTX2 (M) · remote preview на устройстве (L, TODO) · asset library/store (M, TODO) · кастомные Безье-кривые easing + редактор кривых (M) · spline/dolly-пути камеры (L) · FSM/бленды клипов, AnimationTree-lite (L) · IK (L) · A/B-фреймворк вариаций playable (M) · захват видео геймплея для креативов (M) · публикация runtime-пакета в облако (M, TODO) · tools.gritsenko.biz (L, TODO, low).

## 7. Анти-скоуп (осознанно не делаем)

- **Shader graph** — 3–4 пресетных эффекта закрывают 80% juice; графовый редактор — огромная стоимость.
- **Visual scripting** — агентский pipeline делает текстовые скрипты дешевле визуальных графов; сигналы+behaviors закрывают «без кода» для дизайнера.
- **Продвинутая физика** (joints-цепочки, softbody) — rapier basics достаточно для playables.
- **Свой рендер-движок поверх Three** — берём готовое (pmndrs/postprocessing), не изобретаем.

## 8. Зависимости и верификация

```
P0.4 event-track ──┐
P0.1 vcams ────────┼──► P1 Cutscene Director ──► «премиум кат-сцены»
P0.2 post-fx ──────┘
P0.5 hot reload ──► ускоряет тюнинг всех P0/P1
P0.3 slow-mo ◄──── P1 audio snapshots (полный эффект)
P0.6 adapters ◄─── P1 компрессия (реальные бюджеты сеток)
P2 bridge v3 ◄──── P0.1/P0.4 (агент собирает синематики теми же командами)
```

**Сквозная верификация:** (1) демо-сцена «3-сек intro» в репозитории как эталон P0; (2) прогон экспорта через тест-инструменты сетей; (3) агентский e2e — через `debug-running-game` skill агент собирает мини-синематик и сверяет скриншотом; (4) DeepCore как полигон runtime-изменений (yalc).
