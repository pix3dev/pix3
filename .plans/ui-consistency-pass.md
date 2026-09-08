# UI consistency pass — меню и Object Inspector

Статус: спека, не реализовано. Дата: 2026-09-08.
Повод: редакторы открываются то из `View`, то из `Tools`; Align включается кнопкой, Flow —
чекбоксом; `Disable`/`Remove` в компонентах и эффектах — текстовые ссылки.

Ниже — инвентарь того, что есть (проверено по исходникам), целевая IA и план миграции
маленькими независимыми шагами.

---

## 1. Что не так сегодня (проверено)

### 1.1 Меню

- **`View` — свалка.** В одной секции: переключатель воркспейса, инструменты трансформации
  (Q/W/E/R), 12 вьюпорт-тогглов, зум/фрейминг **и** панели (Project Home, Animation,
  Asset Library, Localization, Generate). Ещё четыре панели — Sprite Editor, Agent Chat,
  Model Lab, UI Kit — лежат в `Tools`. Разделение произвольное.
- **Часть панелей недостижима из меню вообще:** Inspector, Scene Tree, Assets, Logs,
  Profiler, Runtime, Game. Закрыл вкладку — открыть нечем.
- **Коллизии `menuOrder`** (при равенстве порядок падает на порядок регистрации, т.е.
  зависит от порядка импортов): `view` — `21`×3, `24`×2, `25`×2, `30`×2; `file` — `10`×2
  (два пункта «Save»); `project` — `103` у **Play Online и Stop Game**; `tools` — `11`×2.
- **`create/2d` и `create/3d` протекают в меню-бар.** `pix3-main-menu.buildMenuSections()`
  выкидывает только секцию с `id === 'create'`, а `CommandRegistry` кладёт незнакомые
  `menuPath` отдельными секциями с лейблом `menuPath[0].toUpperCase() + slice(1)`.
  Итог: два фантомных top-level меню «Create/2d» и «Create/3d» с пятью командами, при том
  что настоящая секция Create синтезируется из реестра типов нод. Два источника правды.
- **`insert`** — секция из одного пункта (`Create Prefab Instance`), по смыслу это Create.
- **Именование:** 12 пунктов «Toggle X» вместо checkable-пунктов с галкой; многоточие есть
  у 2 из ~9 команд, открывающих диалог; «Play Game (Entry Scene)» / «Play Scene» /
  «Play Online» / «Stop Game» / «Restart Game» — контекст меню дублируется в каждом пункте.
- **Шорткаты:** Q/W/E/R по Unity — дальше ад-хок (`G` сетка, `L` свет, `N` навигация,
  `2`/`3` слои, `Mod+Ctrl+Enter` play при свободных F5/F6). Панелям шорткатов нет, кроме
  `Mod+1` (Project Home) и `Mod+Shift+A` (Agent Chat) — схема «Mod+цифра» заявлена и брошена.
- **`scene.align-2d-nodes`** (`addToMenu: false`) живёт только в тулбаре вьюпорта: нет
  пункта меню, нет слота под шорткат, нет палитры.

### 1.2 Инспектор

- **Порядок групп задан для 10 имён** (`PROPERTY_GROUP_ORDER`), а в схемах их ~65.
  Остальное сортируется по алфавиту, поэтому у одной ноды `Audio`/`Camera`/`Debug`
  оказываются выше `Skin`/`Label`. Порядок не соответствует ни важности, ни объявлению.
- **Два «включателя раскладки» разной формы:** `Anchor` рисуется кастомной секцией «Align»
  с кнопкой-заголовком `Enabled/Disabled`, а `Flow` — обычным списком свойств, первая
  строка которого — чекбокс `flowEnabled`.
- **«Align» занят трижды:** тулбар-стрип разовых операций, секция `Anchor` под именем
  «Align», и `flow.align` под именем «Cross Align».
- **Шесть кнопочных идиом:** `inspector-button`, `btn-icon`, `component-action-link`
  (текстовые `Disable`/`Remove`), `btn-add-behavior`, `btn-add-group` (голое «Add» без
  иконки), `anchor-toggle-button` / `editor-flag-button` / `summary-toolbar-button`.
