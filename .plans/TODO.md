# TODO

Операционный список задач. Стратегия и обоснование приоритетов — в [ROADMAP.md](ROADMAP.md);
крупные фичи имеют собственные спеки в этой же папке (см. [README.md](README.md)).

**Статусы перепроверены по исходникам:** commit `1afac13`, 2026-08-01; выборочно — 2026-08-28
(инертная нода, `InstancedMesh3D`-материал, FPS-поле Sprite Editor: закрыты; фаза 2
[done/flow-blank-recipe-and-current-scene-play.md](done/flow-blank-recipe-and-current-scene-play.md)
закрыта целиком); 2026-09-01 — «camera/light target-гизмо» (статус был просрочен, гизмо таскаются)
и `str_replace` на CRLF (починен).

## all

- [ ] move to constructor injection in classes

## Редактор (Editor)

- [x] add transform animation timeline editor for nodes and tween animation support (Сложность: L)
- [x] add animation editor for animated sprites (Сложность: L) — _flipbook-редактор `src/ui/animation-editor/` + auto-slice; см. [done/sprite_animation_update.md](done/sprite_animation_update.md). **Заменён** единым Sprite Editor, строкой ниже_
- [x] unified Sprite Editor (Сложность: L) — _[done/sprite-editor-design.md](done/sprite-editor-design.md). Все фазы закрыты: 1–3 (единый шелл `pix3-sprite-editor-panel` на картинку и `.pix3anim`, старая флипбук-панель удалена, генерация вынесена в док-панель `Generate`), рантайм R1/R2 (в npm с 1.3.0), §9.9/§9.10, фаза 5 (§9.11 place mode + вставка из истории) и фаза 6 power tools целиком (§9.12: trim frames, auto collision polygon, chroma key, bulk frame ops, video import). §9.13 — журнал живых проверок трёх путей, которые раньше не исполнялись_
- [x] add image/asset library/store (Сложность: M) — _[asset-library.md](asset-library.md) Phase 1 + [asset-store-admin.md](asset-store-admin.md) фазы A–D; остались team-scope и Phase E_
- [ ] **режим Flow — «промпт → играбельный прототип → ссылка»** (Сложность: L) — _фазы 0 и 1 сделаны и проверены живьём на двух прототипах (змейка + пинбол), ветка `feat/flow-mode`: закалка харнесса (`ask_user`, гард перезаписи, контекст-ватерлинии, таймаут, advisor-триггер, гарантированный финальный ответ), `workspaceMode` + `pix3-flow-shell` + ленивый Golden Layout, play без табов, `PrototypeBootstrapService` + prompt-hero, три рецепта (`recipe-arena-2d`/`bouncer-2d`/`tapper-2d`) + `playable-2d` в каталоге. Журнал и найденные баги — [prompt-to-playable-flow.md](prompt-to-playable-flow.md) §11, контракт рецептов — [done/flow-recipes-contract.md](done/flow-recipes-contract.md). **Третий догфудинг (крестики-нолики на Haiku):** после фикса `compile_scripts` (тайп-чек внутри) ход на инкремент упал с 40 итераций до 17. Починены наблюдаемость (`hiddenByAncestor` + отказ тапать ноду вне экрана, forward-DFS поиск по имени, `ambiguousTargets`, ретайр протухших диагностик), loop-breaker (прощает повтор после мутации) и verify-гейт (видит `str_replace`). Найден и закрыт **системный класс**: 31 свойство в 16 типах нод, где `setValue` перерисовывает, а присвоение из скрипта — нет; механизм `installReactiveSchemaProperties` + страж от дрейфа, §11.4. **Наблюдения §11.3 закрыты** (§11.6): `str_replace` возвращает окрестность правки, `fs_read` отдаёт файл до 16 КБ целиком вместо страниц, `create_node` предупреждает о дубликате имени, смена сцены больше не читается как `NO ACTIVITY` (`sceneChanged` + вердикт `SCENE CHANGED`), `scene_tree` сообщает `staleWhilePlaying`, контракт RETRY/`GameRules` описан в рецептах; протухание `liveScene()` перепроверено и не воспроизводится. **Хвосты §11.9 закрыты 2026-08-29** (§11.10 плана): `hitstop` каждый кадр воспроизведён и починен (одна заморозка не длиннее самого длинного одиночного запроса + одно предупреждение), расхождение `tsconfig` признано намеренным (Lit требует `false`, потребитель компилирует рантайм своим конфигом) и обезврежено ремонтом перекрытого аксессора в `installReactiveSchemaProperties`, «грязная доска» оказалась уже закрытой `precondition-already-met` в `game_run`, цель «4 КБ на рецепт» снята как до-измерительная — вместо неё кэп 10 000 разведён с бюджетом 8 500 и обе константы съехались в `recipe-contract.ts` (bouncer весил 7 996 при кэпе 8 000). **Осталось:** фаза 2 (публикация: сервер `core/publish/`, отдельный origin, `GamePublishService`), фаза 3 (`AssetJobQueueService` + `queue_asset`, поиск по библиотеке перед генерацией, рецепты `platformer-2d`/`playable-ad`) и фаза 4 (стриминг дельт в чат, инспектор-лайт по тюнаблам, remix/fork). **Порядок:** сначала восемь находок замера (раздел ниже) — по [done/vibe-vs-chat-gap.md](done/vibe-vs-chat-gap.md) рычаги идут покрытие → темп → шеринг, то есть публикация последней_
- [x] **UI Kit Forge: разбор на модули — самодостаточный инструмент, шаблоны, префабы** (Сложность: L) — _**сделано** на ветке `feat/uikit-forge-core`: ядро `src/services/uikit/`, два хоста (страница + вкладка «UI Kit»), кит в проект (`design/ui-theme.json`, `design/ui-kit.json`, `sprites/ui/<kitId>/`), префабы `prefabs/ui/`, команда `properties.apply-uikit-skin`, тул `skin_ui`, экспандер T0 скиннит рецепт без хода агента. Итог и остаток — §10 плана [done/uikit-forge-modularization.md](done/uikit-forge-modularization.md). Исходная постановка (ревизия 2, дизайн + критика Fable): Сегодня инструмент — ванильная страница на 1388 строк (`public/tools/uikit-forge.html`), которая авторится **вне репозитория** и обновляется копированием HTML поверх файла: ни тайпчека, ни тестов на ~750 строк геометрии. Ядро едет в `src/services/uikit/` (прецедент `src/services/model-gen/` + `src/ui/model-lab/`), хостов становится два над одним ядром — страница (остаётся, это поставка тому, кто редактором не пользуется) и Lit-панель. **Порядок потребителей задан постановкой:** человек → префабы → рантайм догоняет → экспандер T0/агент; опережение рантайма конструктором заложено в дизайн. Фазы: Ф1 ядро (`ForgeTheme` на абсолютных цветах, `uid` инжектируемый, структурные тесты вместо строковых снапшотов — глобальный `uid()` делает id зависимыми от порядка генерации), Ф2 страница как хост, Ф3 шаблоны и префабы, Ф5 экспандер T0 + агентский тул (тулом, не командой: `run_command` гейтится префиксами и не берёт аргументов), Ф6 Lit-панель. **Ключевая находка:** генератор знает свои `radius`/`bevel`/`outline`, значит отдаёт поля девятислайса бесплатно, а `sliceBorder` уже выведен в схему `TiledSprite2D` четырьмя скалярами — рамка 64×64 закрывает окно любого размера, и композиты (`compPanel`, `compResourceCounter`) превращаются из непригодных «одна картинка» в **шаблоны = части + раскладка**, то есть в форму поставки диалогов и окон настроек. Префаб при этом — обычный `.pix3scene` через `instance:`, нового формата не нужно. Смежно с P1 «подача первого кадра» ниже: кит и есть та «косметика градиентом и тенью», которой берут эту площадку_
- [x] **стадия идеи в режиме Vibe — «редактор ТЗ» перед прототипом** (Сложность: L) — _спека [vibe-idea-stage.md](done/vibe-idea-stage.md), фазы V0–V7: расщепление `PrototypeBootstrapService` на `startIdea()`/`startPrototype()` (вход без LLM-вызова, рецепт выбирается на переходе), `design/gdd.md` вместо стейджа с рендером через расширенный `markdown-lite`, колонка референсов вместо туду-панели (роли, undo-удаление, лайтбокс), выделение текста → чип контекста агенту, аннотации стилусом на референсах, `record_decision` + авто-запись ответов `ask_user` в `design/decisions.md`. **V0 и V1 сделаны и проверены живьём** (2026-08-21, ветка `feat/vibe-idea-stage`, журнал — §7 спеки): `startIdea()` без LLM-вызова, шаблон `idea-blank` + `hidden`-шаблоны, скилл `idea-stage` + 11 тулов стадии (проверено по телу запроса), doc-режим `markdown-lite` с `data-md-lines` и `pix3-idea-doc`. Живьём нашлись и починены два бага: `references/index.json` не создавался (нет родительского каталога) и пре-создавался не тот каталог референсов (`design/references`). **V3 + V3.5 тоже сделаны и проверены живьём** (поправка пользователя: колонка — список ПРОИЗВОЛЬНЫХ файлов `references/**` + закреплённый ТЗ, пополняется дропом/«+»/генерацией; разворот через общий лайтбокс и в колонке, и в чате). Живьём найдены и закрыты три поломки: реф уезжал в `design/` мимо списка, модель «исправляла» путь обратно через `process_asset`+`fs_delete` (теперь результат тула говорит «папка не твоя», а вынос из `references/` отказывает), `fs_delete` оставлял запись в `index.json`. **V2 закрыта, вертикальный срез работает с чистого места:** промпт → редактор идеи (~4 с, без LLM-вызова) → «Start prototype» → рецепт развёрнут в ТОТ ЖЕ проект (`applyTemplateFiles` со skip-листом + страж контракта рецептов, двухфазная запись манифеста, принудительная пересборка скриптов), ТЗ/решения/референсы уцелели, переключатель «Game | Idea» не рестартует игру. **Дев-флаг снят**, welcome по умолчанию ведёт в стадию идеи, старый `run()` выведен. **V4 сделана и проверена живьём** (§7.7, §7.7.1 — выделил абзац → один чип `gdd.md:11–14` → агент одним `str_replace` правит ТОЛЬКО этот фрагмент, клик в поле ввода чип не забирает): второй входной канал `composeContext`/`subscribeComposeContext` (чип едет в ИДУЩИЙ разговор, не сбрасывая его), выделение резолвится по `data-md-lines` в срез исходника (не rendered-текст — иначе `str_replace` не попадёт) и **сразу** становится чипом-слотом: следующее выделение замещает прежнее, снятое выделение забирает чип обратно (кроме случая, когда каретка ушла в поле ввода чата), тулбара и правки промпта нет (поправка пользователя к §3.5 — «перегруз UX»). **V5 сделана и проверена живьём** (§7.8): формат решения вынесен в общий `decision-log.ts` (у него четыре потребителя — тул, авто-запись, документ, планнер), тул `record_decision` пишет одну канон/ическую строку и **замещает** запись той же развилки вместо второй строки-противоречия, ответ на `ask_user` файлится кодом за 400 мс до старта хода (проверено живьём), под документом — сворачиваемая секция «Decisions», читаемая тем же парсером, что и планнер. Живьём нашёлся баг: дата писалась в UTC, то есть решение после местной полуночи уезжало вчерашним днём. **V6 сделана и проверена живьём** (§7.9): `generate_asset` принимает `role`, так что мудборд помечает кандидатов `style-candidate`; выбор — детерминированный клик по капле на карточке (`MakeStyleCommand`), который квантует палитру, пишет `design/style.md` и решение, снимая роль с прежнего стиля, всё undo-абельно одним шагом. Живьём нашлись два бага: смена стиля оставляла ДВА файла с ролью `style` (переход отдал бы планнеру оба) и `….` в строке решения. **V7 написана и покрыта тестами, живьём не проверена** (§7.10): `annotation-doc.ts` (координаты в пикселях исходника, толерантный разбор, `contain`-фит, давление→ширина) + `pix3-image-annotator` (перо/стрелка/рект/метка, coalesced events, локальный undo) как режим лайтбокса, только для картинки С путём проекта и никогда на своём `*.annot.png`; два слоя хранения (`.annot.json` продолжает аннотацию, `.annot.png` уезжает image-блоком вместе с обоими путями). Сохранение НЕ через шлюз мутаций: undo, удаляющий PNG, оставил бы разговор со ссылкой на несуществующий файл. Живая проверка V7 прошла (§7.10.1): фит обратим до сотых, давление стилуса 0.15→0.99, Save пишет только JSON и переоткрытие продолжает аннотацию, отправка кладёт PNG и агент сам вызывает по нему `analyze_image`. Нашлись три бага, которых не видели тесты: `setPointerCapture` бросал ДО создания черновика и уносил весь штрих; пустой список coalesced-событий глотал ввод пера; лайтбокс висел над разговором весь ход агента (закрытие стояло за `await send()`). **План закрыт целиком**_
- [x] add image compression option (Сложность: M) — _закрыто 2026-09-01 (фаза 4 п.2 из
  [done/playable-export-size.md](done/playable-export-size.md)). `PlayableHtmlBuildOptions.compressImages`
  + чекбокс в диалоге экспорта: PNG/JPEG перекодируются в WebP q0.85 через уже существующий
  `compressImageBlob`. Две вещи делают опцию безопасной по умолчанию: изображение заменяется
  **только если** перекодировка реально вышла меньше (на мелкой плоской графике WebP нередко
  проигрывает, и безусловная замена раздувала бы экспорт, попутно его ухудшая), а сбой энкодера —
  не сбой экспорта, просто едут исходные байты. **Ключ ассета остаётся `.png`**: карта встроенных
  ассетов в рантайме — точный строковый lookup, а декодер смотрит на байты, а не на расширение,
  так что переписывать сцены/`.pix3anim`/локали/spine-атласы не нужно вообще (mime берётся из
  самого блоба). Живой замер на спрайтах Tic-Tac-Toe: 13 550 → 4 598 байт, **−66%** (в файле это
  ×4/3 из-за base64). В отчёт о размере добавлены `imageCompressionSavedBytes`/`imagesRecompressed`.
  Только HTML-экспорт: zip кладёт настоящие файлы, где `.png` с байтами WebP был бы ложью на диске.
  Тесты — `PlayableHtmlBuildService.images.spec.ts` (5)_
