# Flow: пустой рецепт + Play запускает текущую сцену

Источник: замечания пользователя по рецептам (2026-08-26) + архитектурный разбор (Fable).
Правит два симптома быстрого прототипирования: (1) неподходящую идею разворачивает в готовую игру,
которую агент сначала сносит; (2) при запуске — в т.ч. в вайб-режиме — стартует меню, а не кор-геймплей.

## 0. Что оказалось при проверке кода

Формулировка «вынести меню в отдельную сцену» уже выполнена у **5 из 7** шаблонов: все четыре
`recipe-*` и `minigame-2d` несут `scenes/menu.pix3scene`, `entryScene: scenes/menu.pix3scene` и
`user:MenuFlow` → `changeScene('res://scenes/main.pix3scene')`. Реальная утечка — в командах Play:

1. **`pix3-flow-shell` дёргает `game.start-main`** и на старте стейджа, и с кнопки Play. Команда
   резолвит `manifest.defaultExportScenePath` (= меню) и зовёт `ensureSceneActive` — то есть
   **переключает активную сцену редактора на меню**.
2. **Flow-бутстрап не открывает startup-сцену.** `ProjectLifecycleService.createProject` зовёт
   `projectService.openStartupScene()`, а `PrototypeBootstrapService.expand` идёт напрямую в
   `createNewProjectWithOptions`. Значит в свежем Flow-проекте активной сцены нет вообще, и первое,
   что её задаёт, — Play, открывающий меню. Дальше **все правки агента едут в сцену меню**:
   `AgentToolRegistry.ensureActiveScene` со своим «предпочитать `scenes/main.pix3scene`» срабатывает
   только когда графа нет вовсе, а он уже есть.
3. **У `StartGameCommand` (`game.start`) нет гарда на активную сцену** — preconditions проверяют
   только `isPlaying`. Просто переключить Flow на него нельзя: на первом старте он включит play-режим
   без сцены, `GamePlaySessionService` уйдёт в `abortFailedStart()`, а retry-цикл `startStage` будет
   это частично маскировать.
4. **Экспорт уже предпочитает активную сцену**: порядок в `ProjectBuildService.resolveEntryScenePath`
   — requested → active → configured → first. Поэтому фаза D экспорт не задевает.
5. `recipes.spec.ts` затаскивает в полный контракт любую папку с префиксом `recipe-` — новый
   `recipe-blank-2d` получает пиннинг (секции recipe.md, ≥1 тюнабл, `registerGameDebug`, `game-root`,
   формат рутин) бесплатно. `empty-`-шаблоны от контракта освобождены — это и причина не промотировать
   `empty-2d`.
6. `RECIPE_CATALOG` и `RECIPE_TEMPLATE_ALIASES` — module-private; для гарда когерентности их надо
   экспортировать.

## A. Пустой рецепт: один новый шаблон `recipe-blank-2d`

**3D-блэнк не нужен**: `recipe-scene-3d` (→ `playable-3d`) уже описан как «a bare 3D stage».

**Отклонено — промотировать `empty-2d`/`empty-3d` в каталог.** Это три ноды, ноль скриптов,
ландшафт 1920×1080 и освобождение от контракта по префиксу. Агент получает: нет `registerGameDebug`
(любая верификация деградирует до скриншотов — ровно тот провал, который повторяется в eval-истории),
нет интент-команд, нет result-overlay, нет тюнаблов (темы из `THEME_TUNABLES` молча не работают),
нет формы `design/tests`. Первый инкремент уходит на скаффолдинг, который остальные рецепты дают
даром; плюс пришлось бы распутывать `empty-`-исключение в спеке.

**Отклонено — «recipe.md поверх empty-2d» без скриптов.** Тюнаблы обязаны указывать на реальные
node/property, так что декларировать можно только `bgColor`; секции `## Verify` нечего проверять.
Половина пользы за большую часть стоимости авторинга.

Принцип: **везём всё, что нужно для *исхода* игры, и ничего, что подразумевает *механику*.** Первый
инкремент на блэнке = та самая механика, которая делает игру этой игрой, **включая управление**.

