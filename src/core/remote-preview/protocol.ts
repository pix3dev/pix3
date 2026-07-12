/**
 * Remote preview protocol shared by the editor host and the standalone player.
 *
 * Transport: one WebSocket per peer to the collab server's `/preview` relay.
 * - Text frames are JSON messages `{ type, ... }`.
 * - Binary frames are `[4-byte BE header length][UTF-8 JSON header][payload]`,
 *   where the header carries the same `{ type, ... }` shape.
 *
 * The relay is a dumb router (see `packages/pix3-collab-server/src/sync/preview-relay.ts`
 * for the routing table); everything meaningful is peer-to-peer between the
 * editor host and the players.
 */

export interface PreviewQualityConfig {
  readonly antialias: boolean;
  readonly shadows: boolean;
  readonly maxPixelRatio: number;
}

export interface PreviewSessionConfig {
  readonly projectName: string;
  /** Entry scene path without the res:// prefix. */
  readonly entryScenePath: string;
  readonly viewportBaseSize: { readonly width: number; readonly height: number };
  readonly quality: PreviewQualityConfig;
  /** sha-256 hex of the compiled user-script bundle, or null when the project has no scripts. */
  readonly scriptBundleHash: string | null;
}

export interface PreviewLogEntryPayload {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly timestamp: number;
}

export interface PreviewMetricsSample {
  readonly fps: number;
  readonly frameMs: number;
  readonly logicMs: number;
  readonly renderMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly elapsedTime: number;
  readonly frameNumber: number;
  /** Worst frame inside the aggregation window — 1s averages hide hitches. */
  readonly maxFrameMs?: number;
  /** Frames above ~33ms (missed-2-vsync) inside the window. */
  readonly longFrameCount?: number;
  /** Chrome-only (performance.memory); null on other engines. */
  readonly jsHeapUsedMb?: number | null;
}

/** Static facts about the player device, reported once per connection. */
export interface PreviewDeviceInfo {
  readonly userAgent: string;
  readonly devicePixelRatio: number;
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** UNMASKED_RENDERER_WEBGL when available — the real GPU/driver string. */
  readonly gpu: string | null;
  /** navigator.deviceMemory (GiB, Chrome-only). */
  readonly deviceMemoryGb: number | null;
  readonly hardwareConcurrency: number | null;
  readonly language: string | null;
}

export type PreviewPlayModeStatus = 'idle' | 'loading' | 'running' | 'error';

/** Text messages that can arrive on a preview socket. */
export interface PreviewJsonMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface HelloMessage extends PreviewJsonMessage {
  readonly type: 'hello';
  readonly role: 'host' | 'player';
  readonly clientId: string;
  readonly sessionId: string;
  readonly expiresAt: number;
  readonly hostOnline: boolean;
  readonly playerCount: number;
}

export interface PeerStatusMessage extends PreviewJsonMessage {
  readonly type: 'peer-status';
  readonly hostOnline: boolean;
  readonly playerCount: number;
}

export interface SessionConfigMessage extends PreviewJsonMessage {
  readonly type: 'session-config';
  readonly config: PreviewSessionConfig;
}

export interface SceneUpdatedMessage extends PreviewJsonMessage {
  readonly type: 'scene-updated';
  /** Changed res-relative paths; omitted means "assume everything changed". */
  readonly changedPaths?: readonly string[];
}

export interface FileRequestMessage extends PreviewJsonMessage {
  readonly type: 'file-request';
  readonly requestId: string;
  /** res-relative path (no res:// prefix). */
  readonly path: string;
  /** sha-256 hex the requester already has cached; host answers not-modified on match. */
  readonly knownHash?: string;
  /** Injected by the relay when forwarding to the host. */
  readonly from?: string;
}

export interface LogMessage extends PreviewJsonMessage {
  readonly type: 'log';
  readonly entries: readonly PreviewLogEntryPayload[];
}

export interface MetricsMessage extends PreviewJsonMessage {
  readonly type: 'metrics';
  readonly sample: PreviewMetricsSample;
}

export interface StatusMessage extends PreviewJsonMessage {
  readonly type: 'status';
  readonly playModeStatus: PreviewPlayModeStatus;
  readonly detail?: string;
}

export interface DeviceInfoMessage extends PreviewJsonMessage {
  readonly type: 'device-info';
  readonly info: PreviewDeviceInfo;
}

/** Binary frame headers. */
export interface FileResponseHeader extends PreviewJsonMessage {
  readonly type: 'file-response';
  readonly requestId: string;
  /** Target player clientId; consumed by the relay for routing. */
  readonly to: string;
  readonly path: string;
  readonly ok: boolean;
  readonly hash?: string;
  readonly mimeType?: string;
  readonly notModified?: boolean;
  readonly error?: string;
}

export interface ScriptBundleHeader extends PreviewJsonMessage {
  readonly type: 'script-bundle';
  readonly hash: string;
}

export interface ScreenshotHeader extends PreviewJsonMessage {
  readonly type: 'screenshot';
  readonly requestId?: string;
  readonly mimeType: string;
}

export interface BinaryFrame {
  readonly header: PreviewJsonMessage;
  readonly payload: Uint8Array;
}

const MAX_HEADER_BYTES = 64 * 1024;

export function encodeBinaryFrame(header: PreviewJsonMessage, payload: Uint8Array): ArrayBuffer {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const frame = new ArrayBuffer(4 + headerBytes.byteLength + payload.byteLength);
  const view = new DataView(frame);
  view.setUint32(0, headerBytes.byteLength, false);
  const bytes = new Uint8Array(frame);
  bytes.set(headerBytes, 4);
  bytes.set(payload, 4 + headerBytes.byteLength);
  return frame;
}

export function decodeBinaryFrame(frame: ArrayBuffer): BinaryFrame | null {
  if (frame.byteLength < 4) {
    return null;
  }

  const view = new DataView(frame);
  const headerLength = view.getUint32(0, false);
  if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES || 4 + headerLength > frame.byteLength) {
    return null;
  }

  try {
    const headerText = new TextDecoder().decode(new Uint8Array(frame, 4, headerLength));
    const header = JSON.parse(headerText) as PreviewJsonMessage;
    if (typeof header?.type !== 'string') {
      return null;
    }

    return { header, payload: new Uint8Array(frame.slice(4 + headerLength)) };
  } catch {
    return null;
  }
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buffer = data instanceof Uint8Array ? toArrayBuffer(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }

  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function buildPreviewWsUrl(
  origin: string,
  sessionId: string,
  token: string,
  previewPath = '/preview'
): string {
  const wsOrigin = origin.replace(/^http/i, 'ws');
  return `${wsOrigin}${previewPath}?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
}

export function guessMimeType(path: string): string {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  switch (extension) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'mp3':
      return 'audio/mpeg';
    case 'ogg':
      return 'audio/ogg';
    case 'wav':
      return 'audio/wav';
    case 'glb':
      return 'model/gltf-binary';
    case 'gltf':
      return 'model/gltf+json';
    case 'json':
    case 'pix3anim':
      return 'application/json';
    case 'pix3scene':
    case 'yaml':
    case 'yml':
      return 'text/yaml';
    case 'ts':
    case 'js':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}