- [x] **размер playable-экспорта** (Сложность: L) — _[done/playable-export-size.md](done/playable-export-size.md), отчёт [done/playable-export-size-report.md](done/playable-export-size-report.md). Пинбол 1.34 MiB → ~0.42 MiB (−69%): gzip self-extract (опция в диалоге, `iife` + classic script — blob/`data:`/eval не выживают в песочных iframe), бут плеера без YAML-клона сцены (снял `SceneSaver` и разблокировал выпиливание нод), JSON-сцены вместо парсера `yaml`, стабы для неупомянутых нод/behaviors/GLTFLoader + `virtual:runtime-network` — всё по индексу упоминаний `mentionedNames`, со стражем от дрейфа таблицы. Попутно починен `postprocessing`: в экспорте bare-специфаер оставался external, нода `PostProcess` не работала вообще. **Осталось (фаза 4):** `instanceof`-диспатч в `SceneRunner` пинит ~90 KiB нод; PNG → WebP при экспорте_
- [x] инертная нода не видна в Scene Tree (Сложность: S) — _предикат `isInertNode` экспортирован из рантайма (был приватным в `renderability-lint.ts`), `buildTreeNodes` кладёт `isInert`/`inertReason` в вьюмодель, строка рисует warn-бейдж `alert-triangle` и подставляет причину (с «did you mean») в тултип **впереди** прочих пометок. Тесты — `src/ui/scene-tree/scene-tree-node.spec.ts`_
- [ ] add glb inspector, that will show how different parts of model affect size (Сложность: M)
- [ ] создание проекта после промпта «Unsaved Changes» не активируется и оставляет сироту в OPFS (Сложность: S) — _наблюдалось 2026-08-11 один раз, воспроизвести не удалось: проект пишется в OPFS целиком, но в recents не попадает, диалог откатывается в «Create». Трейл и гипотеза (гонка порядка при переключении корня проекта) — [done/browser-storage-projects.md](done/browser-storage-projects.md) §5.1_
- [ ] `Move Project to Folder…` — ручная проверка переноса (Сложность: XS) — _единственный незакрытый пункт §5 browser-storage: гейтинг пункта меню проверен, сам перенос требует нативного directory picker'а, который CDP не закрывает. Проверить руками: файлы на диске, backend стал local, OPFS-копия удалена, recents обновлён_
- [x] открытие проекта с welcome не восстанавливает вкладку сцены (Сложность: S) — _закрыто
  2026-09-01. `EditorTabService.restoreProjectSession` был исправен и покрыт тестами — ломался
  путь до него, тремя независимыми причинами. **Главная**: восстановление стояло *внутри* ветки
  «лэйаут только что построен», за ранним `return` по `layoutInitStarted` — а welcome живёт в том
  же компоненте, так что для **второго и любого следующего** проекта в одной вкладке до него не
  доходило вовсе, при том что `discardTabsOnProjectSwitch` вкладки уже стёр. Ровно описанный
  симптом. Теперь restore вынесен за эту ветку и ключуется id проекта
  (`tabsRestoredForProjectId`), а не булевым «уже делали», плюс перепроверка, что проект не
  сменился, пока ждали скрипты. **Вторая**: `waitForScripts` в шелле ждал `scriptsStatus`
  без таймаута, а `syncAndBuild` не трогает статус, когда страница не в фокусе — выбор папки
  проекта фокус как раз забирает, и ожидание висело вечно; теперь делегирует
  `ProjectScriptLoaderService.ensureReady()` (форс-сборка + 15 с + проверка на устаревший
  статус чужого проекта). **Третья**: `isMissingProjectResource` возвращал `true` на **любом**
  исключении, так что одна временная ошибка чтения (хранилище ещё не переключено на новый
  каталог) удаляла сохранённую сессию навсегда; проверка стала трёхзначной
  (`present`/`missing`/`unknown`), и сессия удаляется только когда все проверки были
  однозначными. Проверено живьём: второй проект в той же вкладке поднял обе сцены и дерево_