- `PropertySchema.groups[].expanded?: boolean` объявлено в
  `packages/pix3-runtime/src/fw/property-schema.ts` и **нигде не используется**.
- `PANEL_COMPONENT_TYPES.animation` и `.spriteEditor` мапятся на один и тот же
  `pix3-sprite-editor-panel` — один из них легаси.

---

## 2. Целевая структура меню

Восемь секций: **File · Edit · Create · Node · View · Run · Project · Window**.
`Tools` растворяется, `insert` схлопывается в `Create`. `Help` не заводим, пока в нём
меньше двух пунктов.

Принципы (прецеденты: Unity, Godot 4, Blender, Figma, VS Code):

| Решение | Куда | Почему |
| --- | --- | --- |
| Открытие панелей и редакторов | `Window` | Unity `Window`, VS Code `View`. Один предсказуемый дом вместо развилки View/Tools. |
| Play/Stop/Restart | `Run` | Пять команд со своим enable-состоянием; VS Code/JetBrains/Xcode. У нас нет постоянного play-тулбара, поэтому меню несёт открываемость. |
| Editor Settings | `Edit` (низ) | Unity `Edit ▸ Preferences`, Godot `Editor ▸ Editor Settings`. |
| Project Settings | `Project` (верх) | Godot/Unity: настройки проекта — в проекте. |
| Операции над выделением (Group, Align, Distribute, Publish, Save as Prefab) | `Node` | Figma `Edit` (undo/dup/delete) vs `Object` (group/align/arrange); Unity `GameObject`. «Node» — словарь приложения. |
| Bake AO | `Project`, банда 400 | Оффлайн-проход по всей сцене, порождающий ассеты — родня Build/Export. Blender `Render ▸ Bake`. |
| Sync / Move / Open in VS Code | `File` | Операции над расположением проекта. |
| Разовое выравнивание 2D | `Node ▸ Align ▸` / `Node ▸ Distribute ▸` | Figma `Arrange ▸ Align`; даёт тулбар-командам дом, палитру и слот под шорткат. |

### 2.1 Правило бэндов `menuOrder` (убивает коллизии)

`menuOrder` — трёхзначное: **сотни = семантический бэнд, десятки = слот, единицы —
резерв под вставки**. Разделитель рисуется автоматически там, где у соседних пунктов
меняется `Math.floor(order / 100)` — метаданных под сепаратор нет и забыть его нельзя.

1. Каждая команда с `addToMenu` **обязана** иметь `menuOrder`.
2. Пара `(menuPath, menuOrder)` уникальна.
3. Оба правила проверяет спека `CommandRegistry.menu.spec.ts` — она же и есть защита от
   возврата коллизий.
4. Подменю — сегменты пути: `menuPath: 'node/align'`. Фаза 1 рендерит подменю как
   озаглавленную группу внутри дропдауна (механизм `groupedItems` уже есть, новых
   компонентов не нужно), фаза 2 — как вылетающее подменю.

### 2.2 Checkable-пункты

В `CommandMetadata` добавляется `readonly checked?: (state) => boolean`. При его наличии
пункт рендерится как `role="menuitemcheckbox"` + `aria-checked` + иконка `check` в
колонке фиксированной ширины (лейблы не прыгают). **Тот же предикат читает тулбар** —
`editor-tab.ts` уже дёргает те же команды по id
(`commandDispatcher.executeById('view.toggle-grid')`), так что `isActive` кнопки тулбара
переводится на `commandRegistry.isChecked(id)`. Один предикат на тоггл — тулбар и меню
не могут разойтись.

Что где живёт:

- **И в тулбаре, и в меню:** Grid, Snap to Grid, 2D Layer, 3D Layer, System Lighting,
  Collision Shapes, режимы трансформации, Navigation Mode.
