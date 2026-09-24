# Headless agent authoring pipeline — browser runtime without the PWA editor

Status: **design draft, frozen** · Date: 2026-09-25

Вернуться к плану, когда появится приоритет на автономное создание и проверку игр вне PWA-shell
или когда editor-coupling начнёт заметно ограничивать скорость, параллельность либо надёжность
агентских прогонов.

## 1. Цель

Дать агенту возможность создать, изменить, запустить, проверить и экспортировать Pix3-игру без
загрузки PWA-редактора, но с использованием настоящих Pix3 runtime, формата сцен, операций,
компилятора и экспортера.

Это не «редактор без панелей» и не вторая реализация Pix3. Это отдельный agent-first host:

```text
Agent / orchestrator
        │ MCP / typed tools
        ▼
Pix3AgentBridge                 local control plane
        │ authenticated session
        ▼
Minimal browser host           execution plane
        ├── authoring core
        ├── SceneManager
        ├── script compiler
        ├── SceneRunner
        └── canvas / WebGL / WebAudio
```

PWA остаётся человеческим клиентом для визуального редактирования и ручной доводки. Оба клиента
работают поверх одного authoring/runtime-ядра, поэтому созданный headless-пайплайном проект должен
открываться в редакторе без конвертации.

## 2. Текущее состояние (проверено по исходникам)

- `@pix3/runtime` уже владеет узлами, загрузкой сцен, `SceneManager`, `SceneRunner`, игровыми
  системами и scripts-facing API.
- `AgentToolRegistry` предоставляет около 50 инструментов: работа со сценой и файлами, компиляция,
  play mode, input/observe/test, генерация ассетов и диагностика.
- Инструменты мутации уже проходят через `CommandDispatcher`, а не меняют ноды напрямую.
- Игровой harness уже умеет детерминированное время, input, assertions, traces, routines, bots и
  screenshots.
- `Pix3AgentBridge` уже является loopback-сервисом с pairing, provider lanes, отдельным MCP token и
  инверсным tool relay между локальным агентом и браузером.
- Remote-preview protocol уже содержит полезные транспортные примитивы: бинарные payload,
  `file-request`, хеши, logs, status, metrics и screenshots.
- Однако `AgentToolRegistry` сейчас зависит от `appState`, editor tabs, Flow stage, Studio viewport,
  selection/peek и editor play-session. Это API встроенного редактора, а не самостоятельный
  headless authoring API.
- `ProjectStorageService` одновременно решает local/cloud/collaboration и UI refresh; его нельзя
  напрямую считать универсальным workspace adapter.

## 3. Главные архитектурные решения

### 3.1 Один bridge, не второй локальный daemon

На первом этапе расширить существующий `tools/pix3-agent-bridge`, а не создавать отдельный сервис.
Внутри одного executable держать изолированные модули:

```text
Pix3AgentBridge
├── provider proxy       существующий
├── local-agent lanes    существующие Claude / Codex / agy
├── MCP tool relay       существующий
├── workspace host       новый
├── browser manager      новый
└── session broker       новый
```

Граница должна позволять позже вынести browser/workspace hosting в отдельный процесс без изменения
agent tool protocol. Отдельный daemon оправдан только при появлении удалённых runners, контейнерного
исполнения или несовместимого жизненного цикла/модели безопасности.

### 3.2 Bridge — control plane, браузер — execution plane

Bridge имеет право:

- открыть явно разрешённую project directory;
- безопасно читать и атомарно записывать файлы внутри неё;
- запускать, контролировать и перезапускать Chromium;
- создавать сессии и capability tokens;
- передавать tool calls, бинарные файлы и артефакты;
- сохранять логи, screenshots и build outputs.

Bridge не имеет права:

- парсить или мигрировать `.pix3scene`;
- знать типы нод и property schemas;
- самостоятельно реализовывать scene mutations;
- компилировать Pix3 scripts альтернативной реализацией;
- собирать экспорт собственной логикой.

Эта семантика остаётся в общем браузерном authoring/runtime-коде.

### 3.3 Не использовать PWA state как API

Выделить явную сессию вместо глобального UI-контекста:

```ts
interface AuthoringSession {
  readonly id: string;
  readonly project: ProjectContext;
  readonly workspace: WorkspaceAdapter;
  readonly activeScenePath: string | null;
  readonly revision: number;
  readonly runner: RuntimeSession | null;
}
```

Headless tools принимают явные `sessionId`, `scenePath` и при мутациях ожидаемую `revision`. Selection,
tabs, dock layout, Peek и Flow-stage не являются частью обязательного authoring contract.

### 3.4 Общая семантика мутаций

Структурные изменения не должны сводиться к произвольной перезаписи YAML. Нужен общий слой
authoring operations, используемый редактором и headless host:

- создание, удаление и перемещение нод;
- обновление schema-backed свойств;
- управление компонентами;
- загрузка, миграция, валидация и сохранение сцен;
- project manifest mutations;
- compile/build validation.

`CommandDispatcher` можно сохранить там, где команды не предполагают UI-контекст. UI-команды не
следует тащить в headless bundle; если текущая команда смешивает намерение и editor state, общую
операцию нужно опустить ниже, а не эмулировать вкладку или selection.

### 3.5 Транзакции вместо editor undo как основной recovery contract

Undo/redo можно сохранить для паритета, но агентскому пайплайну нужнее атомарный контракт:

1. `transaction_begin` фиксирует revision/checkpoint.
2. Агент выполняет одну или несколько мутаций.
3. Host запускает schema, scene, script и project validation.
4. `transaction_commit` публикует новую revision.
5. Ошибка или disconnect вызывают rollback.

## 4. Минимальный набор инструментов

### Project/files

- `project_create`
- `project_open`
- `project_status`
- `project_validate`
- `fs_list`, `fs_read`, `fs_write`, `fs_delete`

### Scene authoring

- `scene_open`, `scene_save`, `scene_tree`
- `node_inspect`
- `node_create`, `node_update`, `node_move`, `node_delete`
- `component_list`, `component_add`, `component_update`, `component_remove`

### Scripts and runtime

- `script_check`, `script_compile`
- `game_start`, `game_restart`, `game_stop`, `game_status`
- `game_input`, `game_controls`, `game_observe`, `game_run`
- `read_logs`, `read_errors`, `runtime_screenshot`

### Build/artifacts

- `build_html`
- `build_report`
- `artifact_list`, `artifact_read`

Генерация изображений, SFX, UI kits и 3D может подключаться позднее как capability-модули. Для
первого вертикального среза она не обязательна.

Не переносить как обязательные инструменты: `get_selection`, editor Peek, управление вкладками,
произвольный `run_command`, edit-mode viewport и команды меню.

## 5. Протокол и транспорт

- MCP остаётся внешним контрактом для локальных агентов.
- Bridge создаёт headless session и соединяет tool relay с browser host через authenticated
  WebSocket.
- Tool schemas версионируются независимо от editor menus и внутренних классов команд.
- Каждый ответ мутации содержит `revision`, `changedPaths`, diagnostics и сохранённость на диск.
- Долгие операции возвращают progress events и отменяемый operation id.
- Из remote-preview protocol можно переиспользовать framing, hash и binary payload helpers, но не
  превращать его в универсальный authoring protocol: игровые preview-сообщения и authoring RPC
  должны оставаться разными версионированными контрактами.

## 6. Workspace и безопасность

Browser-only доступ к произвольной локальной папке требует пользовательского File System Access
разрешения и плохо подходит для полностью автономного запуска. Поэтому локальный bridge служит
workspace adapter, а браузер получает файлы через ограниченный session protocol.

Обязательные ограничения:

- workspace root передаётся явно и канонизируется до запуска сессии;
- каждый file request повторно проверяется на выход через `..`, абсолютный путь, symlink/junction;
- нет произвольного shell tool;
- запись выполняется атомарно через временный файл и rename/replace;
- delete — отдельная capability, журналируется и по возможности восстанавливаем;
- session capability token отдельный от provider pairing token;
- MCP token не даёт доступ к provider secrets;
- bind только на loopback, проверка `Host` и allowlist `Origin` сохраняются;
- одна сессия не может читать workspace другой;
- browser host получает минимальный набор разрешений и отдельный профиль/контекст.