- [x] Model Lab — генератор 3D-ассетов и сцен по референсу (Сложность: L) — _[done/model-lab-3d-generator.md](done/model-lab-3d-generator.md): фазы 1–6, панель `src/ui/model-lab/`, обе ланы (модель → GLB, сцена → `.pix3scene`)_
- [ ] нейронный image→3D провайдер в Model Lab (Сложность: M) — _процедурная реконструкция проигрывает специализированным 3D-генераторам; меняется только шаг генерации. Кроме Tripo напрямую (через dev-прокси) добавлен Strophe как второй бэкенд — у него CORS есть, прокси не нужен: [strophe-api-spec.md](strophe-api-spec.md)_
- [ ] интеграция Strophe (Сложность: M) — _MVP в работе: картинки + image→3D на их кредитах, ключ в SecretStorage, вкладка настроек. Спека и живая проверка их API — [strophe-api-spec.md](strophe-api-spec.md), фидбек для их команды — [strophe-integration-feedback.md](strophe-integration-feedback.md). Осталось на их стороне: снять team-gating на выдачу ключей, `seed`, контроль формата вывода, LLM-лана_
- [x] log game events to editor's console (Сложность: M) — _закрыто 2026-09-01. К уже
  мостившимся ошибкам скриптов и uncaught-исключениям добавились **два** недостающих потока, оба
  в `RuntimeErrorBridgeService`. **Сигналы**: в рантайме появился sink по образцу
  `registerScriptErrorSink` — `registerSignalEmitSink`/`reportSignalEmit` в `game-debug.ts`,
  вызов в `NodeBase.emit` **до** раннего выхода, потому что сигнал, ушедший в пустоту, — как раз
  тот случай, который был неотличим от «не срабатывал вообще»; в Logs это строка
  `Signal "x" from Node → N listener(s)` на уровне `debug`. Без зарегистрированного sink'а
  (экспорт, тесты) — одно чтение свойства. **Консоль**: `console.*` патчится ровно на время
  play-режима и зеркалится с источником `game`, как это давно делает standalone-плеер
  (`stringifyLogArgument` вынесен в общий `src/core/log-argument.ts`). Ключевая деталь — **фильтр
  по происхождению вызова**: игра в редакторе делит консоль с самим редактором, и первая живая
  проверка показала в панели `[LayoutManager]`/`[Atlas]`/`[InputService]` с ярлыком `game`, то
  есть ярлык врал. Пользовательские скрипты импортируются с blob-URL, поэтому их кадры стека
  содержат `blob:` — единственный неэвристический признак; при отсутствии стека решение
  fail-open. Плюс защита от петли `console.log → forward → DEV-эхо LoggingService → …`.
  Проверено живьём на Tic-Tac-Toe: сигналы видны, редакторского шума под ярлыком `game` — ноль.
  Тесты — 16 в `RuntimeErrorBridgeService.spec.ts` + 4 в `signal-emit-sink.spec.ts`_