- **Только в меню:** Axis Gizmo, Direction Axes, Physics Colliders, зум, фрейминг.
- **Только в тулбаре:** превью камеры, стрип выравнивания (его *команды* дом в `Node`
  получают, сам стрип — нет), индикатор зума.

### 2.3 Секции

- **File** — 100 New Project… / 110 Open Project… · 200 Save / 210 Save As… ·
  300 Sync to Local Folder… / 310 Move Project to Folder… / 320 Open in VS Code ·
  900 Close Project
- **Edit** — 100 Undo / 110 Redo · 200 Duplicate / 210 Delete · 900 Editor Settings…
- **Create** — группы 2D / UI / 3D / Audio из реестра типов нод (строка называется типом
  ноды: `Sprite2D`, а не `Create Sprite2D` — глагол уже в заголовке меню) · 900 Browse All
  Nodes… (поиск по всем типам)

  Уточнено при реализации G1: пункта `Prefab Instance…` тут нет.
  `CreatePrefabInstanceCommand` не запускается без `prefabPath`, поэтому строкой меню без
  аргумента быть не может — префабы вставляются перетаскиванием из Assets/Library и через
  Scene Tree. Его `menuPath: 'insert'` был мёртвой метадатой: команда нигде не
  регистрировалась, так что меню `insert` никогда и не рисовалось. Зато выяснилось, что
  клик по `Create` открывал модальный поиск, а `NodeRegistry.getGroupedDropdownItems()`
  лежал мёртвым кодом — теперь Create настоящий дропдаун, а поиск остался командой
  `scene.browse-node-types` внизу секции и в палитре.
- **Node** — 100 Group Selection / 110 Fit Group to Contents · 200 Align ▸ /
  210 Distribute ▸ · 300 Save Branch as Prefab… / 310 Publish to Library… /
  320 Publish to Store…
- **View** — 100 ☐ Flow Workspace · 200 Select/Move/Rotate/Scale (radio) /
  210 ☐ Navigation Mode · 300 ☐ Grid / 310 ☐ Snap to Grid / 320 ☐ Axis Gizmo ·
  400 ☐ 2D Layer / 410 ☐ 3D Layer / 420 ☐ System Lighting · 500 ☐ Collision Shapes /
  510 ☐ Physics Colliders / 520 ☐ Direction Axes · 600 Zoom In / 610 Zoom Out /
  620 Reset Zoom · 700 Frame Selected / 710 Frame All
- **Run** — 100 Play Game (F5) / 110 Play Scene (F6) / 120 Play Online · 200 Stop (F8) /
  210 Restart (Mod+F5) · 300 Open Game Window / 310 Start Remote Preview ·
  400 Check Scripts for Errors
- **Project** — 100 Project Settings… · 200 Build Runtime Project… /
  210 Export Playable HTML… / 220 Export HTML + Assets (Zip)… ·
  400 Bake Ambient Occlusion / 410 Clear Baked Ambient Occlusion
- **Window** — 100 Scene Tree / 110 Inspector / 120 Assets / 130 Asset Library ·
  200 Animation / 210 Logs / 220 Profiler / 230 Runtime · 300 Localization /
  310 Asset Generator / 320 Agent Chat · 500 Game / 510 Sprite Editor / 520 Model Lab /
  530 UI Kit · 900 Reset Layout

Проверено: `Collision Shapes` и `Physics Colliders` — **разные** оверлеи, оба остаются.
Первый (`view.toggle-collision-shapes`) рисует авторские 2D-коллайдеры/хитбоксы в
**редакторе** (годотовское «Visible Collision Shapes»), второй (`view.toggle-colliders`,
флаг `showPhysicsColliders`) — физический wireframe **запущенной игры**. Имена этого не
передавали, поэтому второй переименован в **Physics Wireframe**; различие
редактор-vs-игра остаётся в описаниях (они же тултипы).

### 2.4 Правила именования

1. **Title Case**, артикли выброшены, ≤ 4 слов.
2. **Глагол вперёд для действий** (`Frame Selected`, `Bake Ambient Occlusion`);
   **только существительное для состояния** (`Grid`, `2D Layer`) — глагол здесь галочка.
   Слова «Toggle» в лейблах не бывает.