```
src/templates/projects/recipe-blank-2d/
  template.yaml       # id: recipe-blank-2d, title: Blank 2D, 2d, universal, 1080×1920,
                      # БЕЗ entryScene, order: 64
  cover.png
  files/
    README.md
    design/recipe.md
    design/tests/reachability.json        # proven: []
    design/tests/routines/restart.json    # интент `restart`, зарегистрированный GameRules
    scenes/main.pix3scene                 # единственная сцена
    scripts/GameRules.ts
    scripts/ScoreHud.ts
```

Дерево сцены (ids намеренно совпадают с ареной — наработки агента и рутины переносятся дословно):

```
game-root            Group2D, stretch, components: [user:GameRules]
├─ game-background   ColorRect2D (stretch)          ← тюнабл bgColor
├─ board             Group2D — игровое поле; механика строится ВНУТРИ него
│  └─ board-floor    ColorRect2D                    ← тюнабл boardColor
├─ hud               CanvasLayer2D, components: [user:ScoreHud]
│  ├─ score-label    Label2D "SCORE 0"
│  ├─ time-label     Label2D (скрыт, пока timeLimitSec = 0)
│  └─ lives-bar      Group2D
└─ result-overlay    Group2D, visible: false
   ├─ result-dim     ColorRect2D
   ├─ result-label   Label2D
   └─ retry-button   Button2D
```

Нет `player`, нет `spawner-*`, нет префабов, нет `menu-button` (меню-сцены тоже нет).

`GameRules.ts` — обрезанная копия аренной: то же имя класса, те же сигналы (`score-changed`,
`lives-changed`, `time-changed`, `game-won`/`game-lost`), то же владение `result-overlay` через
`finish(won)`, `registerGameDebug` со снапшотом `phase/score/lives/timeLeft`,
`scene.commands.register('restart', …)`. Публичный API для скриптов агента: `addScore(n)`,
`loseLife(n)`, `finish(won)`. Схема: `winMode`, `targetScore`, `timeLimitSec`, `startingLives`.
`ScoreHud.ts` — аренный, сигнало-driven.

`design/recipe.md` — все семь обязательных секций. Тюнаблы (удовлетворяют `>0` в спеке и включают
темы; необъявленный `bloomIntensity` из пака деградирует в заметку брифа, как и задумано):

```yaml
tunables:
  winMode:       { node: game-root, component: "user:GameRules", property: winMode, default: score }
  targetScore:   { node: game-root, component: "user:GameRules", property: targetScore, min: 1, max: 99999, default: 10 }
  timeLimitSec:  { node: game-root, component: "user:GameRules", property: timeLimitSec, min: 0, max: 600, default: 0 }
  startingLives: { node: game-root, component: "user:GameRules", property: startingLives, min: 1, max: 20, default: 3 }
  bgColor:       { node: game-background, property: color, default: "#12141c" }
  boardColor:    { node: board-floor, property: color, default: "#1d212e" }
```

`## Placeholders` — таблица без строк плюс фраза «none — генерируй спрайт под сущность по мере её
появления» (`parseRecipePlaceholders` вернёт `[]`, тинтовка no-op). `## Extension points` содержит
явный late-step: «чтобы добавить меню — создай `scenes/menu.pix3scene` с `MenuFlow`, зовущим
`scene.changeScene('res://scenes/main.pix3scene')`, и пропиши Project Settings → Default Export
Scene Path». Меню не пред-оплачивается никогда.

## B. Когда планировщик выбирает блэнк

Новая запись в `RECIPE_CATALOG` (после bouncer, перед playable-ad): блёрб говорит, что механик нет,
что bookkeeping/HUD/win-lose уже есть, и перечисляет попадание — grid/turn-based движение (snake,
sokoban, match-3), word/card/board, билдеры, физические конструкторы, idle; финальная фраза: «снести
неверную механику дороже, чем построить на блэнке».

Две правки существующих текстов:

- **Убрать `snake` из блёрба арены и из `description` в `recipe-arena-2d/template.yaml`.** Непрерывное
  управление указателем + сыплющиеся спавнеры — противоположность grid-step-and-grow; именно этот
  «snake через extension points» и дал пользователю поле с падающими кружочками. Остаются доджеры,
  коллекторы, top-down выживание, раннеры.
- В `PLANNER_SYSTEM_PROMPT`, сразу после выбора `recipeId`, одно правило: жанровый рецепт берётся
  только если его механика **выживает** первый инкремент; если механику пришлось бы удалять или
  заменять — берётся `recipe-blank-2d` (2D) / `recipe-scene-3d` (3D). «Расширять лучше, чем сносить,
  но сносить хуже, чем начать с блэнка.» Плюс поправить строку про «рецепт уже везёт играбельный
  скелет: меню, игру, win/lose, работающее управление…» — у блэнков нет ни управления, ни меню, и
  правило «не писать „управление“ отдельным шагом» действует только для не-блэнков.

