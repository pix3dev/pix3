# Фичи других движков: что перенять, что уже есть, что пропустить

Аудит против Godot, Unity (+Cinemachine/DOTween/Feel), Unreal, Cocos Creator, Defold, Phaser и практик playable-индустрии (Luna, Playable Factory). Статусы проверены по коду (`d591e68`). Вердикт = куда пункт ложится в [ROADMAP.md](ROADMAP.md).

**Сюрпризы аудита — уже есть в Pix3** (не тратить время): nine-slice ([TiledSprite2D](../packages/pix3-runtime/src/core/tiled-sprite-geometry.ts), паритет с Godot NinePatchRect) · виртуальный джойстик ([Joystick2D](../packages/pix3-runtime/src/nodes/2D/UI/Joystick2D.ts)) · префабы с overrides ([prefab-utils](../src/features/scene/prefab-utils.ts)) · сигналы/группы/автолоады (Godot-паритет) · flipbook-анимации с per-frame коллизией · ECS-инстансинг · undo/redo через operations · **встроенная AI-генерация ассетов** (такого нет ни в одном движке из списка) · iOS haptics в экспорте.

## Камера

| Фича | Откуда | В Pix3 | Вердикт |
|---|---|---|---|
| Виртуальные камеры: priority, blend, damping, deadzone, confiner | Unity Cinemachine | ❌ только Camera3D + FollowBehavior (math переиспользуема) | **P0.1** |
| Impulse/shake source | Cinemachine Impulse | ❌ | **P0.3** (в juice-библиотеку) |
| **Camera2D**: offset/zoom/limits/drag-margins для 2D-слоя | Godot Camera2D | ❌ 2D-пасс без камеры вообще — фиксированная орто | **P0.1** (под-пункт, M). Недооценённый гап: без него 2D-игры не могут панорамировать/зумить |
| Dolly/rail: камера по сплайну | Unreal Rig Rail, Cinemachine Dolly | ❌ | P3 — сначала vcam-бленды покрывают 80% |

## Таймлайн и анимация

| Фича | Откуда | В Pix3 | Вердикт |
|---|---|---|---|
| Event/method-треки (в t → вызов/сигнал) | Godot call tracks, Unity Timeline Signals | ❌ модель готова принять новый `kind` | **P0.4** |
| Анимация любого свойства по пути | Godot AnimationPlayer | ✅ property-треки через property schema | есть — главный актив |
| Аудио-трек в клипе | Godot, Unity Timeline | ✅ | есть |
| Бленд/очередь клипов, FSM | Unity Animator, Godot AnimationTree | ❌ один активный клип | P3 (AnimationTree-lite). Для playables хватает event-трека + скриптов |
| Редактор кривых (Безье) вместо enum-easing | Unity curves | ⚠️ 20 пресетных easing на сегмент | P3 — пресеты покрывают juice; кривые = полировка |
| Маркеры/регионы на таймлайне | Unity Timeline | ❌ | P2-опция при доработке панели, S |
| Анимационные события flipbook-анимаций (кадр → сигнал) | Unity/Godot sprite events | ❌ | **P1** |

## Juice / VFX

| Фича | Откуда | В Pix3 | Вердикт |
|---|---|---|---|
| Time.scale + hitstop + slow-mo | везде (Unity Time.timeScale) | ❌ timeScale отсутствует | **P0.3** |
| Feedbacks-as-components (shake/flash/punch пресеты) | Unity Feel/MMFeedbacks | ⚠️ есть behaviors-паттерн (Fade, Sine…) — расширить | **P0.3** |
| Chainable tween API (`.to().delay().onComplete()`) | DOTween, Godot Tween | ⚠️ tween/easing есть, сахар-API нет | P1-S: обёртка над существующим, сильно упрощает скрипты и агентский код |
| Post-processing: bloom/vignette/CA/LUT | Unreal, Unity URP | ❌ | **P0.2** |
| Пресетные шейдер-эффекты (dissolve, rim, flash-tint) | Godot shaders, ассет-сторы | ❌ | **P1** |
| Sub-emitters, trails у партиклов | Unity Shuriken | ❌ | **P1** |
| Trail/Line renderer нода | Unity | ❌ | P2/P3 |
| Экранные переходы (fade/wipe между сценами) | Godot-паттерн, Construct | ❌ | P1-S: оверлей + 2 пресета; playables постоянно это делают |
| Библиотека VFX-пресетов (coin collect, explosion, confetti) | ассет-сторы | ❌ | **P2** (двойное назначение: дизайнер + агент) |

