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
| Пост-процессинг | ✅ pmndrs/postprocessing (lazy), Bloom/Vignette/ChromaticAberration; LUT — scaffold (P0.2) | [PostProcessingPipeline.ts](../packages/pix3-runtime/src/core/PostProcessingPipeline.ts), [PostProcess.ts](../packages/pix3-runtime/src/nodes/PostProcess.ts) |
| Глобальный timeScale + juice | ✅ GameTime (hitstop/slow-mo) + shake/punchScale/popIn/flash (P0.3) | [GameTime.ts](../packages/pix3-runtime/src/core/GameTime.ts), [JuiceApi.ts](../packages/pix3-runtime/src/core/JuiceApi.ts), [behaviors/](../packages/pix3-runtime/src/behaviors/) |
| Камера как система (vcams/blend/shake, Camera2D) | ❌ только Camera3D + FollowBehavior | — |

Плюс: operations-first гейтвей (undo/redo даром для любой фичи), сигналы/группы, автолоады, collab-сервер, PWA. Второй стратегический актив после таймлайна — **CommandDispatcher/OperationService**: любая новая команда автоматически доступна агенту через мост.

---

## 3. P0 — ядро «премиум кат-сцены» + бизнес-минимум

**Общий критерий готовности P0:** дизайнер собирает 3-секундный intro-синематик (наезд камеры, bloom-вспышка, slow-mo, звук, событие в геймплей) в таймлайне **без кода** — и экспортирует результат, проходящий валидацию хотя бы в 3 ad-сетях.

### P0.1 Виртуальные камеры (Cinemachine-lite) — 🎬🧃 — L — ✅ 3D-часть сделана (Camera2D отложена)

- **Есть:** [Camera3D](../packages/pix3-runtime/src/nodes/3D/Camera3D.ts); [FollowBehavior](../packages/pix3-runtime/src/behaviors/FollowBehavior.ts) уже реализует smoothing/per-axis follow — переиспользовать математику.
- **Делать:** нода `VirtualCamera3D` (priority, follow target + deadzone, lookAt + вес, confiner-box, FOV/orthoSize) + `CameraBrain` на активной камере (выбор по приоритету, бленд с easing при переключении). Всё — property-schema ⇒ таймлайн анимирует position/FOV/приоритеты **без строчки анимационного кода**.
- ✅ **Сделано:** [VirtualCamera3D](../packages/pix3-runtime/src/nodes/3D/VirtualCamera3D.ts) (Node3D, не рендерит — описывает кадрирование; follow с per-axis deadzone + damping `1-e^(-k·dt)`, weighted look-at slerp, confiner-box, fov/orthoSize; вся конфигурация через property-schema ⇒ анимируется треками) + [CameraBrainBehavior](../packages/pix3-runtime/src/behaviors/CameraBrainBehavior.ts) `core:CameraBrain` на `Camera3D` (solve всех vcam каждый кадр включая standby, выбор по приоритету среди видимых, снапшот текущей позы на переключении, eased-бленд через `applyEasing` к живой цели, world→local запись в host-камеру). Проводка: SceneLoader/SceneSaver (`serializeConfig`), index, register-behaviors (`core:CameraBrain`), NodeRegistry + Create*Command/Operation, гизмо-иконка в ViewportRenderService. +14 тестов (solve-математика, выбор/бленд брейна, save/load round-trip).
- **Camera2D** для 2D-слоя (offset/zoom/limits/shake) — отдельный пункт, M: сейчас 2D-пасс вообще без камеры (фиксированная орто-проекция). **Отложена** (осознанно, следующим шагом).
- Критерий: переключение двух vcam с блендом + follow за движущейся нодой собирается из инспектора. ✅ (покрыто юнит-тестами; рекомендуется e2e-проверка в редакторе через `debug-running-game`)

### P0.2 Post-processing stack — 🧃🎬 — M — ✅ Bloom/Vignette/CA сделано (LUT — scaffold)