3. **Многоточие «…»** ставится тогда и только тогда, когда команда спрашивает ввод или
   подтверждение **до** действия. Открытие панели/вкладки диалогом не является (Apple HIG).
4. **Заголовок меню даёт контекст**: под `Create` — типы нод, под `Run` — `Stop`/`Restart`.
5. **Подменю заводится**, когда ≥ 4 соседей отличаются только параметром (края
   выравнивания, оси распределения). Меньше четырёх — плоский бэнд.
6. **Пункт Window называется ровно как заголовок вкладки панели** (единый источник —
   мапа заголовков в `LayoutManager`).

Таблица переименований (старое → новое / меню / order):

| Старое | Новое | Меню | Order |
| --- | --- | --- | --- |
| Project Home | Open Project… | File | 110 |
| Save (`scene.save`) | — (`addToMenu:false`, остаётся в палитре) | — | — |
| Save (`editor.save-active-resource`) | Save | File | 200 |
| Save As | Save As… | File | 210 |
| Sync to Local Folder | Sync to Local Folder… | File | 300 |
| New Project | New Project… | File | 100 |
| Editor Settings | Editor Settings… | Edit | 900 |
| Delete Object | Delete | Edit | 210 |
| Create Prefab Instance (`insert`) | вне меню (`addToMenu:false` — нужен `prefabPath`) | — | — |
| — (новая команда) | Browse All Nodes… (`scene.browse-node-types`) | Create | 900 |
| Create ColorRect2D / AnimatedSprite2D / SpineSkeleton2D / AnimatedSprite3D / Particles3D | убрать `menuPath`/`menuOrder` (реестр — единственный источник) | — | — |
| Save Branch as Prefab | Save Branch as Prefab… | Node | 300 |
| Publish to Library | Publish to Library… | Node | 310 |
| Play Game (Entry Scene) | Play Game | Run | 100 |
| Stop Game / Restart Game | Stop / Restart | Run | 200 / 210 |
| Build / Export ×2 | + «…» | Project | 200/210/220 |
| Project Settings | Project Settings… | Project | 100 |
| Toggle Flow / Studio | ☐ Flow Workspace | View | 100 |
| Toggle Grid / Snap to Grid / Axis Gizmo | ☐ Grid / ☐ Snap to Grid / ☐ Axis Gizmo | View | 300/310/320 |
| Toggle 2D Layer / 3D Layer / System Lighting | ☐ 2D Layer / ☐ 3D Layer / ☐ System Lighting | View | 400/410/420 |
| Toggle Collision Shapes / Physics Colliders / Direction Axes | ☐ … | View | 500/510/520 |
| Zoom Default | Reset Zoom | View | 620 |
| Generate | Asset Generator (и заголовок панели тоже) | Window | 310 |
| Sprite Editor / Model Lab / UI Kit / Agent Chat (`tools`) | имена без изменений | Window | 510/520/530/320 |
| Align 2D Nodes (вне меню) | 16 пунктов в `Node ▸ Align` / `Node ▸ Distribute` | Node | 200/210 |

### 2.5 Открываемость панелей

**Правило: у каждого закрываемого `PANEL_COMPONENT_TYPES` есть пункт Window, который
открывает-или-фокусирует его, и называется как заголовок вкладки.** Исключения — `viewport`
и `code`: это документы с идентичностью (сцена, файл скрипта), открываются из Assets /
Scene Tree, обобщённого пункта у них быть не может.

**Одно меню Window, два бэнда через разделитель — не два меню.** Различие «док-панель vs
вкладка-документ» важно движку раскладки, а не пользователю, который ищет, куда делись Logs.
Второе меню из четырёх пунктов вернуло бы ровно ту лотерею, которую этот проход убирает.

Пункт Window — **идемпотентное open-or-focus, не checkable**. Чекбокс приглашал бы закрывать
док из меню, а в Golden Layout это схлопывает стек и двигает соседей. Закрытие остаётся на
крестике вкладки (так же у Unity).