Фолбэки расщепляются по типу сигнала:

- **`FALLBACK_RECIPE_ID` остаётся `recipe-arena-2d`** для мусорного пути (нет `recipeId`, ответ не
  парсится, `fallbackBrief`). Об идее не сказано ничего, вероятностная масса — сбои провайдера, а
  живой стейдж с первого кадра — инвариант дизайна.
- **Выдуманный id → блэнк.** В `validateBrief`: не-3D выдуманный id → `recipe-blank-2d` (было арена);
  выдуманный id, матчащий `/3d/i` → `recipe-scene-3d` (было `recipe-grid-3d`). Выдуманный id — это
  утверждение «каталог не подошёл». Комментарий на `FALLBACK_3D_RECIPE_ID` переписать под эту вилку:
  «то, что играет» — правильный ответ на молчание и неправильный на выдуманный id.
- Фолбэк `resolveTemplateId` (планировщик назвал каталожный id, а шаблона нет) остаётся на арене —
  это проблема установки, а не формы идеи.

**Confidence-поле в брифе — отклонено** как оверинжиниринг: выбор сам кодирует уверенность, порог
пришлось бы калибровать под каждую bridge-модель, а единственное действие («взять блэнк») уже
выразимо напрямую. Если промахи вылезут в eval — дешевле однострочный `recipeWhy` в брифе для
чтения агентом, без ветвлений (фаза 3).

## C. Меню вне main

- `playable-2d` / `playable-3d` — `intro-overlay` и `end-screen` **остаются инлайн**. Тап-гейт там —
  требование анлока аудио в ad-контейнере, а не хром, и он обязан быть в загружающейся сцене; плейбл
  односценовый по бюджету; `intro-overlay` — это две ноды, сносить нечего; ids запиннены конфигом
  `GameFlow` и контрактом. Вентиль для прототипирования (фаза 2): булев `skipIntro` в схеме `GameFlow`
  + одноимённый тюнабл в recipe.md обоих плейблов, дефолт `false`.
- **Блэнк меню-сцену не везёт** (см. A). Без `entryScene` спред в `buildManifest` не положит
  `defaultExportScenePath`, и резолвер экспорта уедет на active → first, то есть на
  `scenes/main.pix3scene` — экспортированная игра всё равно грузится верно.
- Переименований id нигде нет; обещания стабильных id из `flow-recipes-contract.md` §4 целы.

## D. Play запускает текущую сцену

«Запускать entry-сцену не двигая активный таб» — **отклонено**: play-режим структурно привязан к
`appState.scenes.activeSceneId` (`GamePlaySessionService` зовёт `runner.startScene(activeSceneId)`),
от этого зависят профайлер, `game_observe`, debug-bridge, Flow-стейдж. Отдельный путь загрузки
рассинхронизировал бы всех, кто резолвит «активный граф». Поэтому `game.start-main` сохраняет смысл
«полный прогон, и редактор идёт за ним», а меняется то, **откуда его дёргают**.

1. `src/features/scripts/play-workspace.ts` — новый экспорт
   `resolveGameplayScenePath(state): string | null`: дескриптор с путём `scenes/main.pix3scene` →
   литерал `res://scenes/main.pix3scene`, если проект его везёт → первый дескриптор →
   `manifest.defaultExportScenePath` **последним**. Порядок намеренно предпочитает геймплей
   entry-сцене (та же логика, что в `AgentToolRegistry.ensureActiveScene`).
2. `src/features/scripts/StartGameCommand.ts` —
   - precondition `project.status === 'ready'` (сейчас нет, у `game.start-main` есть);
   - в `execute`, если `!activeSceneId`: резолв через (1) и `await ensureSceneActive(...)`;
   - затем гард как в `StartMainSceneGameCommand`: нет активной сцены → `throw` **до**
     `SetPlayModeOperation`. Закрывает и предсуществующую дырку «play включился без сцены».
   - Когда активная сцена есть — `ensureSceneActive` не зовётся вовсе: «не двигаем таб пользователя».
