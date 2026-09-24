# Vibe: UI-кит из Forge с первого кадра

**Постановка (2026-09-06):** при создании игры в Vibe-режиме сразу использовать UI Kit,
сделанный в нашем конструкторе (UI Kit Forge) — не только на четырёх типах нод рецепта,
а как «тему проекта»: с типографикой, шрифтами, готовыми префабами окон и так, чтобы всё,
что агент добавляет потом, тоже выходило в ките. Если пользователь успел собрать свою тему
в Forge до нажатия CTA — использовать её, а не выводить из палитры.

## Что есть сегодня (проверено по коду)

`PrototypeBootstrapService.skinRecipeUi` (T0-экспандер) уже выводит `ForgeTheme` из брифа
(`deriveUiKitTheme`), печёт кит (`UiKitProjectWriter.writeKit`, роли green/blue/red/gray,
без глифов) и патчит YAML рецептных сцен через `planSkinPatches` для `Button2D` /
`Checkbox2D` / `Slider2D` / `Bar2D`. Дальше — дыры:

1. **Баг: декларация шрифтов затирается.** `writeKit` (fonts: true по умолчанию) скачивает
   woff2 в `fonts/` и мержит их в манифест через `mergeManifestFonts` →
   `saveProjectManifest`. Сразу после этого `expandIntoCurrentProject` делает
   `saveProjectManifest(manifest)` с манифестом, собранным ДО бейка
   (`buildPrototypeManifest` не несёт `fonts`). Итог: файлы на диске, в `pix3project.yaml`
   их нет, `ProjectFontLoader` их не регистрирует.
2. **Типографика не применяется.** T0 зовёт только `planSkinPatches`; `planCaptionPatches`
   (гарнитура, вес, обводка, тень, трекинг, размер) — нет. Кнопка получает текстуру и
   оставляет рецептный `labelColor: "#141a2e"` (подобранный под плоский амбер) и Arial.
   `Label2D` не трогается вовсе.
3. **Кит не печётся, если в рецепте нет UI-нод** («guard молчит»). Агент потом строит
   меню/HUD и делает `skin_ui bake` сам — ход, который T0 должен был снять.
4. **Префабы окон не собираются.** `UiKitPrefabBuilder` (`dialog`, `settings`) вызывает
   только панель. Агент, которому просят «пауза/настройки», рисует ColorRect2D.
5. **Агент не знает кита конкретно.** В `design/style.md` ни слова о `kitId`, папке,
   ролях, префабах; только общая фраза в скилле game-prototype.md.
6. **`create_node` не скиннит.** Новая `Button2D` от агента — серый прямоугольник, пока он
   не вспомнит `skin_ui apply`.
7. **Своя тема из Forge игнорируется.** T0 всегда выводит тему из палитры, даже если в
   idea-проекте лежит `design/ui-theme.json`, сохранённый вкладкой «UI Kit».

## Решения

### A. Фикс манифеста (баг №1)
В `expandIntoCurrentProject` после `applyRecipe` перечитать текущий манифест
(`projectService.loadProjectManifest()`) и сохранить `{ ...manifest, fonts: current.fonts }`
(fonts только если непустой). Spec: после skin+save в манифесте есть `fonts`, объявленные
бейком.

### B. Типографика на T0 (№2)
- `recipe-contract.ts`: `SceneNodeRef` получает опциональное `properties?: Record<string,
  unknown>` (сырой `properties` из YAML). Обратно совместимо.
- `skin-planner.ts`: `CaptionPlanOptions` получает `inkColor?: string`; когда задан —
  пишется `labelColor` (для `Label2D` — `labelColor` тоже, у него так называется; проверить
  по схеме). Ручное «Apply to selection» и `skin_ui apply` его НЕ передают — цвет руки
  переживает рескин, как и размер.
- В uikit-ядре (`TemplateSpec.ts`, рядом с `buildTypography`) экспортировать
  `captionInkForRole(theme, role): string` = `ink(C(role))` — тот же расчёт, что у
  `inkColor` в `buildTypography`.
- `skinRecipeUi`: для нод из `CAPTION_NODE_TYPES` добавлять `planCaptionPatches(manifest,
  type, { text: props.label, height: props.height, currentFontSize: props.labelFontSize,
  inkColor: type === 'Button2D' ? captionInkForRole(theme, role) : undefined })`.
  Размеры рецепта (56/96/40) — «ручные», не трогаются (уже так работает).