- ✅ **Интеграция `pmndrs/postprocessing`** через отдельный [PostProcessingPipeline](../packages/pix3-runtime/src/core/PostProcessingPipeline.ts): владеет `EffectComposer`, **lazy dynamic-import** модуля (code-split — без ноды не качается), 3-band пайплайн (3D RenderPass → depth ClearPass → 2D-content RenderPass → merged EffectPass). Rebuild пассов только при смене структуры; scalar-униформы (intensity/offset/darkness) пишутся каждый кадр ⇒ property-трек анимирует `bloomIntensity` бесплатно (bloom-вспышка = 3 ключа). RT сайзятся от `renderer.getSize()`; viewport/scissor сбрасываются перед композингом (композер владеет полным буфером). Поддержка **чисто-2D сцен** (нет Camera3D — playable ads): 2D-слой становится clearing base band.
- ✅ **Runtime/play** ([SceneRunner](../packages/pix3-runtime/src/core/SceneRunner.ts)): ветка composer + fallback на старый двухпроходный путь без активной ноды (ноль оверхеда); dispose в `stop()`. **whole-frame** пост по умолчанию (`affect2D`), 2D-контент идёт сквозь эффекты. **Editor** ([ViewportRenderService](../src/services/ViewportRenderService.ts)): постит только **3D-банд** (gizmos замаскированы и рисуются чисто поверх; 2D-контент+адорнменты — чисто поверх), on-demand-aware.
- ✅ **Нода `PostProcess`** ([nodes/PostProcess.ts](../packages/pix3-runtime/src/nodes/PostProcess.ts)) — Godot-`WorldEnvironment`-стиль (NodeBase, не рендерит), плоские анимируемые свойства: **Bloom** (intensity/threshold/smoothing/radius), **Vignette** (offset/darkness), **Chromatic Aberration** (offset), `affect2D`. Проводка: index, SceneLoader/Saver round-trip, NodeRegistry, `CreatePostProcess{Command,Operation}`; инспектор рисуется из схемы. +8 юнит-тестов (config/isActive/round-trip; рендер не тестируется в happy-dom).
- ✅ **Бюджет размера**: `postprocessing` подключается динамическим импортом ⇒ проект без пост-эффектов не инлайнит его в экспортированный playable.
- **Грабли (стоило часов, 2026-07-08):** three `WebGLBackground` **force-clear'ит фреймбуфер даже при `autoClear=false`**, если `scene.background` — `Color`. Любой `renderer.render(scene,cam)` после композера, не занулив `scene.background`, стирает кадр в цвет фона. Симптом: в редакторе 3D-сцена исчезала при включении поста (gizmo-пасс стирал композит). Фикс: занулять `scene.background` вокруг пост-композер рендеров.
- **Не сделано (отложено):** **LUT**-эффект (схема есть; эффект ждёт async-загрузку .cube/.3dl lookup-текстуры через AssetLoader); [CanvasLayer2D](../packages/pix3-runtime/src/nodes/2D/) (чистый overlay-band для UI поверх размытой сцены — выстрелит вместе с blur/DOF); editor full-2D-post (вынести 2D-адорнменты на выделенный чистый слой, чтобы 2D тоже постился в превью).
- Критерий: bloom-вспышка по таймлайну работает и в редакторе, и в экспортированном playable. ✅ проверено live через `debug-running-game` (whole-frame bloom в play-mode + 3D-превью в редакторе; A/B: draw calls 50→33 при выключении, стабильные 60 FPS). LUT-часть — после async-загрузки текстур.

### P0.3 Библиотека juice-примитивов — 🧃 — M — ✅ сделано

- ✅ **Глобальный `Time.scale`** через [GameTime](../packages/pix3-runtime/src/core/GameTime.ts): `hitstop(ms)` (freeze, стекается по максимуму), `slowMotion(scale,{durationMs,blendMs})` (ease-in + hold + ease-out), `setScale`/`reset`/`scale`/`isFrozen`. [SceneRunner.tick](../packages/pix3-runtime/src/core/SceneRunner.ts) масштабирует gameplay-dt (`dt = rawDt * gameTime.scale`); `render()` не масштабируется (замороженный кадр рисуется); таймеры идут по реальному dt (истекают сквозь заморозку); FPS-сэмпл репортит реальный dt.
- ✅ Юс-эффекты и как **script API** (`scene.time` / `scene.juice`), и как **`core:` behaviors/пресеты** (двойное назначение): `shake` на гладком шуме — **аддитивный** (убирает/переприменяет офсет каждый кадр, композится с Follow, чисто восстанавливается), `punchScale` (squash&stretch), `popIn` (spawn-pop с overshoot), плюс full-screen `flash()` (отдельный оверлей, реальное время → играет сквозь hitstop). Пресеты: [core:Shake](../packages/pix3-runtime/src/behaviors/ShakeBehavior.ts) / [core:PunchScale](../packages/pix3-runtime/src/behaviors/PunchScaleBehavior.ts) / [core:PopIn](../packages/pix3-runtime/src/behaviors/PopInBehavior.ts). API — [JuiceApi](../packages/pix3-runtime/src/core/JuiceApi.ts) (переиспользует один компонент на ноду; `target` = нода / query / `'camera'`).
- ✅ Каждый transform-эффект тикается через `node.tick` ⇒ автоматически уважает `Time.scale`. +20 тестов (GameTime, dt-scaling в SceneRunner, эффекты, impact-combo). Побочно: `NodeBase.addComponent` теперь инжектит `scene` (не только `input`); `getComponent` сигнатура починена под strict.
- **Не сделано (осознанно, отложено):** per-node tint-flash (сейчас flash экранный); Perlin заменён на сумму синусов (детерминизм без Math.random); shake на выделенном camera-pivot (сейчас офсет node.position — минимальная связка с Follow-сглаживанием, задокументирована).
- Критерий: «удар»: hitstop 80 мс + shake камеры + flash — три вызова. ✅ (impact-combo тест в [JuiceApi.spec.ts](../packages/pix3-runtime/src/core/JuiceApi.spec.ts))