Сверка с `PANEL_DISPLAY_TITLES` (`src/core/LayoutManager.ts`) — единственный источник имён,
поэтому пункты Window берут их, а не текст из §2.3: `agentChat` = **Agent**,
`library` = **Library**, `animationTimeline` = **Animation**, `background` = **Home**
(в меню не попадает — это `File ▸ Open Project…`), `generate` переименовывается в
**Asset Generator** сразу в обоих местах. `animation` и `spriteEditor` дают одинаковое
«Sprite Editor» на один и тот же компонент — в Window идёт только `spriteEditor`.

Реализация: `LayoutManager.focusPanel()` уже есть, как и частные `reveal*Panel()` для
Agent/Localization/Library/Generate. Заводится одна фабрика `ShowPanelCommand`
(`window.show-<type>`), обобщающая логику «нет в раскладке → добавить в дефолтный стек».
Существующие `Open*Command` сохраняют id (на них висят шорткаты) и меняют только
`menuPath`/`menuOrder`.

---

## 3. Инспектор

### 3.1 Таксономия секций

Имена групп приходят от двух видов владельцев схем, и классифицировать их надо **раздельно**:

- **Схемы нод** — верх инспектора.
- **Схемы компонентов и эффектов** — внутри своих карточек. Группы карточки наружу не
  вылезают, глобальный порядок им не нужен: порядок объявления.

Для нод — фиксированный костяк плюс середина в порядке объявления:

```
[Header]  имя/тип, editor flags (visible, locked)     — не секция
1 Node       ← Base, Identity, General, Editor, Component, Debug, Runtime, Lifecycle
2 Transform  ← Transform, Position, Rotation, Ordering
3 Layout     ← Size, Anchors, Flow          (только Node2D; см. §3.2)
4 …группы конкретной ноды В ПОРЯДКЕ ОБЪЯВЛЕНИЯ СХЕМЫ (базовый класс, затем наследник)…
5 Animations   (карточка клипов)
6 Effects      (карточки)
7 Components   (карточки)
```

- Таблица псевдонимов выше — **всё** отображение. Что в неё не попало, идёт в бэнд 4
  в порядке объявления. **Алфавитный фолбэк удаляется**: алфавит произволен для
  пользователя и мешает автору схемы поставить `Sprite` выше `Slice`. Godot и Unity
  рисуют свойства в порядке объявления ровно поэтому.
- `PROPERTY_GROUP_ORDER` сжимается до трёх псевдонимов со списками членов; `Patch`,
  `Slice`, `Tile`, `Style`, `Sprite`, `Spine`, `Animation` из него удаляются.
- **Секции плоские и сворачиваемые (по-годотовски), а не аккордеон.** Аккордеон Unity
  уместен для *компонентов* — самостоятельных объектов со своим enable (их и оставляем
  карточками в 5–7); свойства одной ноды — плоские сворачиваемые секции.
- **Свёрнутость по умолчанию** — только когда схема просит: `groups[name].expanded === false`
  (поле уже есть, надо начать его читать). Кандидаты: `Debug`, `Editor`, `Limits`,
  `Confiner`, `Trails`, `Sub Emitter`, `Shadow`. `Node`/`Transform`/`Layout` не сворачиваются.
- **Состояние сворачивания** живёт в `localStorage` под одним ключом
  `pix3.inspector.collapsed`, ключ записи — `(nodeTypeId, sectionName)`.
- Группа из одного свойства рендерится без заголовка (обобщение нынешнего `hideTitle`).

### 3.2 Anchors и Flow — одна модель

**Словарь (снимает тройную перегрузку «Align»):**

| Понятие | Слово | Где |
| --- | --- | --- |
| Разовое перемещение выделения | **Align** / **Distribute** | тулбар вьюпорта, `Node ▸ Align ▸`, `Node ▸ Distribute ▸` |
| Постоянное правило: где ЭТА нода в родителе | **Anchors** | секция Layout, `group: 'Anchors'`, `layoutEnabled` |
| Постоянное правило: где ДЕТИ этой ноды | **Flow** | секция Layout |
| Перпендикулярная ось флоу | **Cross Axis** | `flow.align` (было «Cross Align») |