- [ ] generate asset manifest on project build (Сложность: M) — _partial: asset-manifest.json перечисляет пути, метаданных (размеры, длительность, поликаунт) нет_
- [ ] publish runtime package to the cloud, to optimize pipeline (Сложность: M) — _partial: `@pix3/runtime` публикуется в npm (OIDC trusted publishing); CDN-хостинг рантайма для экспортированных игр — нет_
- [x] fix icons for global light nodes (Сложность: S)
- [x] add icon to audio nodes (Сложность: S)
- [x] remove bounding boxes from global objects without transform (Сложность: S)
- [x] version check and update functionality (Сложность: S)

### Найдено замером разрыва с чат-ланой (2026-08-29)

Всё ниже найдено во время [vibe-vs-chat-gap.md](done/vibe-vs-chat-gap.md) и намеренно **не** чинилось
по ходу — правка харнесса обнулила бы сравнимость прогонов. Порядок — по измеренной цене.

- [x] **`create_node` молча срывает уже привязанные компоненты со сцены** (Сложность: M) —
  _закрыто 2026-09-01. Виноват был **не** `create_node`: `SceneLoader` **выбрасывал** компонент,
  чей тип ещё не зарегистрирован (`createComponent` → `null`, один `console.warn`), а первое же
  сохранение — их делает любая мутация агента — записывало эту потерю в `.pix3scene`. Гонка
  безусловная: скрипты проекта компилируются асинхронно (esbuild-wasm, дебаунс 300 мс), сцену
  никто не ждёт `scriptsStatus`, а рецептовые сцены ссылаются на `user:GameRules`/`user:ScoreHud`
  — отсюда «3 прогона из 4». `create_node` просто оказывался первым, кто сохранял. **Фикс**:
  нерезолвнутое определение паркуется в `NodeBase.pendingComponents` (`core/component-hydration.ts`),
  `SceneSaver` его дописывает обратно, `SceneManager.resolvePendingComponents()` доцепляет всё,
  чей тип появился, и `ProjectScriptLoaderService` зовёт это сразу после компиляции. Агенту
  припаркованное видно (`pendingComponents` в `node_inspect`), а `add_component` сначала
  доцепляет и возвращает уже существующий `componentId` вместо дубля. Побочно закрыт целый
  класс: сломанный скрипт больше не удаляет свои компоненты из файла — они возвращаются, когда
  скрипт починен. Тесты — `pending-components.spec.ts` (6) + два в `AgentToolRegistry.spec.ts`_
