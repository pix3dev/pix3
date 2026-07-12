# Pix3 Collaboration Server

Сервер совместной работы для Pix3 Editor, обеспечивающий синхронизацию состояния сцены в реальном времени и управление ассетами.

Для локальной разработки используйте Node.js 24.15.0+.

## Основные возможности

- **Синхронизация через Yjs**: Использование CRDT для бесконфликтного редактирования.
- **WebSocket (Hocuspocus)**: Высокопроизводительный сервер для передачи обновлений.
- **Персистентность**: Сохранение состояния сцен в SQLite.
- **Управление ассетами**: HTTP API для загрузки и раздачи файлов (модели, текстуры, звуки).
- **Многопользовательские комнаты**: Изолированные сессии редактирования на основе ID проекта.
- **Единый порт**: HTTP API и WebSocket collaboration endpoint работают через один `http.Server`.

## Структура проекта

```text
packages/pix3-collab-server/
├── data/               # База данных SQLite (состояние сцен, пользователи, проекты)
└── src/
    ├── index.ts        # Точка входа, загрузка окружения
    ├── server.ts       # Инициализация единого HTTP + WebSocket сервера
    ├── config.ts       # Конфигурация через переменные окружения
    ├── core/           # Модули бизнес-логики (auth, projects, storage, admin)
    └── sync/           # Интеграция Hocuspocus для синхронизации Yjs
```

## Принцип работы

### 1. Синхронизация состояния (WebSocket)

Сервер использует **Hocuspocus** (обертка над Yjs) для управления WebSocket-соединениями на пути `/collaboration`.
Каждый проект открывается в отдельной "комнате" (`documentName`). Изменения, вносимые клиентами, объединяются сервером и рассылаются остальным участникам. Состояние комнаты сохраняется в SQLite.

### 2. HTTP API (Express)

Тот же HTTP-сервер предоставляет REST API:

- `/api/auth` — Аутентификация, токены.
- `/api/projects` — Управление проектами и списками файлов.
- `/api/projects` (storageRouter) — Загрузка и скачивание ассетов.
- `/api/admin` — Административные маршруты.

### 3. Reverse proxy

В production `nginx` проксирует и обычные HTTP-запросы, и WebSocket upgrade-запросы на `127.0.0.1:4001`.

## Локальная настройка

Настройки задаются через `.env` файл или переменные окружения:

- `PORT`: Единый порт для HTTP API и WebSocket (по умолчанию `4001`)
- `COLLABORATION_PATH`: WebSocket endpoint для Hocuspocus (по умолчанию `/collaboration`)
- `PREVIEW_PATH`: WebSocket endpoint для remote-preview relay (по умолчанию `/preview`)
- `PREVIEW_PUBLIC_URL`: публичный origin этого сервера (например `https://cloud.pix3.dev`). Возвращается редактору при создании preview-сессии: join-ссылка получает `&relay=<origin>`, плеер и агент подключаются к серверу напрямую, где бы ни была открыта страница плеера. Для локального запуска оставить пустым.
- `PREVIEW_SESSION_TTL_MS`: скользящий TTL preview-сессии (по умолчанию 6 часов)
- `DB_PATH`: Путь к основной SQLite БД (по умолчанию `./data/core.sqlite`)
- `HOCUSPOCUS_DB_PATH`: Путь к SQLite БД для CRDT-состояния (по умолчанию `./data/crdt.sqlite`)
- `PROJECTS_STORAGE_DIR`: Путь к директории с проектами и ассетами (по умолчанию `./data/projects`)
- `JWT_SECRET`: Секретный ключ для JWT-токенов
- `PASSWORD_SALT_ROUNDS`: Число раундов bcrypt (по умолчанию `10`)
- И другие параметры (см. `src/config.ts`)

Пример `.env`:

```bash
PORT=4001
COLLABORATION_PATH=/collaboration
DB_PATH=./data/core.sqlite
HOCUSPOCUS_DB_PATH=./data/crdt.sqlite
PROJECTS_STORAGE_DIR=./data/projects
JWT_SECRET=replace-me
PASSWORD_SALT_ROUNDS=10
```

## Запуск

```bash
# Установка зависимостей (из корня репозитория)
npm install

# Запуск в режиме разработки
npm run dev --workspace=@pix3/collab-server

# Сборка
npm run build --workspace=@pix3/collab-server

# Продакшн запуск
npm start --workspace=@pix3/collab-server
```

## Deploy на `cloud.pix3.dev`

### Что делает GitHub Action

Workflow `.github/workflows/deploy-collab-server.yml`:

