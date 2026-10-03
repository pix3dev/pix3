/** Pure wire constants: importing these must not load the CRDT stack in solo sessions. */
export const SCENE_FORMAT_VERSION = 2;
export const SCENE_FORMAT_PARAMETER = 'scene-format';
export const COLLABORATION_METADATA_MAP = 'collaboration-metadata';
export const SERVER_SCENE_FORMAT_KEY = 'server-scene-format';
export const CLIENT_SCENE_FORMAT_ERROR =
  'This editor uses an unsupported collaboration scene format. Refresh or update Pix3 before reconnecting.';
export const SERVER_SCENE_FORMAT_ERROR =
  'The collaboration server does not support this editor’s scene format. Update the server before reconnecting.';