### P0.4 Event-трек в таймлайне — 🎬🤖 — S — ✅ сделано

- ✅ Новый `kind: 'event'` по образцу `AudioTrack` ([keyframe-types.ts](../packages/pix3-runtime/src/animation/keyframe-types.ts)): в момент t → `emit(signal, ...args)` на host/target-ноде. `EventTrack { name, targetPath, keys: [{ time, signal, args }] }`; `args` — сырая строка, парсится `parseEventArgs()` (пусто → нет аргов, JSON-массив → spread, иной JSON → один арг, нераспарсенное → строка).
- ✅ Расширены [clip-evaluator.ts](../packages/pix3-runtime/src/animation/clip-evaluator.ts) (`collectEventKeysInRange`, `fireEventKey`, `eventEntries` в `ClipBinding`), плеер ([AnimationPlayerBehavior.ts](../packages/pix3-runtime/src/animation/AnimationPlayerBehavior.ts), `fireTimeWindow` = audio+events с единым окном), редактор ([clip-edit-utils.ts](../src/features/animation-timeline/clip-edit-utils.ts), панель, preview-сервис, lane-preview). +14 тестов.
- **Не сделано в v1** (осознанно): UI для редактирования `targetPath` (в данных есть, кнопка создаёт host-scoped); `callGroup(...)` из event-трека (`SceneService` не отдаёт его в рантайм — отдельная задача по проводке).
- Это клей кат-сцены: камера+VFX+звук+геймплей синхронизируются одним клипом. Сигнальный движок уже готов принимать.

### P0.5 Hot reload свойств в play mode — 🧃🤖 — M — ✅ сделано

- ✅ Форвардинг `UpdateObjectPropertyOperation` в рантайм-клон по `nodeId` при `isPlaying`. Маппинг authored→clone бесплатный: клон — это serialize→parse копия, `nodeId` совпадает 1:1, применение через тот же `getNodePropertySchema().setValue`, что и загрузчик. Структурные изменения (add/remove node) — вне скоупа, отдельно в P1/P2.
- ✅ Развязка через globalThis-sink в [game-debug.ts](../packages/pix3-runtime/src/core/game-debug.ts) (`registerRuntimeLivePropertySink`/`getRuntimeLivePropertySink`, по образцу `registerRuntimeSceneRoot`). [SceneRunner](../packages/pix3-runtime/src/core/SceneRunner.ts) регистрирует `applyLivePropertyUpdate` в `startScene`, чистит в `stop`; для 2D повторяет authored-rect capture / anchored-reflow, чтобы лейаут не откатывал правку. [Операция](../src/features/properties/UpdateObjectPropertyOperation.ts) форвардит в perform/undo/redo (в т.ч. opacity-ветка).
- ✅ `__PIX3_DEBUG__.setProperty` оживает во время игры автоматически (тот же путь command→operation). +5 тестов (SceneRunner + Operation).
- Критерий: изменение свойства в инспекторе видно в запущенной игре ≤1 кадра, без рестарта. ✅

### P0.6 Ad-network адаптеры экспорта — 💰 — M