«Anchors» — термин, общий для Godot (`Layout ▸ Anchors`) и Unity (RectTransform Anchors),
и он уже в коде (`anchor`-свойство, иконка `anchor`). «Align» освобождается под разовые
операции — как в Figma.

**Anchors и Flow ортогональны** (панель может растягиваться по родителю *и* раскладывать
детей колонкой), и действуют на разные ноды: на себя и на детей. Поэтому — **не** радио
`None / Anchors / Flow`, а одна секция Layout с двумя подблоками:

```
▾ Layout
  Size            W [ ]  H [ ]   [lock]
  ─ Anchors ────────────────────────────  [switch ●]
    (превью якорей + ряды H/V — как сейчас)
  ─ Flow ───────────────────────────────  [switch ○]
    Stack children in tree order.          ← подсказка, только когда выключено
```

- **Компонент заголовка подблока** — `inspector-subsection`:
  `header (span.title + правый слот) + body`. В правом слоте — `inspector-switch`.
  Нынешние `anchor-section-header`/`anchor-toggle-button` и строка-чекбокс `flowEnabled`
  удаляются: форма у обоих одна.
- **Аффорданс** — переключатель `role="switch"`, а не кнопка с текстом `Enabled/Disabled`
  (она читается инвертированно: подписана текущим состоянием, а выглядит действием) и не
  чекбокс внутри тела (невидим, когда тело свёрнуто). Прецедент — чекбокс в шапке
  компонента Unity.
- **Выключенное состояние**: заголовок с выключенным свитчем + одна приглушённая строка
  подсказки («Position this node against its parent edges.» / «Stack this node children
  in a row or column.»). Клик по подсказке включает — дешёвая открываемость.
- **Ребёнок под флоу-родителем.** Проверено по `Node2D.applyFlowLayout()` и
  `resolveHorizontalLayout`/`resolveVerticalLayout`: рантайм **не** игнорирует якоря под
  флоу — оси поделены. Флоу владеет **главной** осью (по `direction`), а поперечную отдаёт
  якорю ребёнка, если тот включён (`crossOffset = anchored ? child.position.x : …`), иначе
  ставит по `Cross Axis` родителя. Главную ось флоу пишет и в `authoredLayoutPosition`,
  поэтому режим якоря по главной оси не «отменяется», а превращается в правило поведения
  при ресайзе родителя.

  Отсюда точная раскладка для вертикального флоу (для горизонтального — оси меняются):

  | Anchors ребёнка | `Position X` (поперечная) | `Position Y` (главная) |
  | --- | --- | --- |
  | выключены | ведёт `Cross Axis` родителя → disabled | ведёт флоу → disabled |
  | включены | авторская, редактируется | ведёт флоу → disabled |

  UI из этого: плашка вверху секции Layout — `Position driven by Flow on <Parent>` с
  кнопкой выбора родителя и одной строкой, какая ось кем занята; disabled ставится
  **только на ведомую ось** (идиома Unity «driven by LayoutGroup»), а не на оба поля и не
  на весь подблок Anchors. Подблок Anchors остаётся включённым; из режимов **главной**
  оси убирается `stretch` — он спорит с тем, как флоу измеряет размер ребёнка.

### 3.3 Система кнопок

Новых иконок регистрировать не нужно: `IconService` резолвит имена через `feather-icons`,
все нужные (`check`, `trash-2`, `eye`, `eye-off`, `lock`, `unlock`, `rotate-ccw`, `plus`)
там есть.

