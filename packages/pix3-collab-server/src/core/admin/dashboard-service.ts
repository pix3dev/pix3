import { config } from '../../config.js';
import {
  FabricError,
  fetchFabricStats,
  isRoomsConfigured,
  resolveRoomsWsUrl,
} from '../rooms/rooms-service.js';
import {
  snapshotConnectionStats,
  type ConnectionStats,
} from '../observability/connection-stats.js';
import { resolveReleaseInfo } from '../observability/release-info.js';
import { getRepoVersions, sameCommit, type RepoVersions } from '../observability/repo-versions.js';
import {
  sampleResources,
  type HostResources,
  type ProcessResources,
} from '../observability/resource-metrics.js';

/**
 * Assembles `GET /api/admin/dashboard`: one body describing every moving part of the platform.
 *
 * This server is the aggregator because it is the only party that holds the fabric's service token —
 * the browser must never see it, so "the dashboard fetches rooms directly" is not an option. The same
 * applies to `editor.pix3.dev/version.json`: GitHub Pages sends no CORS headers, so the client version
 * is only readable server-side.
 *
 * Nothing here is allowed to fail the request. A fabric that is down, a Pages deploy in progress or a
 * GitHub outage each degrade to a status on their own card; an operator opening the dashboard during
 * an incident needs the parts that *do* answer.
 */

/** Health of one component, as its card reports it. */
export type ServiceStatus = 'ok' | 'degraded' | 'unreachable' | 'not_configured';

/** Uniform card data, so every service renders the same way regardless of runtime. */
export interface ServiceCard {
  readonly id: 'cloud' | 'collab' | 'preview' | 'rooms' | 'client';
  readonly name: string;
  readonly status: ServiceStatus;
  /** Short reason when the status is not `ok`. */
  readonly message: string | null;
  readonly url: string | null;
  readonly version: string | null;
  readonly commit: string | null;
  readonly uptimeSeconds: number | null;
  readonly cpuPercent: number | null;
  readonly memoryBytes: number | null;
  /** Ceiling the memory figure should be read against (cgroup limit), when there is one. */
  readonly memoryLimitBytes: number | null;
  /** Two or three headline numbers, pre-labelled for the card footer. */
  readonly figures: readonly { readonly label: string; readonly value: string }[];
}

/** The client bundle GitHub Pages currently serves. */
export interface ClientInfo {
  readonly url: string;
  readonly status: ServiceStatus;
  readonly version: string | null;
  readonly build: number | null;
  readonly displayVersion: string | null;
  readonly publishedAt: string | null;
  readonly error: string | null;
}

/** One row of the version-comparison table. */
export interface VersionRow {
  readonly component: string;
  readonly deployedVersion: string | null;
  readonly deployedCommit: string | null;
  readonly repoVersion: string | null;
  readonly repoCommit: string | null;
  readonly behindBy: number | null;
  /** `current` / `stale` / `unknown` — the verdict the badge renders. */
  readonly state: 'current' | 'stale' | 'unknown';
  readonly note: string | null;
  /**
   * Whether the note is context or a problem. A row can be `current` — deployed from HEAD — and still
   * carry a warning: a platform version that disagrees with cloud is a forgotten bump, not staleness,
   * and gray small print would bury exactly the thing nobody would otherwise notice.
   */
  readonly noteSeverity: 'info' | 'warn';
}

/** Full dashboard payload. */
export interface DashboardPayload {
  readonly generatedAt: string;
  readonly services: readonly ServiceCard[];
  readonly hosts: readonly (HostResources & { readonly reportedBy: string })[];
  readonly cloud: {
    readonly version: string;
    readonly commit: string | null;
    readonly commitSource: string | null;
    readonly process: ProcessResources;
    readonly connections: ConnectionStats;
  };
  readonly rooms: {
    readonly configured: boolean;
    readonly status: ServiceStatus;
    readonly adminUrl: string | null;
    readonly wsUrl: string | null;
    readonly error: string | null;
    readonly stats: Record<string, unknown> | null;
  };
  readonly client: ClientInfo;
  readonly repo: RepoVersions;
  readonly versions: readonly VersionRow[];
}