3. `src/ui/flow/pix3-flow-shell.ts` — оба дёрганья (`startStage()` и кнопка стейдж-бара) переходят с
   `'game.start-main'` на `'game.start'`. Первый старт свежего Flow-проекта (сцены нет) отработает
   через фолбэк из (2) и покажет **геймплей**; заодно цель правок агента становится геймплейной.
   `restartStage` (`game.restart`) не меняется — он рестартует то, что бежит.
4. Пункты меню Project остаются оба, переименованные под новый центр тяжести: `game.start` →
   «Play Scene», `game.start-main` → «Play Game (Entry Scene)». Схлопывать нельзя: полный прогон —
   реальная нужда (проверить переход меню→игра). Тулбар Studio уже на `game.start`.
5. Не трогаем (проверено): `PreviewHostService` (уже active-first), `ProjectBuildService` и
   экспорт-команды, агентский `play_start`, `AgentToolRegistry.ensureActiveScene`.

Фаза 2, полировка: во стейдж-баре Flow вторичное действие «Play from entry scene» (`game.start-main`)
для проверки перехода меню→игра внутри вайб-режима.

## E. Миграция и гарды

Правятся существующие спеки:

| Спека | Почему |
| --- | --- |
| `src/templates/projects/recipes.spec.ts` | `CATALOG_TEMPLATES` += `recipe-blank-2d` (префиксный тест иначе упадёт); дальше весь контракт бежит по новому шаблону |
| `src/services/flow/PrototypeBootstrapService.spec.ts` | фолбэк на выдуманный id → блэнк; выдуманный 3D id → `recipe-scene-3d`; тесты, пиннящие текст промпта и каталог |
| `src/services/project/ProjectTemplateScenes.spec.ts` | новая `main.pix3scene` должна парситься/валидироваться; у блэнка нет `entryScene` |

Новые гарды:

1. **Когерентность каталог↔шаблоны**: каждый id из `RECIPE_CATALOG` через `RECIPE_TEMPLATE_ALIASES`
   указывает на существующую папку шаблона, и каждый шаблон `recipe-*` присутствует в каталоге.
   Требует экспорта обоих const. Именно этот гард поймал бы «`empty-2d` недостижим из Flow».
2. **«В геймплейной сцене нет меню-хрома»**: для каждого каталожного шаблона, объявляющего
   `entryScene`, в `files/scenes/main.pix3scene` нет ноды с компонентом `user:MenuFlow`. Плейблы без
   `entryScene` исключены по построению — их `intro-overlay` санкционирован.
3. `src/features/scripts/StartGameCommand.spec.ts` (новая): нет активной сцены + есть дескриптор
   `scenes/main.pix3scene` → он активируется до включения play; сцен нет вовсе → throw и `isPlaying`
   остаётся false; активная сцена есть → `ensureSceneActive` не вызывается.
4. Пин на Flow: исходный скан (по образцу `color-convention.spec.ts`), что
   `src/ui/flow/pix3-flow-shell.ts` не содержит литерала `'game.start-main'`.

Доки: в `.plans/done/flow-recipes-contract.md` §1 добавить `recipe-blank-2d` (анатомия: нет меню-сцены,
нет плейсхолдеров, скрипты только bookkeeping) и переписать абзац про фолбэк под вилку
молчание-vs-выдуманный-id. `docs/` не трогаем — это редактор и шаблоны, не поверхность движка.

**Существующие проекты миграции не требуют** — меняются шаблоны и команды, ни один файл сцены не
перезаписывается. Что они наследуют: Flow-Play запускает открытую сцену (их `defaultExportScenePath`
по-прежнему рулит экспортом и «Play Game (Entry Scene)»). Видимое изменение одно: при открытии старого
Flow-проекта стейдж стартует геймплей, а не меню.

## Фазы

**Фаза 1 — минимум, закрывающий обе жалобы**

- [x] D: `resolveGameplayScenePath` + фолбэк/гард в `StartGameCommand` + два литерала в
      `pix3-flow-shell` + переименование пунктов меню + `StartGameCommand.spec.ts`
- [x] A: авторинг `src/templates/projects/recipe-blank-2d/**` (+ `cover.png` в языке остальных карточек)
- [x] B: запись в каталог, де-snake арены, правило в `PLANNER_SYSTEM_PROMPT`, вилка фолбэка в
      `validateBrief`, grid-пример в чипах welcome-экрана
