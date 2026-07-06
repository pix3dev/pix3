# Спецификация: Pix3 Collab Server (Cloud-First MVP)

Сервер совместной работы для Pix3 Editor. Выступает единым источником истины (Source of Truth) для проектов. Обеспечивает облачное хранение ассетов, скриптов, сцен и синхронизацию состояния в реальном времени (CRDT) без жесткой привязки к внешним системам контроля версий.

## 1. Архитектурный подход и изоляция

Система построена по модели **Cloud-First**. По умолчанию проекты живут исключительно на сервере. Опционально клиенты (PWA) могут привязать проект к локальной папке для использования сторонних инструментов (IDE, Git) через FileSystem API браузера.

Система логически разделяется на два модуля:

### Модуль 1: Core API (HTTP / Express или Fastify)

Отвечает за персистентное хранение файлов и метаданных.

* **Auth Service**: Классическая аутентификация по логину и паролю, управление сессиями и выдача JWT.
* **Project Service**: CRUD метаданных проектов, генерация Share Tokens для гостевого доступа.
* **Storage Service**: Хранение ассетов (изображения, модели) и исходных кодов скриптов на файловой системе сервера или S3.
* **БД**: Реляционная БД (SQLite/PostgreSQL) для пользователей и метаданных проектов.

### Модуль 2: Sync Server (WebSocket / Hocuspocus)

Отвечает исключительно за передачу дельт Yjs для активных сессий.

* Авторизует подключения по JWT.
* Хранит активные сессии в памяти.
* Сохраняет "горячее" состояние CRDT-документов в локальный SQLite (RocksDB).

## 2. Структура проекта (Monorepo)

```text
packages/pix3-collab-server/
├── data/
│   ├── core.sqlite        # Основная БД
│   ├── crdt.sqlite        # Состояние Hocuspocus
│   └── projects/          # Облачное хранилище файлов (ассеты, скрипты)
├── src/
│   ├── index.ts           # Точка входа (запускает оба модуля)
│   ├── core/              # Core API
│   │   ├── auth/          # Логика регистрации, логина и хэширования паролей
│   │   ├── projects/
│   │   ├── storage/       # Работа с файлами проектов
│   │   └── http-server.ts
│   └── sync/              # Sync Server (Кандидат на миграцию в Rust)
│       ├── hocuspocus.ts
│       └── store/
└── .env
```

## 3. Схема Базы Данных (Core API)

**Таблица `users`**

* `id` (UUID, PK)
* `email` (String, Unique) — используется как логин.
* `username` (String, Unique) — отображаемое имя пользователя.
* `password_hash` (String) — хэш пароля (на базе bcrypt или argon2).
* `avatar_url` (String, Nullable)
* `is_admin` (Boolean, Default: false) — флаг доступа к панели управления.

**Таблица `projects`**

* `id` (UUID, PK)
* `owner_id` (UUID, FK -> users)
* `name` (String)
* `share_token` (String, Nullable, Unique) — токен для гостевого доступа по ссылке.
* `updated_at` (Timestamp)

**Таблица `project_members`**

* `project_id` (UUID)
* `user_id` (UUID)
* `role` (Enum: `owner`, `editor`, `viewer`)

## 4. Спецификация API (Core API)

### 4.1 Авторизация (Логин и Пароль)

* `POST /api/auth/register` — Регистрация нового пользователя. Принимает `email`, `username`, `password`. Возвращает созданный профиль и устанавливает HttpOnly Cookie с JWT.
* `POST /api/auth/login` — Аутентификация. Принимает `email` и `password`. Сверяет хэш, устанавливает JWT в HttpOnly Cookie.
* `POST /api/auth/logout` — Завершение сессии (очистка Cookie).
* `GET /api/auth/me` — Получение метаданных текущего авторизованного пользователя.

### 4.2 Управление проектами

* `GET /api/projects` — Список проектов.
* `POST /api/projects` — Создание нового облачного проекта (создает папку в `data/projects/:id`).
* `POST /api/projects/:id/share` — Генерация `share_token`.
* `DELETE /api/projects/:id` — Удаление проекта (и его файлов).