- [ ] **подача первого кадра: прототип выглядит как цветные прямоугольники** (Сложность: L) —
  _четыре балла из семи всего разрыва рубрики (подача 4/8 против 8/8 у эталона). Ни одного
  спрайта ни в одном из четырёх прогонов; ассетов в экспорте — 400 байт на 930 KiB файла.
  Эталон берёт эту площадку CSS-градиентом и тенью, а не искусством, — значит и здесь это
  дешевле, чем кажется. Обоснование и цифры — §5 замера._ **Половина уже есть:** UI-кит
  печётся и накладывается автоматически (см. `done/uikit-forge-modularization.md`, экспандер T0
  скиннит UI рецепта без хода агента) — осталась не-UI часть кадра: фон, игровые спрайты, юмор
  подачи
- [ ] **планнер не попадает в рецепт, который уже есть** (Сложность: M) — _P1: промпт «тапалка
  про монетки», `recipe-tapper-2d` существует — выбран `recipe-blank-2d`. Непопадание в уже
  оплаченное покрытие; чинится выбором рецепта, а не новым рецептом. Отдельно: P3 упал в
  `FALLBACK_RECIPE_ID` = `recipe-arena-2d` вместо более близкого `recipe-bouncer-2d`, и это
  стоило брифа в 1679 строк, 124K входных токенов на первом вызове и единственного прогона,
  который так и не сошёлся_
- [ ] **верификация состоянием слепа к ориентации и вообще к «похоже ли это на игру»**
  (Сложность: M) — _в P4 фигуры тетриса **падали вверх** (`layoutRect` считал, что Y растёт вниз,
  как в Godot/Canvas, тогда как мировой Y в Pix3 растёт вверх). И проверки агента, и мои прошли
  успешно: в координатах сетки (`px`/`py`/`grid`/`score`/`phase`) всё было консистентно. Поймал
  человек, посмотрев на экран. Нужен дешёвый визуальный/осевой чек, который ловит это без
  человека_
