/**
 * `Content-Type` for `GET /ws/file`, by extension. The editor mostly turns bytes into Blobs and
 * decides by path itself; the header matters for `<audio>`/`<video>` range playback and for
 * anyone reading the route with curl. Unknown → `application/octet-stream`.
 */
const TYPES: Readonly<Record<string, string>> = {
  pix3scene: 'text/yaml; charset=utf-8',
  prefab: 'text/yaml; charset=utf-8',
  pix3anim: 'text/yaml; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  json: 'application/json; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  atlas: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ktx2: 'image/ktx2',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
};

export const contentTypeFor = (wirePath: string): string => {
  const name = wirePath.slice(wirePath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  return TYPES[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
};
