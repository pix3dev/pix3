# Flow recipes — implementation contract (v1)

Binding для реализации фазы 1 режима Flow. Источник решений: `.plans/prompt-to-playable-flow.md`
§5.2/§5.3/§6 + архитектурный разбор (Fable, 2026-08-12). Всё ниже — обязательно; расхождение
между рецептом и этим файлом = баг.

## 1. Каталог рецептов v1

| id (папка `src/templates/projects/<id>/`) | Что это | Жанровый охват |
| --- | --- | --- |
| `recipe-tapper-2d` | объекты появляются, тап по ним — вся игра, таймер/жизни | тапалки, whack-a-mole, catch-the-falling, кликеры |
| `recipe-arena-2d` | аватар в ограниченном поле, спавнер сыпет пикапы/опасности, касание = очки/урон | доджеры, коллекторы, top-down выживание, (свопом движения) раннеры — **не** grid/turn-based |
| `recipe-bouncer-2d` | мяч под гравитацией отскакивает от стен/паддлов/бамперов, паддл держит его в игре | арканоид, понг, plinko, **пинбол** |
| `recipe-playable-ad` | существующий `playable-2d`, промотированный в каталог | playable-реклама (tap-gate + CTA) |
| `recipe-blank-2d` | **без механик**: пустое поле + очки/жизни/таймер + HUD + win/lose оверлей | всё, чего нет выше: grid/turn-based (змейка, sokoban, match-3), word/card/board, билдеры, idle |

Фолбэки расщеплены по типу сигнала (`validateBrief`), и это существенно:

- **Молчание** (нет `recipeId`, ответ не распарсился, `fallbackBrief`) → `recipe-arena-2d`.
  Об идее не сказано ничего, так что берётся то, что уже играет: живой стейдж с первого кадра —
  инвариант Flow.
- **Выдуманный id** → `recipe-blank-2d` (для `/3d/i` в id → `recipe-scene-3d`). Планировщик потянулся
  за пределы каталога — это утверждение «ничего не подошло», и отвечать на него готовой механикой
  значит отдать агенту первый инкремент на снос. Именно так идея вида «змейка» получала аренное поле
  с падающими пикапами.

В обоих случаях в `design/brief.md` пишется строка «planner asked for `<id>`; started from `<...>`».

**Пустой рецепт везёт всё, что нужно для *исхода* прогона, и ничего, что подразумевает *механику*:**
`GameRules` (очки/жизни/таймер/win-lose/`restart`/`registerGameDebug`) + `ScoreHud`, одна сцена
`scenes/main.pix3scene` с `game-root`/`board`/`hud`/`result-overlay` (ids как в арене — наработки
переносятся), **без `entryScene` и без сцены меню**, без плейсхолдеров. Первый инкремент = сама
механика, включая управление.

Идентификация рецепта = префикс `recipe-` в id. `template.yaml` схему НЕ меняем (парсер игнорирует
неизвестные ключи, pitch = существующее поле `description`).

## 2. Проверенные ограничения движка (не обходить, а закладываться)

1. **Физического солвера в движке нет.** `core:Hitbox2D` — overlap-тесты, и его формы
   **axis-aligned, поворот игнорируется**. Поэтому непрерывная физика мяча и вращающиеся флипперы
   живут в скрипте рецепта `BallBody.ts` (swept circle-vs-segment/circle + фиксированные субшаги),
   а коллайдеры читаются из **мировых трансформов маркер-нод** — тогда повёрнутый флиппер работает.
2. **Rapier не импортировать.** `src/core/lazy-rapier.ts` тянет ~2 MB wasm лениво; ни один скрипт
   рецепта не должен его импортировать — это и бюджет «≤90 с до играбельного», и размер экспорта.
3. **Конфиг компонента на инстансе префаба править нельзя** — `UpdateComponentPropertyCommand`
   блокирует (`PREFAB_COMPONENT_LOCK_REASON`). Значит **все тюнабл-несущие компоненты стоят на
   обычных нодах главной сцены**, а префабы несут только фиксированные дефолты (например группу
   Hitbox2D).
4. HUD — под `CanvasLayer2D`, чтобы будущая камера его не таскала.
5. Порядок отрисовки 2D — порядок в дереве (см. CLAUDE.md «2D overlay rendering»).

## 3. Анатомия рецепта