const CLIENT_FETCH_TIMEOUT_MS = 6_000;

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
    return '—';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function readNumber(
  source: Record<string, unknown> | null | undefined,
  key: string
): number | null {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(
  source: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readObject(
  source: Record<string, unknown> | null | undefined,
  key: string
): Record<string, unknown> | null {
  const value = source?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reads the deployed client's own manifest. The only way to learn the CLIENT version server-side. */
async function fetchClientInfo(): Promise<ClientInfo> {
  const base = config.DASHBOARD_EDITOR_URL;
  const url = `${base}/version.json`;

  if (!base) {
    return {
      url: '',
      status: 'not_configured',
      version: null,
      build: null,
      displayVersion: null,
      publishedAt: null,
      error: 'DASHBOARD_EDITOR_URL is empty.',
    };
  }

  try {
    // Cache-busted: Pages serves version.json with a long-lived CDN cache, and a stale read here
    // would report the previous deploy as current.
    const response = await fetch(`${url}?ts=${Date.now()}`, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(CLIENT_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        url,
        status: 'unreachable',
        version: null,
        build: null,
        displayVersion: null,
        publishedAt: null,
        error: `HTTP ${response.status}`,
      };
    }

    const parsed = (await response.json()) as Record<string, unknown>;
    return {
      url,
      status: typeof parsed.version === 'string' ? 'ok' : 'degraded',
      version: readString(parsed, 'version'),
      build: readNumber(parsed, 'build'),
      displayVersion: readString(parsed, 'displayVersion'),
      publishedAt: readString(parsed, 'publishedAt'),
      error: typeof parsed.version === 'string' ? null : 'version.json has no version field',
    };
  } catch (error) {
    return {
      url,
      status: 'unreachable',
      version: null,
      build: null,
      displayVersion: null,
      publishedAt: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchRoomsStats(): Promise<{
  status: ServiceStatus;
  stats: Record<string, unknown> | null;
  error: string | null;
}> {
  if (!isRoomsConfigured()) {
    return {
      status: 'not_configured',
      stats: null,
      error: 'ROOMS_ADMIN_URL and ROOMS_SERVICE_TOKEN are not both set.',
    };
  }

  try {
    return { status: 'ok', stats: await fetchFabricStats(), error: null };
  } catch (error) {
    const message =
      error instanceof FabricError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);

    // A fabric that is reachable but refusing (bad service token) is a configuration fault, not a
    // dead service — the distinction is what tells an operator where to look.
    const status: ServiceStatus =
      error instanceof FabricError && error.code === 'fabric_unauthorized'
        ? 'degraded'
        : 'unreachable';

    return { status, stats: null, error: message };
  }
}

function buildVersionRows(
  cloudVersion: string,
  cloudCommit: string | null,
  client: ClientInfo,
  roomsStats: Record<string, unknown> | null,
  repo: RepoVersions
): VersionRow[] {
  const rows: VersionRow[] = [];

  // ── Client ──────────────────────────────────────────────────────────────────
  // version.json is committed, so repo and deployed are directly comparable including the build
  // number: a Pages deploy publishes that file verbatim.
  const clientRepo = repo.pix3.client;
  const clientMatches =
    client.version !== null &&
    clientRepo !== null &&
    client.version === clientRepo.version &&
    client.build === clientRepo.build;

  rows.push({
    component: 'Клиент (editor)',
    deployedVersion:
      client.version === null ? null : `${client.version} (build ${client.build ?? '?'})`,
    deployedCommit: null,
    repoVersion: clientRepo === null ? null : `${clientRepo.version} (build ${clientRepo.build})`,
    repoCommit: repo.pix3.headSha,
    behindBy: null,
    state:
      client.version === null || clientRepo === null
        ? 'unknown'
        : clientMatches
          ? 'current'
          : 'stale',
    note:
      clientRepo === null
        ? 'public/version.json недоступен в репозитории'
        : 'build-номер растёт при npm run build, поэтому сравнение точное',
    noteSeverity: clientRepo === null ? 'warn' : 'info',
  });

  // ── Cloud backend ───────────────────────────────────────────────────────────
  const cloudRepoVersion = repo.pix3.collabServerVersion ?? repo.pix3.rootVersion;
  const cloudCommitMatches = sameCommit(cloudCommit, repo.pix3.headSha);
  rows.push({
    component: 'Бекенд cloud',
    deployedVersion: cloudVersion,
    deployedCommit: cloudCommit,
    repoVersion: cloudRepoVersion,
    repoCommit: repo.pix3.headSha,
    // The distance is only meaningful against a known deployed commit; the repo cache may still be
    // carrying one from a previous, better-informed poll.
    behindBy: cloudCommit === null ? null : repo.pix3.behindBy,
    state:
      cloudCommit === null || repo.pix3.headSha === null
        ? cloudRepoVersion === null
          ? 'unknown'
          : cloudVersion === cloudRepoVersion
            ? 'current'
            : 'stale'
        : cloudCommitMatches
          ? 'current'
          : 'stale',
    note:
      cloudCommit === null
        ? 'коммит не определён — сравнение только по версии пакета'
        : 'версия lockstep с редактором, решает коммит',
    noteSeverity: 'info',
  });

  // ── Rooms backend ───────────────────────────────────────────────────────────
  // pix3-rooms carries the same platform version (its Directory.Build.props declares it), so the
  // deployed number is comparable both ways: against its own repository, and against cloud's — the
  // second is the one that catches a cross-repo bump nobody remembered to make.
  const roomsCommit = readString(roomsStats, 'commit');
  const roomsVersion = readString(roomsStats, 'version');
  const roomsRepoVersion = repo.rooms.declaredVersion;
  rows.push({
    component: 'Бекенд rooms',
    deployedVersion: roomsVersion,
    deployedCommit: roomsCommit,
    repoVersion: roomsRepoVersion,
    repoCommit: repo.rooms.headSha,
    behindBy: roomsCommit === null ? null : repo.rooms.behindBy,
    state:
      roomsCommit === null || repo.rooms.headSha === null
        ? // No commit to judge by: the declared version is the next best evidence.
          roomsVersion === null || roomsRepoVersion === null
          ? 'unknown'
          : roomsVersion === roomsRepoVersion
            ? 'current'
            : 'stale'
        : sameCommit(roomsCommit, repo.rooms.headSha)
          ? 'current'
          : 'stale',
    ...roomsVersionNote(roomsStats, roomsCommit, roomsVersion, cloudVersion),
  });

  return rows;
}

/**
 * The one line under the rooms row. Ordered by what an operator needs to know first: a fabric that
 * did not answer, then a build with no provenance, then a platform-version disagreement with cloud —
 * which is not staleness against its own repository and would otherwise pass unnoticed.
 */
export function roomsVersionNote(
  roomsStats: Record<string, unknown> | null,
  roomsCommit: string | null,
  roomsVersion: string | null,
  cloudVersion: string
): { note: string; noteSeverity: 'info' | 'warn' } {
  if (roomsStats === null) {
    return { note: 'фабрика не ответила — версия и коммит неизвестны', noteSeverity: 'warn' };
  }

  if (roomsCommit === null) {
    return {
      note: 'сборка без -p:SourceRevisionId и не из releases/<sha> — коммит неизвестен',
      noteSeverity: 'warn',
    };
  }

  if (roomsVersion !== null && roomsVersion !== cloudVersion) {
    return {
      note: `версия платформы расходится с cloud (${cloudVersion}) — либо не задеплоено, либо забыт бамп Directory.Build.props`,
      noteSeverity: 'warn',
    };
  }

  return {
    note: 'общая версия платформы, как у cloud и клиента; решает коммит',
    noteSeverity: 'info',
  };
}

function buildServiceCards(input: {
  cloudVersion: string;
  cloudCommit: string | null;
  cloudProcess: ProcessResources;
  cloudHost: HostResources;
  connections: ConnectionStats;
  rooms: { status: ServiceStatus; stats: Record<string, unknown> | null; error: string | null };
  client: ClientInfo;
}): ServiceCard[] {
  const roomsProcess = readObject(input.rooms.stats, 'process');
  const roomsConnections = readObject(input.rooms.stats, 'connections');
  const roomsRooms = readObject(input.rooms.stats, 'rooms');

  const cards: ServiceCard[] = [
    {
      id: 'cloud',
      name: 'Cloud API',
      status: 'ok',
      message: null,
      // PREVIEW_PUBLIC_URL is configured as "the public origin of THIS server", which is exactly the
      // address an operator wants on this card. Empty on a same-origin local setup.
      url: config.PREVIEW_PUBLIC_URL || null,
      version: input.cloudVersion,
      commit: input.cloudCommit,
      uptimeSeconds: input.cloudProcess.uptimeSeconds,
      cpuPercent: input.cloudProcess.cpuPercent,
      memoryBytes: input.cloudProcess.rssBytes,
      memoryLimitBytes: null,
      figures: [
        { label: 'Node', value: input.cloudProcess.node },
        { label: 'PID', value: String(input.cloudProcess.pid) },
        { label: 'Heap', value: formatBytes(input.cloudProcess.heapUsedBytes) },
      ],
    },
    {
      id: 'collab',
      name: 'Collab sync (Yjs)',
      status: input.connections.collaboration.attached ? 'ok' : 'degraded',
      message: input.connections.collaboration.attached ? null : 'Hocuspocus не зарегистрирован',
      url: null,
      version: null,
      commit: null,
      uptimeSeconds: null,
      cpuPercent: null,
      memoryBytes: null,
      memoryLimitBytes: null,
      figures: [
        { label: 'Подключения', value: String(input.connections.collaboration.connections) },
        { label: 'Документы', value: String(input.connections.collaboration.documents) },
      ],
    },
    {
      id: 'preview',
      name: 'Preview relay',
      status: 'ok',
      message: null,
      url: null,
      version: null,
      commit: null,
      uptimeSeconds: null,
      cpuPercent: null,
      memoryBytes: null,
      memoryLimitBytes: null,
      figures: [
        { label: 'Сессии', value: String(input.connections.preview.sessions) },
        { label: 'Хосты', value: String(input.connections.preview.hosts) },
        { label: 'Игроки', value: String(input.connections.preview.players) },
      ],
    },
    {
      id: 'rooms',
      name: 'Room Fabric',
      status: input.rooms.status,
      message: input.rooms.error,
      url: config.ROOMS_ADMIN_URL || null,
      version: readString(input.rooms.stats, 'version'),
      commit: readString(input.rooms.stats, 'commit'),
      uptimeSeconds: readNumber(input.rooms.stats, 'uptimeSeconds'),
      cpuPercent: readNumber(roomsProcess, 'cpuPercent'),
      memoryBytes: readNumber(roomsProcess, 'workingSetBytes'),
      memoryLimitBytes: readNumber(roomsProcess, 'heapLimitBytes'),
      figures: [
        {
          label: 'Комнаты',
          value:
            roomsRooms === null
              ? '—'
              : `${readNumber(roomsRooms, 'count') ?? 0} / ${readNumber(roomsRooms, 'maxRooms') ?? '?'}`,
        },
        {
          label: 'Соединения',
          value:
            roomsConnections === null
              ? '—'
              : `${readNumber(roomsConnections, 'active') ?? 0} / ${readNumber(roomsConnections, 'maxTotal') ?? '?'}`,
        },
        {
          label: 'Игроки',
          value: roomsRooms === null ? '—' : String(readNumber(roomsRooms, 'players') ?? 0),
        },
      ],
    },
    {
      id: 'client',
      name: 'Клиент (GitHub Pages)',
      status: input.client.status,
      message: input.client.error,
      // The base origin, not the version.json the status was read from.
      url: config.DASHBOARD_EDITOR_URL || null,
      version:
        input.client.version === null
          ? null
          : `${input.client.version} (build ${input.client.build ?? '?'})`,
      commit: null,
      uptimeSeconds: null,
      cpuPercent: null,
      memoryBytes: null,
      memoryLimitBytes: null,
      figures: [
        {
          label: 'Опубликован',
          value: input.client.publishedAt
            ? new Date(input.client.publishedAt).toLocaleString('ru-RU')
            : '—',
        },
      ],
    },
  ];

  return cards;
}

/** Builds the whole payload. `force` bypasses the ten-minute repository cache. */
export async function buildDashboard(options: { force?: boolean } = {}): Promise<DashboardPayload> {
  const release = await resolveReleaseInfo();

  // The three slow parts are independent, so they overlap: a fabric on a cold TCP connection must not
  // serialise behind a Pages fetch.
  const [resources, rooms, client] = await Promise.all([
    sampleResources(),
    fetchRoomsStats(),
    fetchClientInfo(),
  ]);

  const connections = snapshotConnectionStats();
  const roomsCommit = readString(rooms.stats, 'commit');
  const repo = await getRepoVersions(
    { pix3: release.commit, rooms: roomsCommit },
    { force: options.force }
  );

  const roomsHost = readObject(rooms.stats, 'host');
  const hosts: (HostResources & { reportedBy: string })[] = [
    { ...resources.host, reportedBy: 'cloud' },
  ];

  // cloud and rooms live on one box today, so the fabric's host block is normally a duplicate. It is
  // only added when the hostname actually differs — the day they are split, the dashboard follows
  // without a change here. Compared case-insensitively: Node reports `os.hostname()` as the system
  // records it and .NET reports `MachineName` upper-cased on Windows, so the same box can disagree.
  const roomsHostname = readString(roomsHost, 'hostname');
  const sameHost =
    roomsHostname !== null && roomsHostname.toLowerCase() === resources.host.hostname.toLowerCase();
  if (roomsHost && roomsHostname && !sameHost) {
    hosts.push({
      hostname: roomsHostname,
      os: readString(roomsHost, 'os') ?? 'unknown',
      cpuCount: readNumber(roomsHost, 'cpuCount') ?? 0,
      cpuPercent: readNumber(roomsHost, 'cpuPercent'),
      load1: readNumber(roomsHost, 'load1'),
      load5: readNumber(roomsHost, 'load5'),
      load15: readNumber(roomsHost, 'load15'),
      memoryTotalBytes: readNumber(roomsHost, 'memoryTotalBytes'),
      memoryAvailableBytes: readNumber(roomsHost, 'memoryAvailableBytes'),
      diskTotalBytes: readNumber(roomsHost, 'diskTotalBytes'),
      diskFreeBytes: readNumber(roomsHost, 'diskFreeBytes'),
      uptimeSeconds: readNumber(roomsHost, 'uptimeSeconds'),
      reportedBy: 'rooms',
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    services: buildServiceCards({
      cloudVersion: release.version,
      cloudCommit: release.commit,
      cloudProcess: resources.process,
      cloudHost: resources.host,
      connections,
      rooms,
      client,
    }),
    hosts,
    cloud: {
      version: release.version,
      commit: release.commit,
      commitSource: release.commitSource,
      process: resources.process,
      connections,
    },
    rooms: {
      configured: isRoomsConfigured(),
      status: rooms.status,
      adminUrl: config.ROOMS_ADMIN_URL || null,
      wsUrl: resolveRoomsWsUrl() || null,
      error: rooms.error,
      stats: rooms.stats,
    },
    client,
    repo,
    versions: buildVersionRows(release.version, release.commit, client, rooms.stats, repo),
  };
}