| Класс | Что | Правила |
| --- | --- | --- |
| `.inspector-btn` | тихое действие «иконка + подпись» | h 24px, иконка SMALL |
| `.inspector-btn--icon` | только иконка, 24×24 | **обязательны `aria-label` и `title`** (проверяется спекой) |
| `.inspector-btn--primary` | единственное «добавить» в списке | `plus` + «Add …», акцентный фон |
| `.inspector-btn--danger` | деструктивное | нейтральное в покое, красное на hover/focus — не кричит (как в Figma/Godot) |
| `.inspector-btn--toggle` | кнопка с состоянием | `aria-pressed`, акцентный текст |
| `.inspector-switch` | постоянный on/off *сущности* | `role="switch"`, `aria-checked` |

- **Иконка без подписи** — когда кнопка в ряду/заголовке с ≤ 3 соседями и иконка
  однозначна в контексте (`trash-2`, `plus`, `eye`, `lock`, шеврон). Иначе — с подписью,
  и всегда с подписью там, где у действия нет конвенционной иконки (Fit Group,
  Extract Keys, Copy Resource Path).
- **Enable/Disable — не кнопка, а состояние** → `inspector-switch`. Заодно снимается вопрос
  иконки: `eye`/`eye-off` в редакторе уже значат *видимость* (ряд editor flags, Scene Tree),
  и переиспользовать их под «компонент включён» — ложный друг; `power` — метафора прибора,
  её не использует ни один редактор.
- **Remove** = `.inspector-btn--icon.inspector-btn--danger` + `trash-2`,
  `aria-label="Remove <name>"`. `x` остаётся за закрытием эфемерного (чипы, поповеры),
  не за удалением сохранённого.

Отображение существующих классов:

| Было | Стало |
| --- | --- |
| `component-action-link` (Enable/Disable) | `inspector-switch` в шапке карточки |
| `component-action-link--danger` (Remove) | `.inspector-btn--icon.inspector-btn--danger` + `trash-2` |
| `anchor-toggle-button` | `inspector-switch` в `inspector-subsection__header` |
| строка-чекбокс `flowEnabled` | то же |
| `editor-flag-button` | `.inspector-btn--icon.inspector-btn--toggle` (`eye`/`eye-off`, `lock`/`unlock`) |
| `summary-toolbar-button` | `.inspector-btn--icon` |
| `btn-icon` (plus/trash клипов) | `.inspector-btn--icon` + `--primary` / `--danger` |
| `btn-add-behavior` | `.inspector-btn--primary` |
| `btn-add-group` (голое «Add») | `.inspector-btn--primary` + иконка `plus` |
| `inspector-button(--primary)` | `.inspector-btn(--primary)` — переименование |
| `size-lock-button`, `lock-btn` | `.inspector-btn--icon.inspector-btn--toggle` |
| `size-reset-button`, `reset-btn`, `property-revert-button` | `.inspector-btn--icon` + `rotate-ccw` |
| `anchor-mode-button` | сегментированный контрол `inspector-segment` (`role="radiogroup"`) — это радио, а не кнопки |

Стили — один соседний файл `src/ui/object-inspector/inspector-controls.ts.css`, весь
скоупленный под тег хоста (грабли утечки Light-DOM-стилей уже ловили на диалогах).
Правила старых классов удаляются по мере миграции.

Найдено при подготовке G8 и чинится там же: `inspector-panel.ts.css` (1894 строки) не
заскоупен **ни одним** правилом — это глобальные Light-DOM-селекторы, среди них
`pix3-panel { height: 100% }`, который бьёт по **каждой** панели редактора, а не только по
инспектору. И первое правило файла — `inspector-panel { … }`, тогда как элемент называется
`pix3-inspector-panel`, то есть селектор мёртвый. Новые примитивы сразу пишем под
`pix3-inspector-panel …`, а утёкший `pix3-panel` и мёртвый селектор убираем.

---

## 4. План миграции

Каждый шаг самостоятелен. «Meta» = правки только метаданных команд.