## UI / текст

| Фича | Откуда | В Pix3 | Вердикт |
|---|---|---|---|
| Rich text + эффекты текста (typewriter, wave, shake) | Godot RichTextLabel | ❌ Label2D простой | P2-M: typewriter+wave — дешёвый juice для интро/диалогов |
| Theme-система UI | Godot Theme | ❌ | skip — playables рескинят per-game спрайтами |
| Safe area helpers | Unity Device Simulator | ⚠️ layout/anchors есть | **P1** (в device-preview) |

## Аудио

| Фича | Откуда | В Pix3 | Вердикт |
|---|---|---|---|
| Шины Master/Music/SFX + снапшоты (muffle при slow-mo/паузе) | Unity AudioMixer | ❌ только masterGain | **P1** |
| Random pitch/volume контейнеры | FMOD/Wwise-lite, Godot randomizer | ❌ | **P1** (одним пунктом с шинами) |
| Spatial panner | three/WebAudio | ✅ panner есть | есть |

## Инпут

| Фича | Откуда | В Pix3 | Вердикт |
|---|---|---|---|
| Жесты: swipe/pinch/tap-hold | Cocos, Phaser | ❌ raw pointer events | P2-S/M: playables живут на свайпах; сейчас каждый скрипт пишет своё |
| Action maps (переименованные действия) | Unity Input System, Godot InputMap | ⚠️ virtual axes/buttons есть | P3 — текущего хватает |
| Input buffering | fighting-game практика | ❌ | skip до запроса |

## Ассеты и экспорт (бизнес)

| Фича | Откуда | В Pix3 | Вердикт |
|---|---|---|---|
| Ad-network адаптеры (mraid, события, CTA, пресеты сетей) | Luna, Playable Factory | ❌ single-file build есть, адаптеров нет | **P0.6** |
| Минификация бандла | везде | ❌ не обнаружена в экспорте | **P0.6** (quick win) |
| Sprite atlas packing | Unity SpriteAtlas, TexturePacker | ❌ | **P1** (компрессия экспорта) |
| Авто-конверсия в WebP + audio bitrate | playable-практика | ⚠️ compress есть в AssetGenService — не подключён к экспорту | **P1** |
| Device simulator (аспекты, ориентации, notch) | Unity | ❌ | **P1** |
| Texture compression KTX2/basis, Draco | three ecosystem | ❌ | P3 |
| Размерный бюджет-репорт | — | ✅ size report в экспорте | есть — расширить рекомендациями |

## Workflow / редактор

| Фича | Откуда | В Pix3 | Вердикт |
|---|---|---|---|
| Hot reload значений в play mode | Defold live update, Unity play-mode edit | ❌ | **P0.5** |
| Pause / frame-step в play mode | Unity | ❌ | P2-S (вместе с bridge `step(n)`) |
| Remote scene tree запущенной игры | Godot remote tree | ✅ `liveScene()` в мосте + Runtime panel | есть |
| Prefab variants | Unity | ⚠️ инстансы+overrides есть, вариантов нет | P3 |
| Project/scene templates + примеры | Godot, Construct | ❌ | **P2** (вместе с пресетами) |
| Command palette (Ctrl+Shift+P) | VSCode | ⚠️ CommandRegistry с метаданными уже есть | P2-S: почти бесплатно поверх реестра |
| Drag&drop ассетов во viewport | все | ❌ (TODO L) | P1/P2 по TODO |

## AI-agent pipeline (дифференциатор — аналогов в движках нет)

| Фича | Аналог | В Pix3 | Вердикт |
|---|---|---|---|
| Управление редактором из агента | Unity MCP-эксперименты | ✅ CDP-мост v2 | есть |
| Параметризованные команды, CRUD нод, authoring таймлайна из агента | — | ❌ | **P2 bridge v3** |
| Машиночитаемый каталог возможностей (`capabilities()`) | — | ❌ реестры есть, экспорта нет | **P2** |
| JSON Schema сцены + манифест ассетов с метаданными | Unity asset database | ⚠️ manifest путей | **P2** |
| Headless run-and-report | CI-практика | ❌ | **P2** |
| AI-генерация ассетов в редакторе | — | ✅ вкл. bg-removal, компрессию | есть, опережает рынок |
