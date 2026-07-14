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

## Как поддерживать

- При изменении приоритетов сначала обновлять `ROADMAP.md` (оси и критерии), потом раскладывать в `TODO.md`.
- Когда план полностью реализован — переносить его в `done/` через `git mv` (не удалять: архив нужен для ретроспективы).
- Оценки сложности — в стиле `TODO.md`: S / M / L.