### C. Всегда печь в Vibe (№3)
Убрать ранний `return` при `targets.length === 0`: кит печётся всегда, скиннится что есть.
Note в decision log: «Baked the "<preset>" UI kit (sprites/ui/<kitId>); no UI nodes to skin yet»
вместо молчания.

### D. Префабы окон на T0 (№4)
После бейка: `UiKitPrefabBuilder.buildAndWrite('dialog' | 'settings', theme, { manifest })`
→ `prefabs/ui/dialog-<kitId>.pix3scene`, `settings-<kitId>.pix3scene`. Инжектить лениво
(`@injectLazy`, как writer/theme). Проверить, какие части нужны шаблонам
(`TEMPLATES[...]`): у диалога кнопка-закрытие — глиф `icon-button`, а T0 печёт с
`iconButtons: false`. Добавить в `KitWriteOptions` `iconButtonGlyphs?: readonly string[]`
(печь только перечисленные глифы) и передать из T0 глифы, на которые ссылаются шаблоны;
если это разрастается — просто `iconButtons: true` (батчи: ~+0.7 с). Роли: убедиться, что
`UI_KIT_BOOTSTRAP_ROLES` покрывает роли частей шаблонов, иначе расширить список.
Ошибка сборки префаба — note, не падение T0.

### E. Кит в `design/style.md` (№5)
`skinRecipeUi` возвращает `{ kitId, preset, manifestPath, prefabs: string[], typography }`
(или null). `writeDesignDocs` получает его и `renderStyleMarkdown` дописывает секцию
`## UI kit`: kitId, папка `sprites/ui/<kitId>/`, роли и их смысл (green = primary action,
blue = secondary, red = destructive, gray = neutral), гарнитура, список префабов с
`res://`-путями и три правила для агента: (1) новую UI-ноду скиннить `skin_ui { action:
'apply' }` / она скиннится сама через `create_node`; (2) окна — `CreatePrefabInstance` из
`prefabs/ui/`, не ColorRect2D; (3) перекраска — `skin_ui restyle`, не новый bake.
Спека на рендер секции.

### F. `create_node` скиннит автоматически (№6)
В `AgentToolRegistry.createNode` после создания и `properties`: если тип ∈
`SKINNABLE_NODE_TYPES ∪ CAPTION_NODE_TYPES`, `args.texturePath` не задан и
`design/ui-kit.json` читается (`writer.readManifest()`, кэшировать на вызов) →
`dispatcher.execute(new ApplyUiKitSkinCommand({ nodeIds: [nodeId], colorRole:
uiKitRoleForNodeName(name), manifest, inkColor: … }))`. Нужен проброс `inkColor` через
`ApplyUiKitSkinCommandParams` → `ApplyUiKitSkinOperationParams` → `planCaptionPatches`
(опционально, по умолчанию не пишется). Результат тула дополняется `skinned: { kitId,
colorRole }`, чтобы агент видел, что произошло. Ошибка скина — предупреждение в результате,
не провал create_node.
`uiKitRoleForNodeName` переезжает из `PrototypeBootstrapService` в `skin-planner.ts`
(это правило скиннинга, не флоу); в бутстрапе — реэкспорт, чтобы существующий spec жил.

### G. Своя тема из Forge побеждает выведенную (№7)
В `skinRecipeUi`: `await themeService.load(true)`; если вернул `true` (в проекте есть
`design/ui-theme.json`) — брать `themeService.getTheme()` / `getPresetName()`, note
«Used your UI Kit theme (<preset>)». Иначе — `deriveUiKitTheme` как сейчас. Проверить, что
`applyTemplateFiles(..., { skip })` не удаляет файлы проекта вне шаблона; если удаляет —
добавить `design/ui-theme.json` в `IDEA_PRESERVED_PATHS`. Если `readManifest()` уже даёт
кит с тем же `kitId` — бейк пропустить (папка та же по построению), префабы всё равно
проверить/дописать.

## Что НЕ делаем
- Не трогаем `ColorRect2D`-фоны рецептов (это фон, не панель).
- Не добавляем пикер пресета в Vibe-композер — G закрывает «свою тему» без новой UI;
  пикер — отдельная задача, если понадобится.
- Не меняем рантайм.

## Проверка
- `npx vitest run --pool=threads src/services/flow src/services/uikit-editor src/features/uikit src/services/agent/AgentToolRegistry.spec.ts src/services/uikit`
- `npm run type-check`; eslint по изменённым файлам.
- Обновить `docs/nodes-and-systems.md` → «Use — the T0 expander» (типографика, префабы,
  своя тема, style.md, create_node).