- [x] **кап тул-итераций рвёт ход посередине задачи** (Сложность: S) — _закрыто 2026-09-01
  по сути требования («откат отладочных правок должен переживать обрыв»), константа не тронута.
  `set_property`/`set_component_property` принимают `temporary: true`: прежнее значение
  журналируется **до** записи, а `AgentChatService.runAttempt` откатывает журнал в `finally` —
  то есть при любом финале хода (кап, abort, ошибка провайдера, нормальное завершение), и
  пользователь видит в notice, что именно вернулось и что вернуть не удалось. Модель не тратит
  на это итерации: подсказка у капа прямо говорит не откатывать `temporary`-значения руками, а
  `revert_temporary_edits` есть, если эксперимент кончился раньше. Тесты — 5 в
  `AgentToolRegistry.spec.ts` + 2 в `AgentChatService.spec.ts`_
- [x] **`str_replace` ломается на файлах с CRLF** (Сложность: S) — _закрыто 2026-09-01: анкер
  переразмечается переводами строк **самого файла** (`toFileLineEndings`), и только после промаха —
  точное совпадение остаётся байт-в-байт, файл со смешанными концовками не нормализуется. Замена
  пишется концовками файла, так что точечная правка не оставляет одинокий LF в CRLF-файле; в ответе
  появляется `note`, объясняющая, что произошло. Работает в обе стороны (LF-анкер в CRLF-файле и
  наоборот), три теста в `AgentToolRegistry.spec.ts`_
- [ ] **перекрывающиеся контролы ловят один физический тап оба** (Сложность: M) — _у движка нет
  глобального пикинг-прохода (это записано в описании `game_controls`). Практическое следствие,
  найденное живьём: в P1 победный тап зажигает и монету, и появившуюся под пальцем кнопку RETRY,
  так что **экран победы недостижим тапом** — игрок видит только тихий сброс счёта_
- [x] **`t_idea` 10–16 с без единого обращения к модели** (Сложность: S) — _**замерено
  2026-09-01, и замер снимает гипотезу: в создании проекта и развороте шаблона этих секунд нет.**
  Путь «клик Make → дизайн-док на экране» стоит **94 / 77 / 245 мс** тёплым (живые прогоны через
  prompt-hero) и **91 мс** холодным (изолированный контекст браузера: пустой OPFS, очищенный
  localStorage, hard reload, персистентность ещё не выдана). Разбивка при 91 мс:
  `requestPersistence` 22, каталог проекта в OPFS 7, каталоги шаблона 2, манифест 4,
  чтение+запись текста шаблона 6, агент-оверлей (~110 КБ, 8 файлов) 10+19, документы идеи 3,
  монтирование Flow-шелла и рендер `pix3-idea-doc` 12. Всего ~26 записей в OPFS, все
  последовательные, и все вместе они не дотягивают до десятой доли секунды. Инструментирование
  оставлено в `src/services/flow/idea-timeline.ts`: `console.info` с разбивкой,
  `performance.measure` для трейса, `window.__pix3IdeaTimeline()` для автоматики — так что
  повторный замер стоит один вызов. **Попутно воспроизведена ровно та ловушка, о которой писал
  сам замер** («раннер ловил кнопку прошлого проекта»): `pix3-idea-doc` прошлого проекта
  перерисовывается в первых кадрах и закрывает секундомер досрочно — поэтому финиш арминтся
  только после открытия нового проекта (`armCompletion`). Она же — самое правдоподобное
  объяснение исходных 10–16 с: ручной сигнал ловил переход, а не работу. Если секунды всплывут
  снова — мерить тем же инструментом, а не глазом_

## Рантайм (Runtime)

