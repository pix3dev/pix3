# .plans

Дом для планирования Pix3: **все** планы живут здесь — активные стратегические в корне папки,
выполненные — в [done/](done/) для ретроспективы.

Разделение обязанностей:

- **[TODO.md](TODO.md)** — операционный список задач (что делаем, чекбоксы S/M/L).
- **`.plans/` (здесь)** — стратегия: что и почему в каком порядке.
- **`docs/`** — живая референс-документация (архитектура, спецификация, справочники нод/схем). Не планы.

## Активные планы

- **[ROADMAP.md](ROADMAP.md)** — основной план: цель, проверка гипотез по коду, приоритеты P0–P3 по осям «сочность / кат-сцены / agent pipeline / бизнес», критерии готовности, порядок исполнения.
- **[TODO.md](TODO.md)** — операционная раскладка тех же приоритетов по задачам.
- **[cross-engine-ideas.md](cross-engine-ideas.md)** — аудит фич из других движков (Godot, Unity, Unreal, Cocos, Defold и инструментов playable-индустрии): что уже есть в Pix3, что стоит перенять, что осознанно пропускаем. Колонка «В Pix3» — снимок на момент аудита (`d591e68`); текущий статус смотреть в ROADMAP.
- **[multiplayer-platform.md](multiplayer-platform.md)** — мультиплеер-платформа: WsCore как Room Fabric, headless-рантайм в isolated-vm, guest-first JWT. Phase 0 закрыта, Phase 1 в работе (протокол, компоненты репликации, spawn/despawn и editor-UX «Play Online» — сделаны).
- **[asset-store-admin.md](asset-store-admin.md)** — серверный курируемый Asset Store: фазы A–D (сервер, клиент-провайдер + админ-UI, OS drag&drop, lifecycle-добивка) реализованы; осталась Phase E — версионирование / «update available», коллекции-паки, OPFS-кэш, CDN.
- **[asset-library.md](asset-library.md)** — библиотека ассетов: Phase 1 / MVP (builtin + user-OPFS, панель, publish, self-contained bundles) реализован, personal-scope синхронизируется с collab-сервером; остались `team`-scope (источник объявлен в `library-sources.ts`, серверной части нет) и API для агента.
- **[strophe-api-spec.md](strophe-api-spec.md)** — спецификация-запрос к команде Strophe (strophe.app): «Connect Strophe» один раз, дальше редактор и агент генерируют ассеты на их кредитах без чужих API-ключей у нас. Статус: предложение к обсуждению, API на их стороне ещё не существует.
- **[agent-eval-scenarios.md](agent-eval-scenarios.md)** / **[agent-eval-results.md](agent-eval-results.md)** — живой eval-suite встроенного агента (сценарии S1–S4 + скоркард) и записи прогонов. Держим активными: используются при каждом тюнинге промптов/тулов.
- **[p1-m-feature-designs.md](p1-m-feature-designs.md)** — design-спеки P1 M-фич: particles (trails/sub-emitters), shader-effects, audio-buses, cutscene-director реализованы; осталась секция **video-recording** (единственная нереализованная).
- **[postprocess-effects-list-design.md](postprocess-effects-list-design.md)** — design-спека attached-effect списка на PostProcess (по образцу shipped GeometryMesh-паттерна); **не реализована** — нода остаётся с фиксированными слотами.
- **[sprite-editor-design.md](sprite-editor-design.md)** — переименование Asset Generator → Sprite Editor + double-click open. Phase 1 (commit `53e6c07`) реализован; остаются Phase 2 (общий slicing-модуль + «Create Animation from image») и Phase 3 (shell-merge с flipbook-редактором, gated).
- **[model-lab-3d-generator.md](model-lab-3d-generator.md)** — Model Lab: reference-image → процедурная Three.js-фабрика → GLB. Фазы 1–6 (ядро, панель `src/ui/model-lab/`) реализованы; в бэклоге — **B0: нейронный image→3D провайдер** (честный вывод: процедурная реконструкция проигрывает специализированным 3D-генераторам).
- **[browser-storage-projects.md](browser-storage-projects.md)** — «проект без выбора папки»: OPFS-бэкенд `'browser'`, дефолт в create-диалоге, Move to Folder. Реализовано (MVP); держим в активных до явной ручной проверки OPFS-сценария в редакторе.
- **[desktop-version.md](desktop-version.md)** — десктоп-обёртка (single-file exe + MS Store, C#/Photino). **Приоритет низкий** — вернуться после стабилизации редактора.

**Базис верификации:** commit `1afac13`, 2026-08-01 (перепроверка статусов по исходникам).

## Выполненные планы ([done/](done/))

Исторические implementation-планы и спеки для уже реализованных подсистем — хранятся для ретроспективы (история переносов сохранена через `git mv`):

- [done/ECS_IMPLEMENTATION_PLAN.md](done/ECS_IMPLEMENTATION_PLAN.md) — гибридный ECS для `pix3-runtime`.
- [done/autoload_scripts_and_signals_plan.md](done/autoload_scripts_and_signals_plan.md) — автолоад-синглтоны и движок сигналов/групп.
- [done/collab-mvp-plan.md](done/collab-mvp-plan.md) — collab-сервер (cloud-first MVP).
- [done/layout2d-implementation-plan.md](done/layout2d-implementation-plan.md) — нода Layout2D и anchor-режим.
- [done/sprite_animation_update.md](done/sprite_animation_update.md) — обновление flipbook-анимаций спрайтов.
- [done/rapid-prototyping-design.md](done/rapid-prototyping-design.md) — rapid prototyping: PWA + шаблоны, remote preview (relay + player), agent HTTP API, zip-экспорт + PlayableSDK, телеметрия устройств (все 5 фаз).
- [done/in-editor-agent.md](done/in-editor-agent.md) — встроенный AI-агент (чат-панель, BYOK-провайдеры, тул-слой); E2E закрыт eval-прогонами S1–S4.
- [done/agent-game-harness.md](done/agent-game-harness.md) — harness для прототипирования игр слабыми моделями: game-ready `generate_asset` (trim/postProcess-пресеты), vision-sidecar `analyze_image`, встроенные скиллы агента (`src/services/agent/agent-skills/`), eval-цикл `__PIX3_DEBUG__.agent` + скоркард `D.eval.run`. Весь P0 закрыт; секция P1 осталась незапланированным бэклогом.
- [done/shader-effects-v2-list-design.md](done/shader-effects-v2-list-design.md) — registry-backed attached-effect список на GeometryMesh.
- [done/2d-batching-atlas-design.md](done/2d-batching-atlas-design.md) / [done/2d-batching-atlas-SESSION-PROMPT.md](done/2d-batching-atlas-SESSION-PROMPT.md) — оптимизация 2D draw-calls: shared unit-quad (Phase 1), pre-launch texture-atlas + cache (Phase 2), paint-order quad-batcher (Phase 3). Все фазы shipped и верифицированы на SkyDefender (render 5.8→2.0 ms, GPU-текстур 152→3). Отложены follow-ups: export-emission атласа, label/glyph-атлас, worker-packing, white-pixel sheet.
- [done/redisign.md](done/redisign.md) — редизайн редактора: плоская токен-система в `index.css`, amber-акцент, floating viewport islands.
- [done/code-quality-audit-2026-07-21.md](done/code-quality-audit-2026-07-21.md) — аудит качества кода: 17 доменов в `src/services/`, `@injectLazy`, ленивый collab (закрыт PR #23–#27).
- [done/shader-effects-2d.md](done/shader-effects-2d.md) — `ShaderEffectStack` на 2D-хостах (Sprite2D/AnimatedSprite2D/Button2D) + вьюпорт-прокси, `core:adjust/grayscale/tint`, batch opt-out. Обе фазы (runtime + editor) shipped. Вне скоупа осталось: ColorRect2D/TiledSprite2D/Label2D-хосты, несколько инстансов одного эффекта.
- [done/localization-design.md](done/localization-design.md) / [done/localization-SESSION-PROMPT.md](done/localization-SESSION-PROMPT.md) — i18n/l10n (Godot `tr()`-adapted): рантайм (`tr`/`trPlural`, seed до первого кадра), панель Strings/Sprites, локализованные спрайты (`textureKey`/`stateTextureKeys`), export-эмиссия `locales/`, миграция SkyDefender (en+ru). Все фазы shipped и верифицированы.
- [done/unified-assets-panel.md](done/unified-assets-panel.md) — объединение asset-browser + assets-preview в Unity-style панель `pix3-assets-panel` (`src/ui/assets/`); все 5 фаз включая финальный `git mv`.
- [done/library-script-packing.md](done/library-script-packing.md) — self-contained prefab-бандлы библиотеки: упаковка `user:`-скриптов и ассетов, на которые ссылается код (two-bucket модель, `originalPathFiles`, rebuild скриптов перед вставкой, «Add as scene»).
- [done/agent-verify-transient-visuals.md](done/agent-verify-transient-visuals.md) — верификация transient-визуалов агентом: `game_input {type:'hover'}`, activity/state-delta в `NodeWatchRecorder`, вердикт вместо таймингового скриншота (A–C сделаны, D осознанно отложена).
- [done/spine-runtime-node.md](done/spine-runtime-node.md) — `SpineSkeleton2D`: Spine как **опциональная host-injected** зависимость (структурный контракт вместо импорта), общий `SpineSkeletonView` для нода и вьюпорт-прокси, страницы атласа вне pre-launch атласа, бандл рантайма в HTML/zip-экспорт (PR #30, #31).
- [done/group2d-autosize-resize-design.md](done/group2d-autosize-resize-design.md) — Group2D fit-to-contents + Figma-style пропорциональный resize детей: Phase 1 (commit `7cd1bac`) + Phase 2 (auto-fit при создании группы) + Phase 3 (Ctrl-drag box-only, меню `Edit → Fit Group to Contents` + `Mod+Alt+F`), спеки и live-верификация. Осознанно НЕ сделано: реактивный auto-size флаг и вынос планировщика в рантайм (`Group2D.scaleContents`) — см. §7.

## Как поддерживать

- Все планы (включая операционный `TODO.md`) живут в `.plans/` — в корне репозитория плановых файлов не заводим.
- При изменении приоритетов сначала обновлять `ROADMAP.md` (оси и критерии), потом раскладывать в `TODO.md`.
- Когда план полностью реализован — переносить его в `done/` через `git mv` (не удалять: архив нужен для ретроспективы) и оставлять в списке выше одну строку с тем, что осталось за скоупом.
- Оценки сложности — в стиле `TODO.md`: S / M / L.