```
src/templates/projects/recipe-<id>/
  template.yaml              # id, title, description(=pitch), projectType: 2d, viewport, entryScene, order
  cover.png
  files/
    README.md
    design/recipe.md         # машиночитаемый контракт (§4)
    scenes/menu.pix3scene
    scenes/main.pix3scene
    scenes/prefabs/*.pix3scene
    scripts/*.ts             # МЕЛКИЕ файлы с одной ответственностью, ориентир 70–140 строк
    sprites/ph-*.png         # почти белые плейсхолдеры (тинтуются палитрой брифа)
```

Правило мелких файлов — требование надёжности, а не стиль: в монолите модель уходит в полную
перезапись и теряет собственные правки (измерено в eval S4). Один файл = одна ответственность.

Скрипты объявляют тюнаблы как `config`-ключи + `static getPropertySchema()` с `ui.min/max/step/
slider` (образец — `src/templates/projects/playable-2d/files/scripts/GameFlow.ts`). **`setValue`
обязан клампить** — схема и есть валидатор, диапазоны в `recipe.md` лишь документируют её.

## 4. `design/recipe.md` — фиксированная структура

Секции ровно с этими заголовками (по ним грепает и агент, и экспандер):

```
# Recipe: <id>
## What this is
## Node map          — стабильные id нод, на которые ссылаются тулы и этот файл
## Placeholders      — таблица role | file | node/prefab
## Tunables          — ```yaml блок (машинно-парсится, см. ниже)
## Extension points  — «чтобы добавить X — сделай Y», с именами тулов
## Do not touch      — id нод, имена сигналов, запрет тюнаблов на инстансах префабов
## Verify            — как доказать играбельность (play_start → game_input → ожидание)
```

Целевой размер файла < 4 KB — он идёт в кэшируемый префикс промпта.

Формат `Tunables` (единственный машиночитаемый блок):

```yaml
tunables:
  playerSpeed: { node: player, component: "user:PlayerController", property: speed, min: 100, max: 900, default: 420 }
  bgColor:     { node: game-background, property: color, default: "#0f3460" }
```

`component` присутствует → писать через `set_component_property`; отсутствует → `set_property`.

## 5. Экспандер (`PrototypeBootstrapService`)

Порядок: (1) `ProjectService.createNewProjectWithOptions({ backend: 'browser', templateId })`;
(2) **до открытия сцены** — правка скопированных файлов на месте (парсинг `.pix3scene` через `yaml`,
патч по стабильному id ноды, сериализация обратно; тинт плейсхолдеров; запись `design/*.md`);
(3) открыть и запустить. Патч текста до первой загрузки = никаких гонок и никаких операций.

Маппинг полей `PrototypeBrief`:

| поле | артефакт |
| --- | --- |
| `recipeId` | выбор шаблона (+ fallback `recipe-arena-2d`) |
| `title` | имя проекта, `title-label` в меню, шапка Flow |
| `pitch` | `design/brief.md` |
| `style.palette` | тинт плейсхолдеров по ролям + `bgColor` |
| `style.artStyle`/`mood` | только текст в `design/brief.md` + `design/style.md` |
| `entities[]` | привязка ролей к плейсхолдерам; лишние сущности — в «For the agent» |
| `tunables` | патч YAML по блоку `tunables:` из `recipe.md`, кламп по min/max; **неизвестные ключи не угадывать**, а записать в `brief.md` |
| `winLose` | **детерминированного маппинга нет** — свободный текст в `brief.md`, разводку делает агент первым инкрементом |
| `increments` | чек-лист `design/progress.md` (формат `- [ ]` / `- [~]` активный / `- [x]`) |
| `ctaUrl` | только `recipe-playable-ad` |
| `references[]` | пути + роли в `brief.md` (сами файлы уже сохранены, §5.7 плана) |

`design/progress.md` парсится `FlowPlanService` (`src/services/flow/FlowPlanService.ts`) —
формат чек-листа менять нельзя: `- [ ] Заголовок — заметка`.

## 6. Защита от дрейфа контракта

На каждый рецепт — vitest-спека, которая парсит `tunables:` из его `design/recipe.md` и проверяет,
что каждый `node` существует в YAML сцен шаблона, а каждый `property` объявлен в
`getPropertySchema()` названного скрипта. Дрейф должен падать тестом, а не в поле.
