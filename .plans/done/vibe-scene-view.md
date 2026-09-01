# Vibe: edit-вьюпорт в стейдже (выбор объектов при остановленной игре)

**Статус:** выполнено (2026-09-01). Реализация — коммит `01d842f1`, хвост «несохранённые правки
гизмо» закрыт 2026-09-01. Закрывает открытый вопрос §10 п.1
[prompt-to-playable-flow.md](../prompt-to-playable-flow.md) — «монтируется ли `editor-tab`
вне Golden Layout»: монтируется, в `standalone`-режиме, без записи в `appState.tabs`.

## Задача

Во Vibe стейдж показывает только живую игру. Когда игра остановлена, смотреть не на что и
выбрать объект сцены нечем — а выбранный объект это ровно то, чего не хватает агенту, чтобы
«поправь вот этот блок» работало без описания словами.

Стейдж получает третий вид: `Game | Scene | Idea`. Остановка игры перекидывает на **Scene** —
редакторский вьюпорт с навигацией, пикингом и гизмо. Play возвращает на Game.

## Почему это дёшево

Половина фичи уже существует и не соединена:

- **Выделение уже уходит в контекст агента.** `AgentChatService.buildSystemPrompt`
  ([AgentChatService.ts:1894](../../src/services/agent/AgentChatService.ts#L1894)) кладёт
  `appState.selection.nodeIds` в живой блок «Project context». Новой проводки не нужно.
- **Граф сцены во Vibe загружен.** Flow-ветка `ensureSceneActive()`
  ([play-workspace.ts:44](../../src/features/scripts/play-workspace.ts#L44)) грузит сцену в
  `SceneManager` и ставит `activeSceneId`, намеренно не создавая таба.
- **Вьюпорт в Vibe-сессии уже поднимается** — `StudioViewportMountService` строит Studio-ветку
  оффскрин ради `viewport_screenshot`. Показать её в стейдже нельзя (это вся Studio целиком),
  но она доказывает, что рендерер в такой сессии живой.

## Две вещи, без которых фича мертва

1. **Рендерер отказывается рисовать во Flow.** `ViewportRenderService.isWorkspaceHidden()`
   ([:1902](../../src/services/viewport/ViewportRenderService.ts#L1902)) возвращает `true` при
   `workspaceMode === 'flow'` и подавляет и rAF-цикл, и синхронный `requestRender()`.
   Нужен флаг `ui.flowSceneViewVisible`.
2. **Канвас не возвращается в Studio сам.** `attachToHost` зовётся только из
   `editor-tab.syncActiveState` по подписке на `appState.tabs`; переключение Vibe→Studio
   анмаунтит Flow-шелл, и общий канвас остаётся ребёнком мёртвого узла. Нужен явный reclaim
   по смене `workspaceMode`.

## Решения

**Гейтинг табов — `standalone`-флаг, не фейковая tab-запись.** Все ~10 гейтов в
[editor-tab.ts](../../src/ui/viewport/editor-tab.ts) — один паттерн
`appState.tabs.activeTabId !== this.tabId`, подменяется геттером `isActiveTab`.
Отклонённая альтернатива ломается конкретно: `openResourceTab` захватывает
`sessionProjectId` и начинает персистить табы из Vibe-сессии, а при следующем входе в Studio
`restoreProjectSession` создаёт **второй** `pix3-editor-tab` с тем же `tabId` — оба проходят
гейт, оба зовут `attachToHost`, канвас пинг-понгом ходит между стейджем и доком.

**Арбитраж за общий канвас.** Не-standalone таб не аттачится, пока
`workspaceMode === 'flow' && flowSceneViewVisible` — иначе скрытый оффскрин-Studio-таб агента
крадёт канвас у видимого вьюпорта на любой мутации `appState.tabs`. Видимый всегда побеждает;
скриншоты не страдают, канвас общий. `StudioViewportMountService` менять не надо: он
коротко замыкается на `getCanvasElement()`, то есть видимый маунт его просто отменяет.

**Гизмо оставляем** (undo работает), но Инспектора и дерева во Vibe нет — поэтому полоска с
именем выбранной ноды и чип `vibe-selection` в композере: пользователь видит, что агент знает
про выбранный объект.

## Файлы

| Файл | Что |
|---|---|
| `src/state/AppState.ts` | `ui.flowSceneViewVisible` (UI-флаг, пишется владельцем напрямую) |
| `src/services/viewport/ViewportRenderService.ts` | `isWorkspaceHidden()` = `flow && !flowSceneViewVisible` |
| `src/ui/viewport/editor-tab.ts` | `standalone`, геттер `isActiveTab`, скрытый тулбар, арбитраж, reclaim, `zoomAll` на первый аттач |
| `src/ui/flow/pix3-flow-scene-view.ts` (+`.css`) | обёртка: лайфсайкл флага, полоска выбора, чип `vibe-selection` |
| `src/ui/flow/pix3-flow-shell.ts` (+`.css`) | третий вид, ленивый маунт, автопереключение stop→Scene / play→Game |

Автопереключение глушится вокруг `startFromEntryScene()` — он останавливает и тут же
запускает игру, иначе Scene мигал бы. `game.restart` (перезапуск после хода агента)
`isPlaying` не трогает, так что мигания там нет.

## Хвост: несохранённые правки гизмо — закрыто

Правки, сделанные гизмо во Vibe, жили только в памяти: Ctrl+S нет, dirty-индикатора нет, а
Download HTML собирается из **файлов** — то есть скачанный HTML не содержал того, что человек
только что подвинул.

Write-back живёт в `pix3-flow-scene-view.ts` (`armSceneSave` / `flushSceneSave` / `saveDirtyScene`),
и три решения в нём неочевидны:

- **Триггер — `descriptor.isDirty`, а не `appState.history`.** Сохранение снимает флаг, поэтому
  снятый флаг не может перевзвести таймер: петля «save → запись в историю → save», которую даёт
  подписка на историю, невозможна по построению.
- **`OperationService.invoke`, а не `SaveSceneCommand`.** Команда пушит сохранение в undo-стек, а
  Ctrl+Z во Flow работает (`KeybindingService` не смотрит на `workspaceMode`) — одна запись на
  автосейв означала бы **два** Ctrl+Z на каждую правку гизмо, причём второй откатывал бы
  сохранение, которого пользователь не видит. Предусловия команды (проект `ready`, backend не
  `cloud`, путь `res://`) продублированы в `dirtySceneId()`; cloud-отказ несущий — collab
  синхронизируется через Yjs, и запись файла мимо синка ничего не персистит.
- **Флаш на передаче стейджа.** Дебаунс 1200 мс, но и `active → false` (переключение на Game), и
  `disconnectedCallback` (выход из Vibe) выгоняют отложенную запись немедленно — иначе именно на
  переходе «подвинул → Play → Download HTML» правка и терялась бы. Флаш ничего не рапортует:
  расписка в полоске поднималась бы из `updated()`, то есть изнутри апдейт-цикла Lit.

Расписка («Saving…» → «Saved», 2 с) отвечает на единственный реальный вопрос — «моя правка уже в
файле?» — и отсутствует в DOM всё остальное время.

## Незакрытое

- Инспектора во Vibe по-прежнему нет: подвинуть можно, значение ввести нельзя. Заведено пунктом в
  [TODO.md](../TODO.md), раздел UX / UI.
