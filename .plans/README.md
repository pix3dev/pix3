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
- **[asset-library.md](asset-library.md)** — дизайн-план встроенной библиотеки ассетов: единый item-формат, три scope (builtin / user-OPFS / team-сервер), панель с поиском и drag-вставкой, publish из генератора и префабов, API для агента.

**Базис верификации:** commit `d591e68`, 2026-07-06. Все утверждения «есть / partial / нет» проверены по исходникам, ссылки на файлы указаны в документах.

## Выполненные планы ([done/](done/))

Исторические implementation-планы и спеки для уже реализованных подсистем — хранятся для ретроспективы (история переносов сохранена через `git mv`):

- [done/ECS_IMPLEMENTATION_PLAN.md](done/ECS_IMPLEMENTATION_PLAN.md) — гибридный ECS для `pix3-runtime`.
- [done/autoload_scripts_and_signals_plan.md](done/autoload_scripts_and_signals_plan.md) — автолоад-синглтоны и движок сигналов/групп.
- [done/collab-mvp-plan.md](done/collab-mvp-plan.md) — collab-сервер (cloud-first MVP).
- [done/layout2d-implementation-plan.md](done/layout2d-implementation-plan.md) — нода Layout2D и anchor-режим.
- [done/sprite_animation_update.md](done/sprite_animation_update.md) — обновление flipbook-анимаций спрайтов.

## Как поддерживать

- При изменении приоритетов сначала обновлять `ROADMAP.md` (оси и критерии), потом раскладывать в `TODO.md`.
- Когда план полностью реализован — переносить его в `done/` через `git mv` (не удалять: архив нужен для ретроспективы).
- Оценки сложности — в стиле `TODO.md`: S / M / L.
