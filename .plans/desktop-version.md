# Desktop-версия Pix3 (single exe + MS Store)

**Приоритет: низкий** — вернуться после стабилизации самого редактора.
Записано: 2026-07-23.

## Цель

Скачиваемая десктоп-версия редактора с глубокой OS-интеграцией, которую браузер/PWA дать не может. Два жёстких требования:

1. **Single-file exe** (portable, killer feature).
2. **Публикация в MS Store** (MSIX).

Браузерная версия остаётся первоклассной — десктоп это дистрибутивная обёртка над тем же фронтендом, не форк.

## Решение по стеку

- **Продуктовая оболочка: C# / Photino.NET + Kestrel на loopback** — по образцу `C:\Projects\AssetsBoss` (референс-реализация: embedded frontend через `ManifestEmbeddedFileProvider`, нативный сплэш с гонко-безопасной навигацией, `ShellLauncher`, `tools/package.ps1` → self-contained single-file publish под win-x64/win-arm64).
- **MVP-мост: Node/TypeScript** — самый быстрый способ получить нативные возможности; живёт рядом с `tools/pix3-agent-bridge` (тот же паттерн discovery + pairing). Позже заменяется C#-хостом без изменений в редакторе.
- Electron отвергнут (нет single exe), Tauri отвергнут (третий язык, поверх того же WebView2 ничего не добавляет).

## Ключевой принцип: contract first

Редактор получает **один** `NativeFileSystemBackend`, говорящий по фиксированному HTTP/WS-протоколу, и не знает, кто хост — Node или Kestrel. Node-MVP и C#-продукт — взаимозаменяемые реализации одного контракта.

### Поверхность контракта

Фактически уже описана публичными методами `src/services/project/FileSystemAPIService.ts`:

- **fs CRUD**: `readTextFile`, `readBlob`, `writeTextFile`, `writeBinaryFile`, `listDirectory`, `createDirectory`, `deleteEntry`, `moveEntry`, `copyDirectoryContents`
- **watch**: подписка на пути → WS-push событий (заменяет 2.5-секундный поллинг `FileWatchService`)
- **shell**: reveal-in-explorer, open-in-default-app, open-in-app (VS Code/Photoshop/Blender), browse-folder диалог
- **handshake/health**: версия протокола, capabilities

Зафиксировать контракт маленьким OpenAPI-файлом или каноничными TS-типами в отдельном пакете; C#-зеркало руками (поверхность крошечная).

### Auth

- **Release**: хост сам отдаёт фронтенд → same-origin, токен не нужен; хост инжектит порт/флаг в страницу.
- **Dev**: Vite (5173) + хост на другом порту → CORS + pairing-токен, как у agent-bridge / AssetsBoss dev-режима.

## Что это даёт редактору

- Настоящий file watcher вместо поллинга — правки скриптов в VS Code подхватываются мгновенно.
- Shell-интеграция: reveal, «открыть в …» для ассетов.
- Нет FSAA permission-промптов; файловые ассоциации (`.pix3` двойным кликом), recent projects, произвольные пути.
- Нативные тулы в пайплайне: Blender CLI (импорт → GLB), ktx2/basis-компрессия текстур, ffmpeg, git.
- SQLite FTS-индекс ассетов + кэш миниатюр (реюз идей AssetsBoss) для панели Library/Assets.
- Store закрывает автообновления бесплатно.

## План работ (каждый шаг самоценен)

1. **Контракт** — OpenAPI/TS-типы native-host API.
2. **Seam в редакторе** — выделить `IFileSystemBackend` из `FileSystemAPIService` (path-based методы уже чистые; `ProjectStorageService` уже мультиплексирует local/cloud — добавляется третий бекенд `native`). `FileWatchService` учится брать push-события вместо поллинга при наличии хоста.
3. **Node-хост (MVP)** — в репо, fs + watch (chokidar) + shell; сразу даёт суперспособности и браузерной версии при запущенном мосте. Ограничения MVP: нет нативного browse-folder диалога из headless-процесса (допустим хак/скип), нет ассоциаций.
4. **C#/Photino-хост** — реализует тот же контракт, embed собранного фронта, сплэш, `package.ps1` → single exe (win-x64 + win-arm64).
5. **MSIX / MS Store** — упаковка, сертификация.

## MSIX-нюансы (проверено логикой, перепроверить на практике)

- Loopback (Kestrel на 127.0.0.1) для packaged Win32 с `runFullTrust` **работает** — network isolation бьёт только AppContainer/UWP.
- MSIX **виртуализирует AppData**: записи в `%LOCALAPPDATA%\Pix3\` уедут в package-local VFS. Для кэшей/индекса ок (чистое удаление), но данные, общие со standalone-exe, класть в явно выбранные пользователем папки.
- `http://127.0.0.1` — trustworthy origin: OPFS, service worker (`src/sw.ts`), esbuild.wasm в WebView2 работают как в Chrome. FSAA-пикеры в десктопе не нужны — файлы идут через хост.
- WebView2 Evergreen: версия плавает у пользователей (у нас уже был ANGLE/D3D11 mipmap-баг → рендер-quirks возможны). Fixed-Version distribution ломает single exe (~+200 МБ) — принимаем Evergreen.

## Открытые вопросы

- **agent-bridge — Node**, в C#-бинарь не встраивается. MVP: остаётся отдельным npx-компаньоном. Позже: либо порт lane-ов на C#, либо десктоп умеет сам скачать/поднять bridge.
- Стратегия синхронизации версий фронта, встроенного в exe, с браузерной версией (версионирование контракта).
- Нужен ли отдельный `@pix3/desktop-bridge` пакет или fs-эндпоинты добавляются в agent-bridge.