- [ ] **дорожка рантайма под UI-кит: типографика подписи, потоковая раскладка** (Сложность: M, было L) — _очередь Ф4 из [done/uikit-forge-modularization.md](done/uikit-forge-modularization.md) §6, **пункты (1) и (3) закрыты** на `feat/uikit-forge-core` (текстурные слоты у `Bar2D`/`Slider2D`/`Checkbox2D`, `sliceBorder*` на скине `Button2D`); остались (2) и (4), плюс новое: прокси вьюпорта не рисует заливку/ползунок слайдера, заливку бара и галочку чекбокса. Исходная постановка: приоритет внутри задаёт кит — слот заводится там, где инструмент уже рисует скин, которым хочется пользоваться. UI был низкоприоритетным из-за отсутствия прецедентов, кит их и создаёт. Четыре пункта: (1) текстурные слоты у `Bar2D`/`Slider2D`/`Checkbox2D` — сегодня у всех трёх **ноль** упоминаний текстур, они цветовые, тогда как слоты есть только у `Button2D` (`textureNormal/Hover/Pressed/Disabled`) и `ScrollContainer2D`; (2) загрузка `fonts/*.woff2` проекта через `FontFace` + обводка и тень подписи в `UIControl2D` — `grep` по `new FontFace|document.fonts` пуст во всём рантайме и `src/`, подпись идёт через canvas `ctx.font` с дефолтом `'Arial'`, а обводка есть только у `Label2D`, так что кит «как в Brawl Stars» выходит в движке с плоским Arial (**сам инструмент этим не болен** — он вшивает woff2 в SVG-экспорт, поэтому это догоняющая работа, а не блокер); (3) `sliceBorder` на скине `Button2D` — сейчас он растягивает общий unit-quad до `width×height`, из-за чего спрайт 250×88 на кнопке 480×140 едет радиусом и бликом; снимает per-size рендер для кнопок; (4) потоковая/стековая раскладка **поверх существующих якорей** `Node2D` (`layout: { enabled, horizontalAlign, verticalAlign }`) для колонки настроек — якорение к размеру родителя есть, потока нет; ноду `Layout2D` **не возвращать**, она убрана сознательно ([done/layout2d-implementation-plan.md](done/layout2d-implementation-plan.md))_
- [ ] **встроенная 2D-физика: `core:PhysicsBody2D` + `core:Collider2D` + `scene.physics2d`** (Сложность: L) — _спека [physics-engine.md](physics-engine.md), одобрена 2026-08-30, реализация отложена. Солвер **рукописный** (импульсный, круги + OBB, сенсоры, swept-CCD), Rapier в 2D-путь не заходит: его ~2 МБ wasm больше всего playable-экспорта. 3D физика остаётся game-level (Rapier в пользовательских скриптах, как в DeepCore). Ноль байт для игр без физики через `STRIPPABLE_RUNTIME_MODULES` по прецеденту `NetworkService`; шаг — в существующий `SceneRunner.runFixedUpdates`. `core:Hitbox2D` остаётся как query-only слой_
- [x] **выпустить `@pix3/runtime` 1.3.0 в npm** (Сложность: S) — _сделано 2026-08-04: тег `runtime-v1.3.0` (первый `runtime-v*` в репозитории) → `publish-packages.yml` через OIDC → npm `latest = 1.3.0`. Открыло потребителям пер-кадровый anchor/`sizeMode`/`sourceSize` (R1) и `getFramePoint`/`core:PointAttachment` (R2). DeepCore подтянул обычным `npm update` (спека `^1.2.0` разрешилась в 1.3.0, package.json править не пришлось), собирается чисто_
- [x] add remote preview to check the game on device (Сложность: L) — _relay + player.html + `PreviewHostService`; см. [done/rapid-prototyping-design.md](done/rapid-prototyping-design.md)_
- [x] implement cinematic camera module, that will allow control camera more flexibly (Сложность: L) — _P0.1 vcams (3D) + Cutscene Director; Camera2D осознанно отложена_
- [x] update nodes properties and hot reload them in the game mode (Сложность: M) — _P0.5_
- [x] `InstancedMesh3D` без авторского материала (Сложность: M) — _семейства материалов вынесены из приватного статика `GeometryMesh` в общий `nodes/3D/material-family.ts` (публичные имена ре-экспортируются из `GeometryMesh`, API потребителей не поехало); нода приняла `materialConfig`, строит **свой** материал всегда (общий `DEFAULT_MATERIAL` убран — он и делал семейство недостижимым из инспектора), отдаёт `materialType`/`color` в схему (группа Material) и `serializeMaterialConfig()` в `SceneSaver`; `SceneLoader` парсит блок `material:` в той же форме, что у `GeometryMesh`. Материал, переданный кодом, по-прежнему главнее авторского. Тесты — `InstancedMesh3D.spec.ts` (семейство, дефолт, round-trip, смена семейства с освобождением старого, ровно-одна sRGB-конверсия, мульти-слот, `setMaterial`). **Три правки по ревью:** дефолтные PBR-числа взяты у самого three (roughness 1 / metalness 0), а не у `GeometryMesh` (0.35/0.25) — иначе каждый уже существующий instanced-меш перекрашивался бы при загрузке и запекал новые числа в файл при первом сохранении; `setMaterial()` (код-путь, им пользуется DeepCore) теперь освобождает прежний материал и перечитывает семейство — иначе нода продолжала бы **сохранять** `type: standard`, рендеря basic; аксессоры и сериализация научились мульти-слотовым материалам (сериализация возвращает `null` и блок не пишется — один блок не описывает несколько слотов)_
- [x] **zIndex/sortOrder на Node2D** (Сложность: S) — _`zIndex` + `zAsRelative` (Godot-семантика) в группе «Ordering»; бакеты по эффективному z поверх DFS в `render-order-2d.ts`, зеркала в `Viewport2DProxyRegistry` и `ViewportPicking`_
- [x] fix layout system to process correctly margins in anchor mode (Сложность: M)
- [x] unify scene objects addressing from custom scripts (Сложность: M)
- [x] add opacity to 3d sprite with fade in/out APIs (Сложность: M)
- [x] particle rotation toggle and saving fix (Сложность: S)
- [x] sprite color fix on editor mode (Сложность: S)

## UX / UI