- запускается при `push` в `main` для изменений backend-сервера и вручную через `workflow_dispatch`;
- собирает `@pix3/collab-server`;
- упаковывает корневой `package.json` без editor `postinstall`, корневой `package-lock.json`, а также workspace `packages/pix3-collab-server` с `dist/`, `package.json` и `src/admin/index.html`;
- загружает релиз на `cloud.pix3.dev` по SSH;
- раскладывает релиз в `${DEPLOY_PATH}/releases/<sha>`;
- привязывает `shared/.env` и `shared/data` внутрь `packages/pix3-collab-server`;
- выполняет `npm ci --omit=dev --workspace packages/pix3-collab-server`;
- переключает `${DEPLOY_PATH}/current` на `packages/pix3-collab-server` внутри нового релиза;
- перезапускает `systemd`-сервис `pix3-collab-server`.

### GitHub Secrets

Для workflow нужно завести secrets:

- `COLLAB_DEPLOY_USER`: SSH-пользователь на `cloud.pix3.dev`
- `COLLAB_DEPLOY_SSH_KEY`: приватный SSH-ключ для этого пользователя
- `COLLAB_DEPLOY_PATH`: корневая директория деплоя, например `/opt/pix3-collab-server`
- `COLLAB_DEPLOY_PORT`: SSH-порт, обычно `22`

### Подготовка сервера

На `cloud.pix3.dev` нужно один раз подготовить runtime-окружение.

1. Установить Node.js `24.15.0` или новее в рамках диапазона `>=24.15.0 <25` и проверить путь к бинарнику:

```bash
node -v
which node
```

2. Создать директории для релизов и shared-данных:

```bash
sudo mkdir -p /opt/pix3-collab-server/releases
sudo mkdir -p /opt/pix3-collab-server/shared/data
sudo chown -R deploy:deploy /opt/pix3-collab-server
```

3. Создать production `.env`:

```bash
cat >/opt/pix3-collab-server/shared/.env <<'EOF'
PORT=4001
COLLABORATION_PATH=/collaboration
DB_PATH=./data/core.sqlite
HOCUSPOCUS_DB_PATH=./data/crdt.sqlite
PROJECTS_STORAGE_DIR=./data/projects
JWT_SECRET=replace-with-strong-secret
PASSWORD_SALT_ROUNDS=10
PREVIEW_PUBLIC_URL=https://cloud.pix3.dev
EOF
```

4. Создать user-level `systemd` unit `~/.config/systemd/user/pix3-collab-server.service`:

```ini
[Unit]
Description=Pix3 Collaboration Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/pix3-collab-server/current
Environment=NODE_ENV=production
EnvironmentFile=/opt/pix3-collab-server/shared/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Если `node` находится не в `/usr/bin/node`, подставьте путь из `which node`.

5. Включить lingering для deploy-пользователя, чтобы `systemctl --user` работал без активной интерактивной сессии:

```bash
sudo loginctl enable-linger deploy
```

6. Активировать сервис:

```bash
mkdir -p ~/.config/systemd/user
systemctl --user daemon-reload
systemctl --user enable pix3-collab-server
systemctl --user start pix3-collab-server
systemctl --user status pix3-collab-server
```

### Проверка nginx

Так как `nginx` уже настроен как reverse proxy на `127.0.0.1:4001`, нужно только убедиться, что он пропускает WebSocket upgrade для `/collaboration`.

Минимально должно быть эквивалентно такой конфигурации:

```nginx
location / {
    client_max_body_size 100m;
    proxy_pass http://127.0.0.1:4001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /collaboration {
    client_max_body_size 100m;
    proxy_pass http://127.0.0.1:4001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# Remote-preview relay: тот же upgrade-passthrough, что и для /collaboration.
location /preview {
    client_max_body_size 100m;
    proxy_pass http://127.0.0.1:4001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Relay гоняет крупные бинарные фреймы (ассеты, скриншоты) — не буферизуем
    # и держим соединение дольше дефолтных 60s.
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}
```

Если upload-файлы начинают отваливаться на размерах около `1 MB`, почти всегда это значит,
что `nginx` использует дефолтный `client_max_body_size 1m` и режет запрос до того,
как он попадёт в Express + `multer`.

### Smoke checks после деплоя

После первого запуска проверьте:

```bash
curl http://127.0.0.1:4001/health
systemctl --user status pix3-collab-server
journalctl --user -u pix3-collab-server -n 100 --no-pager
```

Ожидаемый health-check:

```json
{ "status": "ok", "port": 4001 }
```