- [x] E: правка существующих спек (+`ProjectTemplateScenes`), гарды 1–2, обновление `flow-recipes-contract.md`

**Фаза 2 — полировка** (сделана 2026-08-28; живьём не проверялась — вся закрывается тестами)

- [x] вторичное «Play from entry scene» в стейдж-баре Flow — кнопка рядом с Play/Restart, видна
      **только** когда проект объявляет `defaultExportScenePath` (без него `game.start-main`
      вырождается в «сыграть активную сцену», то есть в ту же кнопку Play). Ошибку кладёт в тот же
      `stageError`. **Правка по ревью:** первая версия пряталась ещё и при `isPlaying` — а стейдж
      автостартует, то есть кнопка исчезала ровно тогда, когда нужна; теперь клик сам зовёт
      `game.stop` перед стартом, что и значит «прогнать заново, с начала»
- [x] `skipIntro` в `GameFlow` + тюнабл в recipe.md обоих плейблов — общий `openTheGate()` для тапа
      и для вентиля (иначе два чуть разных понятия «run начался»), `restart()` его уважает (иначе
      рутина, рестартящая между проверками, встаёт перед гейтом, который никто не тапнет), флаг
      уехал в снапшот — прогон без гейта обязан **сказать** об этом
- [x] свести `AgentToolRegistry.ensureActiveScene` на `resolveGameplayScenePath` — попутно из
      порядка ушёл `manifest.defaultExportScenePath`: на рецептном проекте это МЕНЮ, и
      восстановление на меню молча переадресует туда все последующие правки агента
- [x] гард 4 — сильнее, чем задумывался: не «нет литерала в файле», а «литерал ровно один, и он
      объявление `ENTRY_SCENE_PLAY_COMMAND`» + «в `startStage()` его нет» + «primary-кнопка на
      `game.start`» (`src/ui/flow/flow-stage-launch.spec.ts`). Простой скан «нет литерала» после
      добавления вторичной кнопки стал бы ложно-красным, а ослабленный до «есть где-то» — пустым.
      Сверху три поведенческих теста в `pix3-flow-shell.spec.ts` (авто-старт не зовёт entry-сцену,
      клик по вторичной кнопке зовёт, без `defaultExportScenePath` кнопки нет)
- [x] паритет bookkeeping (GameRules/HUD) для `playable-3d` — `GameRules.ts` + `ScoreHud.ts` +
      `score-label`/`time-label`/`lives-bar` в сцене. Две развилки решены против «скопировать
      блэнковый GameRules целиком», потому что на `hud-root` уже живёт `GameFlow`:
      **(1)** второй `registerGameDebug` МОЛЧА вытеснил бы первый (глобал держит один провайдер) и
      унёс бы с собой все проверки intro/end — поэтому у 3D-правил провайдера нет, они отдают
      `bookkeeping()`, который подмешивается в снапшот `GameFlow`;
      **(2)** второй result-overlay дал бы плейблу два способа закончиться и ни одного способа
      согласовать, какой случился — поэтому `GameRules.finish(won)` пишет текст исхода и диспатчит
      команду `finish` самого `GameFlow`. Связь в обе стороны утиная: удали любой из двух скриптов —
      второй продолжает работать. `GameFlow.restart()` зовёт `resetRun()`, иначе рестарт возвращал
      бы гейт, но не счёт. Паритет сделан ТОЛЬКО для `playable-3d`: `playable-2d` — рекламный
      плейбл, роль «2D с нуля» в каталоге занимает `recipe-blank-2d`, у которого bookkeeping свой.
      **Две правки по ревью, обе — тихие отказы:** правила тикали с загрузки сцены, поэтому прогон
      `survive` + `timeLimitSec` выигрывался, пока тап-гейт ещё на экране (лечится `startRun()` из
      `openTheGate()` и флагом `startWithFlow`); и `GameFlow.finish()` не сообщал правилам, что
      прогон окончен, поэтому снапшот отдавал `phase: ended` с `outcome: null`, лейбл исхода
      оставался авторским, а лимит времени добивал ВТОРЫМ финалом уже за end-screen (лечится
      `endRun(won?)`, который при отсутствии вердикта читает собственное условие победы). Контракт
      двух скриптов исполняется в `src/templates/projects/playable-3d-bookkeeping.spec.ts` —
      единственное место, где скрипты шаблона вообще запускаются