| # | Шаг | Тип | Файлы | Рантайм? |
| --- | --- | --- | --- | --- |
| G1 | Убрать `menuPath`/`menuOrder` у пяти `scene.create-*` (фантомные меню «Create/2d», «Create/3d»); `scene.save` → `addToMenu:false`; `insert` → `create` у `CreatePrefabInstance` | Meta | `features/scene/Create*Command.ts`, `SaveSceneCommand.ts`, `CreatePrefabInstanceCommand.ts`, `ui/shared/pix3-main-menu.ts` | нет |
| G2 | Инфраструктура бэндов: обязательный и уникальный `menuOrder` + спека; авторазделители по смене сотен; подменю через `/` (фаза 1 — озаглавленные группы); новый порядок секций `['file','edit','create','node','view','run','project','window','help']` + лейблы | Editor | `services/core/CommandRegistry.ts` + новая `CommandRegistry.menu.spec.ts`, `pix3-main-menu.ts(.css)` | нет |
| G3 | Переезд и переименование всех команд по таблице §2.4 | Meta | ~45 `*Command.ts` | нет |
| G4 | `checked` в `CommandMetadata`; `menuitemcheckbox` + галка; реализовать на 9 тогглах, воркспейсе и режимах трансформации; `isActive` тулбара → тот же предикат | Editor | `core/command.ts`, `CommandRegistry.ts`, `pix3-main-menu.ts`, `features/viewport/Toggle*`, `SetTransformModeCommand.ts`, `SwitchWorkspaceModeCommand.ts`, `ui/viewport/editor-tab.ts` | нет; флаги, живущие не в `appState.ui`, сначала переехать туда |
| G5 | Меню Window: фабрика `ShowPanelCommand` над `LayoutManager.focusPanel` с добавлением, если панели нет; `window.reset-layout`; частные `reveal*Panel` сводятся к общему пути | Editor | новые `features/window/*`, `core/LayoutManager.ts` | нет |
| G6 | 16 команд Align/Distribute под `node/align`, `node/distribute`; preconditions зеркалят `canAlignToContainer` / `canAlignToSelectionBounds` / `canDistributeSelection`. **Без дефолтных шорткатов**: фигмовские `Alt+A/D/W/S` конфликтуют с Chrome и переключением раскладки Windows — слот оставляем пользователю | Editor | новый `features/alignment/Align2DMenuCommands.ts`, `types.ts` | нет |
| G7 | Вылетающие подменю (апгрейд G2) | Editor UI | `pix3-main-menu.ts(.css)` | нет |
| G8 | Примитивы инспектора (`inspector-controls.ts.css`) + миграция карточек Components/Effects (свитч + `trash-2`) и ряда editor flags — этим одним шагом уходит идиома текстовых ссылок | Editor UI | `ui/object-inspector/*`, поправить `inspector-panel.spec.ts` (ассерт на текст `'Enable'` → `aria-checked`) | нет |
| G9 | Добить кнопки (клипы, add-кнопки, size/lock/revert, локализация, fit group) и удалить старые правила | Editor UI | остальные `object-inspector/*` | нет |
| G10 | Таксономия секций: псевдонимы Node/Transform/Layout, середина в порядке объявления, сворачивание, чтение `expanded`, `localStorage` | Editor UI | `inspector-property-renderers.ts`, `inspector-panel.ts.css` | опционально и позже: проставить `groups: { Debug: { expanded: false } }` в схемах |
| G11 | Секция Layout: `inspector-subsection` для Anchors и Flow со свитчами, подсказки в выключенном состоянии, плашка «driven by Flow», disabled Position/Anchors у ребёнка | Editor UI + **строки рантайма** | `inspector-property-renderers.ts`, `packages/pix3-runtime/src/nodes/Node2D.ts` (`'Anchor'`→`'Anchors'`, `'Cross Align'`→`'Cross Axis'`) | **да** — только лейблы/имена групп; сначала подтвердить семантику «якоря под флоу», потом `yalc:publish` |
| G12 | Документация: словарь Layout в спеку, правила бэндов/`checked`/именования в `AGENTS.md`, примитивы кнопок в скилл `pix3-ui-conventions` | Docs | по списку | нет |

Зависимости: G2 → G3/G4/G5/G6; G8 → G9/G11. G10 и G11 независимы. G1 можно мержить сразу.
