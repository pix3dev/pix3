# .plans

Дом для планирования Pix3: активные стратегические планы в корне папки, выполненные — в [done/](done/) для ретроспективы.

Разделение обязанностей:
- **`TODO.md` в корне репозитория** — операционный список задач (что делаем, чекбоксы S/M/L).
- **`.plans/` (здесь)** — стратегия: что и почему в каком порядке.
- **`docs/`** — живая референс-документация (архитектура, спецификация, справочники нод/схем). Не планы.

## Активные планы

- **[ROADMAP.md](ROADMAP.md)** — основной план: цель, проверка гипотез по коду, приоритеты P0–P3 по осям «сочность / кат-сцены / agent pipeline / бизнес», критерии готовности, порядок исполнения.
- **[cross-engine-ideas.md](cross-engine-ideas.md)** — аудит фич из других движков (Godot, Unity, Unreal, Cocos, Defold и инструментов playable-индустрии): что уже есть в Pix3, что стоит перенять, что осознанно пропускаем.
- **[browser-storage-projects.md](browser-storage-projects.md)** — implementation-план «проект без выбора папки»: OPFS-бэкенд `'browser'`, дефолт в create-диалоге, Move to Folder, точки правок по файлам.
- **[asset-library.md](asset-library.md)** — библиотека ассетов: Phase 1 / MVP (builtin + user-OPFS, панель, publish) реализован; остались `team`-scope на collab-сервере и API для агента.
- **[agent-game-harness.md](agent-game-harness.md)** — harness для прототипирования игр слабыми моделями: game-ready пайплайн `generate_asset`, vision-sidecar, встроенные скиллы агента, eval-цикл через `__PIX3_DEBUG__.agent`.
- **[agent-eval-scenarios.md](agent-eval-scenarios.md)** / **[agent-eval-results.md](agent-eval-results.md)** — сценарии и результаты eval-прогонов встроенного агента (S1–S4, тюнинг промптов/тулов).
- **[p1-m-feature-designs.md](p1-m-feature-designs.md)** — design-спеки P1 M-фич: particles, shader-effects, audio-buses, cutscene-director реализованы; осталась секция video-recording.
- **[postprocess-effects-list-design.md](postprocess-effects-list-design.md)** — design-спека attached-effect списка на PostProcess (по образцу shipped GeometryMesh-паттерна); не реализована.
- **[localization-design.md](localization-design.md)** / **[localization-SESSION-PROMPT.md](localization-SESSION-PROMPT.md)** — i18n/l10n (Godot `tr()`-adapted). **Последнее начатое.** Реализован только runtime-core (Phase 0, commit `8987ac7`: `LocalizationService`, `labelKey`/`getDisplayText`, persistence, `SceneService.localization`); остаётся SceneRunner play-mode wiring + весь editor-слой (Phase 1 manifest/preview/inspector), Phase 2 (панель + локализованные спрайты + export), Phase 3 (миграция SkyDefender + docs).
- **[group2d-autosize-resize-design.md](group2d-autosize-resize-design.md)** — Group2D fit-to-contents + Figma-style пропорциональный resize детей. Phase 1 / MVP (обе фичи A+B, commit `7cd1bac`) реализован; остаются Phase 2 (auto-fit при создании группы) и Phase 3 (Ctrl-drag box-only, меню/шорткат, reactive-флаг — опционально).
- **[sprite-editor-design.md](sprite-editor-design.md)** — переименование Asset Generator → Sprite Editor + double-click open. Phase 1 (commit `53e6c07`) реализован; остаются Phase 2 (общий slicing-модуль + «Create Animation from image») и Phase 3 (shell-merge с flipbook-редактором, gated).
- **[browser-storage-projects.md](browser-storage-projects.md)** — реализовано (MVP); держим в активных до явной ручной проверки OPFS-сценария в редакторе.

**Базис верификации:** commit `d591e68`, 2026-07-06. Все утверждения «есть / partial / нет» проверены по исходникам, ссылки на файлы указаны в документах.

## Выполненные планы ([done/](done/))

Исторические implementation-планы и спеки для уже реализованных подсистем — хранятся для ретроспективы (история переносов сохранена через `git mv`):

- [done/ECS_IMPLEMENTATION_PLAN.md](done/ECS_IMPLEMENTATION_PLAN.md) — гибридный ECS для `pix3-runtime`.
- [done/autoload_scripts_and_signals_plan.md](done/autoload_scripts_and_signals_plan.md) — автолоад-синглтоны и движок сигналов/групп.
- [done/collab-mvp-plan.md](done/collab-mvp-plan.md) — collab-сервер (cloud-first MVP).
- [done/layout2d-implementation-plan.md](done/layout2d-implementation-plan.md) — нода Layout2D и anchor-режим.
- [done/sprite_animation_update.md](done/sprite_animation_update.md) — обновление flipbook-анимаций спрайтов.
- [done/rapid-prototyping-design.md](done/rapid-prototyping-design.md) — rapid prototyping: PWA + шаблоны, remote preview (relay + player), agent HTTP API, zip-экспорт + PlayableSDK, телеметрия устройств (все 5 фаз).
- [done/in-editor-agent.md](done/in-editor-agent.md) — встроенный AI-агент (чат-панель, BYOK-провайдеры, тул-слой); E2E закрыт eval-прогонами S1–S4.
- [done/shader-effects-v2-list-design.md](done/shader-effects-v2-list-design.md) — registry-backed attached-effect список на GeometryMesh.
- [done/2d-batching-atlas-design.md](done/2d-batching-atlas-design.md) / [done/2d-batching-atlas-SESSION-PROMPT.md](done/2d-batching-atlas-SESSION-PROMPT.md) — оптимизация 2D draw-calls: shared unit-quad (Phase 1), pre-launch texture-atlas + cache (Phase 2), paint-order quad-batcher (Phase 3). Все фазы shipped и верифицированы на SkyDefender (render 5.8→2.0 ms, GPU-текстур 152→3). Отложены follow-ups: export-emission атласа, label/glyph-атлас, worker-packing, white-pixel sheet.

## Как поддерживать

- При изменении приоритетов сначала обновлять `ROADMAP.md` (оси и критерии), потом раскладывать в `TODO.md`.
- Когда план полностью реализован — переносить его в `done/` через `git mv` (не удалять: архив нужен для ретроспективы).
- Оценки сложности — в стиле `TODO.md`: S / M / L.