- [x] drag and drop assets into editor viewport and scene tree (Сложность: L) — _`src/ui/shared/asset-drag-drop.ts` + drop-хендлеры во viewport, scene-tree, инспекторе и библиотеке_
- [x] improve UX of controls on Object inspector (dragging numbers, compact) (Сложность: M) — _`pix3-number-field` (drag-to-scrub, Shift = точнее ×0.1, Ctrl = грубее ×10, клик = ввод текстом) теперь стоит на **всех** числовых полях инспектора: transform/vector/size/rotation, скалярные свойства нод и числовые поля компонентов-скриптов; сырых `<input type="number">` в панели не осталось. Компактный summary-layout сделан раньше_
- [x] drag-to-scrub в FPS-поле Sprite Editor (Сложность: XS) — _перепроверено 2026-08-28 по исходникам: поле уже `pix3-number-field` (`sprite-timeline.ts` `renderClipTiming`, `@commit-change` → `controller.updateClipFps`, min 1 / max 240 / precision 0). Пункт висел просроченным. `sprite-editor-panel.ts` (custom max px при сохранении) — разовый ввод, скраб не нужен_
- [x] allow to preview animations in assets panel (Сложность: M) — _`.pix3anim` получил `previewType: 'animation'`: карточка/строка показывают первый кадр и `клип · fps · кадры`, play/stop (и Space на выделенном) проигрывает клип с учётом loop/ping-pong и per-frame duration. Первый кадр грузится при скане папки, остальные — лениво по нажатию play (`requestAnimationFrames`); sheet-клипы кроп по UV-подпрямоугольнику_
- [x] better control of camera and light directions (Сложность: S) — _статус был просрочен: перепроверено 2026-09-01 по исходникам, target-гизмо **таскаются** целиком. Цепочка: `ViewportPicking.raycastTargetSphere` → `setActiveTargetSelection` → в translate-режиме TransformControls аттачится к самой сфере, а не к ноде (`ViewportRenderService.attachTransformControlsForSelection`) → `updateTargetTransformFromControl` пишет `setTargetPosition` на каждом `objectChange` → `handleTransformCompleted` закрывает `TargetTransformOperation` (undo + `descriptor.isDirty`). `setTargetPosition` есть у Camera3D / DirectionalLightNode / SpotLightNode_
- [ ] remove game tab and keep only popup window mode (Сложность: S) — _partial: живут оба хоста_
- [x] инспектор свойств во Vibe (Сложность: M) — _закрыто 2026-09-01, последний незакрытый пункт
  [done/vibe-scene-view.md](done/vibe-scene-view.md). В строке выделения Scene-вида появилась
  кнопка «Properties», открывающая ящик справа от вьюпорта. Внутри — **тот самый**
  `pix3-inspector-panel`, который докается в Studio, а не второй уменьшенный инспектор: он и так
  сам читает `appState.selection` и гоняет правки через `UpdateObjectPropertyCommand`, так что
  переиспользование не стоило проводки и, главное, делает невозможным расхождение вайбового
  инспектора со студийным по мере роста схем нод. Панель импортируется **лениво, при первом
  открытии** — Vibe не должен платить за редактор, который не показывает; состояние ящика живёт в
  `appState.ui.flowInspectorOpen`, потому что вид перемонтируется на каждом переключении сцены/игры
  и позу нельзя терять. Попутно починено то, что стало достижимо только сейчас: строка выделения
  кэшировалась по **id** узлов, поэтому переименование прямо в ящике под ней не обновляло надпись —
  теперь она перечитывается по `nodeDataChangeSignal`. Проверено живьём в Tic-Tac-Toe: клик по
  вьюпорту → инспектор показывает Transform/Size/Align/Opacity/Ordering и компонент
  `user:GameRules`, введённое имя доезжает и до ноды, и до файла. Тесты — 6 в
  `pix3-flow-scene-view.spec.ts`_
- [x] add color picker for color values in Object inspector (Сложность: M)
- [x] make a node picker for properties with node type (Сложность: M)
- [x] allow to preview glb models from asset browser (Сложность: M)
- [x] allow to preview sounds in editor (Сложность: M) — _инспекторный `audio-resource`-редактор: waveform + плеер + duration/channels/rate_
- [x] allow to preview sounds in assets preview panel (Сложность: M) — _waveform-миниатюра и play/stop в grid и списке, полоса плейхеда, часы `0:03 / 0:12`, Space на выделенном ассете_
- [x] add alignment methods for 2d objects (Сложность: M)
- [x] add show all and reset zoom in 2d navigation mode (Сложность: S)
- [x] show anchor point of sprite in the editor (Сложность: S)
- [x] allow to see file size in the asset preview/browser (Сложность: S)
- [x] add drag and drop support for audio files properties (Сложность: S)
- [x] update icons and layout of viewport toolbar (Сложность: S)
- [x] not to hide camera/light icons on select, make semitransparent (Сложность: S)
- [x] snap 2d objects to grid (Сложность: S)
- [x] move 2d nodes with arrow keys (Сложность: S)

## Инфраструктура и Веб (Web & Infra)

- [ ] add tools.gritsenko.biz integration (publish & share) (Сложность: L) **Low priority**
- [x] create landing page for editor (Сложность: M)
- [x] publish online PWA version (Сложность: M)
- [x] add bundle size calculation (Сложность: S)