### 4.3 Облачное Хранилище (Storage API)

API для синхронизации файлов (ассетов и бинарников), которые невыгодно держать в CRDT.

* `GET /api/projects/:id/files/*path` — Скачивание файла.
* `POST /api/projects/:id/files/*path` — Загрузка/перезапись файла.
* `DELETE /api/projects/:id/files/*path` — Удаление файла.
* `GET /api/projects/:id/manifest` — Получение хэшей всех файлов проекта для быстрой синхронизации (дерево проекта).

### 4.4 Панель управления (Admin API)

Доступно только пользователям с `is_admin = true`.

* `GET /api/admin/users` — Получение списка всех пользователей.
* `DELETE /api/admin/users/:id` — Удаление пользователя и его данных.
* `GET /api/admin/projects` — Получение списка всех проектов в системе.

## 5. Спецификация WebSocket сервера (Sync Server)

Использует `@hocuspocus/server`. Точка подключения: `wss://api.pix3.dev/collaboration`

### Структура Yjs документа (на проект)

* `yDoc.getMap('scene')` — Иерархия узлов и свойств (YAML-эквивалент).
* `yDoc.getMap('scripts')` — Тексты TypeScript-файлов. Ключ — путь, значение — `Y.Text`. Обеспечивает совместное редактирование кода.

### Жизненный цикл (Hooks)

* **`onAuthenticate`**: Проверка JWT или Share Token. Для гостей устанавливается `connection.readOnly = true`.
* **`onLoadDocument`**: Если CRDT пуст, читает `scene.pix3scene` и скрипты из облачного хранилища (`data/projects/:id`) и загружает их в память.
* **`onStoreDocument`**: Периодический снапшот в CRDT SQLite.

## 6. Алгоритм клиентской синхронизации (PWA FileSystem Sync)

PWA клиент берет на себя роль моста между облачным сервером и локальным диском пользователя (если включено).

### Рабочий процесс (Workflows)

1. **Cloud-First (По умолчанию)**:
   * Пользователь логинится в PWA и открывает проект. PWA скачивает метаданные по HTTP, подключается к Hocuspocus.
   * Все изменения сцены и кода живут в CRDT (Yjs).
   * Новые ассеты (картинки, модели) грузятся напрямую в облако через `POST /api/projects/:id/files`.
   * Никакая локальная папка не требуется.

2. **Маппинг локальной папки (Opt-in)**:
   * В UI редактора нажимается кнопка **"Sync with Local Folder"**.
   * Браузер запрашивает доступ: `window.showDirectoryPicker()`.
   * **Первичная синхронизация**: PWA скачивает все ассеты, скрипты и `scene.pix3scene` из облака и записывает в выбранную локальную папку.

3. **Двусторонняя синхронизация (Live Sync Engine в PWA)**:
   * **Local -> Cloud**: PWA использует `FileWatchService` (опрос директории или File System Observer API) для отслеживания изменений локальных файлов. При изменении на диске PWA вычисляет дельту и пушит в Hocuspocus. Изменения бинарников пушатся через Storage API.
   * **Cloud -> Local**: Когда PWA получает обновления из CRDT (например, художник подвинул объект), он использует FileSystem API для перезаписи локального `scene.pix3scene` или `.ts` файла, чтобы локальная папка всегда была консистентна с облаком.

### Режимы применения (Sync Modes)

* **Auto-Sync (По умолчанию)**: Каждое сохранение файла в IDE мгновенно отправляется в облако и применяется в сессии.
* **Manual (Кнопка Apply)**: PWA аккумулирует изменения из локальной файловой системы, но отправляет их в Hocuspocus только после явного подтверждения в интерфейсе.

## 7. Переменные окружения (`.env`)

```env
PORT_HTTP=4001
PORT_WS=4000

# Базы данных и хранилище
DB_PATH=./data/core.sqlite
HOCUSPOCUS_DB_PATH=./data/crdt.sqlite
PROJECTS_STORAGE_DIR=./data/projects

# Безопасность
JWT_SECRET=super_secret_string_here
PASSWORD_SALT_ROUNDS=10
```