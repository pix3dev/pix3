import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Group } from 'three';

import {
  Model3DExportService,
  deriveArtifactBasePath,
  ensureGlbExtension,
  normalizeModelPath,
} from '@/services/model-gen/Model3DExportService';
import type { SculptSpec } from '@/services/model-gen/SculptSpec';
import { appState } from '@/state';

/** Recording ProjectStorageService stand-in — captures what the export service writes. */
function makeStorage() {
  const textWrites: Record<string, string> = {};
  const binaryWrites: Record<string, number> = {};
  return {
    textWrites,
    binaryWrites,
    createDirectory: vi.fn(async () => {}),
    writeTextFile: vi.fn(async (path: string, content: string) => {
      textWrites[path] = content;
    }),
    writeBinaryFile: vi.fn(async (path: string, buffer: ArrayBuffer) => {
      binaryWrites[path] = buffer.byteLength;
    }),
  };
}

const SPEC: SculptSpec = {
  objectClass: 'office chair',
  category: 'object',
  complexity: 'moderate',
  summary: 'A rolling office chair.',
  components: [{ id: 'seat', name: 'Seat' }],
  materials: [{ id: 'm', name: 'Plastic', baseColorHex: '#222222', metalness: 0, roughness: 0.8 }],
  detailInventory: ['armrests'],
};

/** Build a service with stubbed storage + a stubbed GLB export (GLTFExporter is not testable here). */
function makeService(bytes = 8) {
  const service = new Model3DExportService();
  const storage = makeStorage();
  Object.defineProperty(service, 'storage', { value: storage });
  vi.spyOn(service, 'exportGlb').mockResolvedValue(new ArrayBuffer(bytes));
  return { service, storage };
}

describe('deriveArtifactBasePath', () => {
  it('strips a trailing .glb (case-insensitive)', () => {
    expect(deriveArtifactBasePath('models/foo.glb')).toBe('models/foo');
    expect(deriveArtifactBasePath('models/foo.GLB')).toBe('models/foo');
  });

  it('leaves a path without a .glb extension untouched', () => {
    expect(deriveArtifactBasePath('models/foo')).toBe('models/foo');
  });

  it('composes with normalize + ensureGlb to a stable base', () => {
    const glb = ensureGlbExtension(normalizeModelPath('res://models/foo'));
    expect(glb).toBe('models/foo.glb');
    expect(deriveArtifactBasePath(glb)).toBe('models/foo');
  });
});

describe('Model3DExportService.saveModel', () => {
  const previousStatus = appState.project.status;

  beforeEach(() => {
    appState.project.status = 'ready';
  });

  afterEach(() => {
    appState.project.status = previousStatus;
    vi.restoreAllMocks();
  });

  it('writes only the GLB when no artifacts are provided', async () => {
    const { service, storage } = makeService(16);
    const result = await service.saveModel(new Group(), 'models/foo');

    expect(result).toEqual({
      path: 'models/foo.glb',
      bytes: 16,
      sculptPath: null,
      factoryPath: null,
    });
    expect(storage.binaryWrites['models/foo.glb']).toBe(16);
    expect(Object.keys(storage.textWrites)).toHaveLength(0);
  });

  it('writes the spec and factory siblings next to the GLB', async () => {
    const { service, storage } = makeService();
    const result = await service.saveModel(new Group(), 'res://models/foo.glb', {
      spec: SPEC,
      factoryCode: 'export function createModel(){}',
    });

    expect(result.path).toBe('models/foo.glb');
    expect(result.sculptPath).toBe('models/foo.sculpt.json');
    expect(result.factoryPath).toBe('models/foo.factory.ts');
    expect(storage.textWrites['models/foo.sculpt.json']).toContain('"objectClass": "office chair"');
    expect(storage.textWrites['models/foo.factory.ts']).toBe('export function createModel(){}');
  });

  it('omits the sibling not provided', async () => {
    const { service, storage } = makeService();
    const result = await service.saveModel(new Group(), 'models/foo', { spec: SPEC });

    expect(result.sculptPath).toBe('models/foo.sculpt.json');
    expect(result.factoryPath).toBeNull();
    expect(storage.textWrites['models/foo.factory.ts']).toBeUndefined();
  });

  it('saveGlb still returns the widened result shape', async () => {
    const { service } = makeService(4);
    const result = await service.saveGlb(new Group(), 'models/foo');

    expect(result).toEqual({
      path: 'models/foo.glb',
      bytes: 4,
      sculptPath: null,
      factoryPath: null,
    });
  });
});