- **Есть:** single-file сборка + size report (см. гипотезу 4).
- **Делать:** слой адаптеров: mraid-обёртка (viewable/ready), протокольные события, пресеты сетей (AppLovin, Unity Ads, ironSource, Mintegral, Meta, Google — у каждой свои требования: inline vs zip, размер 2–5 MB, orientation); runtime CTA-API `Playable.openStore()`; аудит «нет внешних запросов»; валидатор бюджета в диалоге экспорта.
- Быстрый выигрыш там же: включить **минификацию** бандла (esbuild minify — не обнаружена).
- Критерий: экспорт одного проекта проходит тест-инструменты 3 сетей без ручной правки HTML.

**Рекомендуемый порядок P0:** ~~P0.4 (S, быстрый клей)~~ ✅ → ~~P0.5 (множитель для всего дальнейшего тюнинга)~~ ✅ → ~~P0.3 (juice-примитивы)~~ ✅ → ~~P0.1 (vcam-3D)~~ ✅ (Camera2D-подпункт отложен) → ~~P0.2 (post-fx)~~ ✅ Bloom/Vignette/CA (LUT/CanvasLayer2D/editor-2D — отложены) → **P0.6** ← следующий (ad-network адаптеры экспорта).

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
| **Запись геймплея в видеофайл прямо в движке** | 💰🤖🎬 | M | `MediaRecorder` поверх `renderer.domElement.captureStream(fps)` → WebM (VP9/VP8) с download через File System Access; MP4 — через WebCodecs+mux при необходимости. Аудио пишется параллельно (AudioService `masterGain → MediaStreamDestination`, микс в тот же MediaStream). Кнопка **Record** в тулбаре play-mode: пресеты разрешения/fps/длительности (совпадают с device-preview), индикатор + стоп-по-времени. Опц. **офлайн-рендер** (фиксированный шаг `dt`, кадр-в-кадр в захват) для гладких 60 fps без просадок и детерминизма — переиспользует изоляцию клона play-mode (P0.5) и timeScale (P0.3), чтобы slow-mo/hitstop писались как задумано. Питает: креативы для ad-сетей, **A/B-вариации playable** (см. P3) и **headless run-and-report** (P2) — видео вместо/вместе со скриншотами. Критерий: одной кнопкой записать N-секундный клип play-mode в файл, с корректным звуком и без дропнутых кадров в офлайн-режиме |
| **Ambient Occlusion: запечённый + рантайм SSAO, переключаемый** | 🧃🎬💰 | L | Две реализации под разные цели с каскадом настроек **проект → сцена → нода**. **(1) Baked AO** (дёшево, для мобильных playable): кастомный GPU **hemisphere depth-accumulation** бейкер пишет **взаимный** AO (куб↔земля↔соседи) в per-object **lightmap-UV2** — примитивы генерят UV2 детерминированно (box → атлас 6 граней; прочие → нативный UV) ⇒ **без xatlas/WASM**, GLTF-развёртка отдельной фазой; PNG в `res://lightmaps/` через FileSystemAPIService, offscreen-рендерер по образцу ThumbnailGenerator. Рантайм-часть готова: `aoMap`+`aoMapIntensity`+uv1 на GeometryMesh (раньше без текстур вообще). **(2) Realtime SSAO/GTAO** (для десктопа/мощных): эффект в существующем PostProcessingPipeline (pmndrs/postprocessing, lazy), взаимное AO на всём включая динамику, без развёртки/запекания, ценой GPU/кадр. **Переключатель:** `Project → Rendering → AO = Baked\|Realtime\|Adaptive\|Off` (дефолт) → override на ноде `PostProcess` (scene-level, + SSAO radius/intensity/samples) → нода-меш opt-in в запекание (`bakeStatic`). **Резолв:** Adaptive → Realtime на способном девайсе иначе Baked; при активном SSAO запечённые aoMap подавляются (`aoMapIntensity→0`), чтобы AO не складывалось дважды; baked всегда лежит как fallback. **Только AO** (прямые тени/GI вне скоупа). Критерий: одна сцена корректно выглядит и на mobile (baked), и на desktop (SSAO), переключается настройкой без ручной переделки |
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

glb-инспектор размера (M, TODO) · Draco/meshopt + KTX2 (M) · remote preview на устройстве (L, TODO) · asset library/store (M, TODO) · кастомные Безье-кривые easing + редактор кривых (M) · spline/dolly-пути камеры (L) · FSM/бленды клипов, AnimationTree-lite (L) · IK (L) · A/B-фреймворк вариаций playable (M, использует запись видео из P1) · публикация runtime-пакета в облако (M, TODO) · tools.gritsenko.biz (L, TODO, low).

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