Строгий browser-only режим можно сохранить отдельно: OPFS/cloud workspace и скачиваемый экспорт.
Он полезен для hosted окружения, но не заменяет local workspace host.

## 7. Фазы

### Phase 0 — контракт и seam audit (S)

- Зафиксировать список core и UI-only зависимостей `AgentToolRegistry`.
- Определить `AuthoringSession`, `WorkspaceAdapter`, tool envelope и revision contract.
- Выделить независимые DTO/introspection primitives без импорта editor shell.
- Написать dependency guard: headless entry не импортирует `src/ui`, `EditorTabService`,
  `FlowStageService`, `StudioViewportMountService` и Golden Layout.

### Phase 1 — read-only browser host (M)

- Минимальная HTML entry point без PWA shell.
- Открытие проекта через bridge workspace session.
- Загрузка manifest и сцены настоящим loader/runtime.
- `scene_tree`, `node_inspect`, diagnostics.
- Запуск `SceneRunner`, input, observe, logs/errors и screenshot.

### Phase 2 — authoring mutations and persistence (L)

- Общий authoring-operation слой.
- Node/component/property tools.
- Transactions, revision conflicts и rollback.
- Сохранение `.pix3scene` через настоящий saver.
- Script write/check/compile.

### Phase 3 — build and end-to-end loop (M)

- Использование существующей build model и playable HTML exporter.
- Build report и выдача артефакта через bridge.
- Один воспроизводимый сценарий: template → scene edit → script → play → input/assertion → screenshot
  → export.

### Phase 4 — hardening and parallelism (M/L)

- Несколько изолированных browser sessions.
- Timeouts, crash recovery, cancellation и уборка профилей/артефактов.
- Ограничения CPU/RAM и budgets.
- Capability negotiation для generation lanes.
- Сравнение результатов PWA и headless host на одних fixture projects.

## 8. Критерии готовности MVP

- Headless entry не загружает editor UI chunks.
- Агент создаёт проект из шаблона без directory picker.
- Агент создаёт и меняет ноды через общий mutation gateway.
- Скрипт компилируется тем же compiler path, что в PWA.
- Игра запускается в Chromium настоящим `SceneRunner`.
- Проверка включает state observation и независимо полученный screenshot.
- Playable HTML собирается существующим exporter path.
- Результат открывается в PWA без миграции или починки.
- Одинаковая сцена даёт эквивалентный authored graph, runtime graph и build reachability в обоих
  host-режимах.
- Browser crash или оборванная транзакция не оставляют частично записанный проект.

## 9. Анти-скоуп

- Второй формат проекта или сцен.
- Node.js-реализация SceneManager/SceneRunner.
- Эмуляция editor tabs, selection и layout ради совместимости старых handlers.
- Управление PWA через координатные клики.
- Произвольный shell/filesystem доступ модели.
- Замена PWA-редактора.
- Удалённый multi-tenant runner до доказанного локального MVP.

## 10. Открытые решения перед разморозкой

1. Где провести package boundary общего authoring core: отдельный package или editor-neutral модули
   в `src/core`/`src/services`.
2. Нужен ли headless host в production build либо это отдельная локально собираемая entry point.
3. Какой процесс запускает Chromium: bridge напрямую или внешний orchestrator передаёт подключённую
   страницу.
4. Нужен ли Playwright как runtime dependency bridge или достаточно Chrome DevTools Protocol.
5. Какая часть `CommandDispatcher` остаётся общей, а какая заменяется более узким Authoring API.
6. Формат checkpoints: in-memory snapshot, shadow directory или журнал обратимых файловых операций.
7. Требуется ли с первого MVP облачный workspace или только локальная папка + OPFS fixture mode.
8. Как версионировать tool protocol относительно версии runtime/project schema.

Рекомендуемый первый эксперимент: добавить только read-only headless entry и подключить её к
существующему bridge tool relay. Если сцена запускается, наблюдается и фотографируется без импорта
editor shell, архитектурная граница доказана; только после этого переносить mutations и exporter.
