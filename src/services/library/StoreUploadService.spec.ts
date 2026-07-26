import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

import {
  STORE_MAX_FILES_PER_BUNDLE,
  StoreUploadService,
  type IngestEntry,
  type StagedBundle,
} from '@/services/library/StoreUploadService';

/**
 * happy-dom has no `webkitGetAsEntry`/`FileSystemDirectoryEntry`, so the traversal is exercised
 * through the {@link IngestEntry} contract with plain object trees — which is exactly why the
 * service takes that interface instead of the DOM types.
 */
function fileEntry(name: string, content = 'x', size?: number): IngestEntry {
  const file = new File([content], name);
  if (size !== undefined) {
    // Avoid allocating hundreds of megabytes just to trip the per-file limit.
    Object.defineProperty(file, 'size', { value: size });
  }
  return { kind: 'file', name, file: async () => file };
}

function dirEntry(name: string, children: IngestEntry[]): IngestEntry {
  return { kind: 'directory', name, children: async () => children };
}

/** A `File` carrying a `webkitRelativePath`, as the directory picker produces. */
function pickedFile(relativePath: string, content = 'x'): File {
  const file = new File([content], relativePath.split('/').pop() ?? relativePath);
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

function makeService(): { service: StoreUploadService; refreshStore: ReturnType<typeof vi.fn> } {
  const service = new StoreUploadService();
  const refreshStore = vi.fn(async () => {});
  Object.defineProperty(service, 'library', { value: { refreshStore } });
  return { service, refreshStore };
}

// -- XMLHttpRequest double -----------------------------------------------------

type Listener = (event: unknown) => void;

function emitter() {
  const map = new Map<string, Listener[]>();
  return {
    addEventListener(type: string, listener: Listener) {
      map.set(type, [...(map.get(type) ?? []), listener]);
    },
    removeEventListener(type: string, listener: Listener) {
      map.set(
        type,
        (map.get(type) ?? []).filter(entry => entry !== listener)
      );
    },
    emit(type: string, event: unknown = {}) {
      for (const listener of [...(map.get(type) ?? [])]) {
        listener(event);
      }
    },
  };
}

class FakeXhr {
  static instances: FakeXhr[] = [];
  /** What `send()` does. Default: a 201, like the real store router. */
  static respond: (xhr: FakeXhr) => void = xhr => xhr.finish(201, JSON.stringify({ id: 'ok' }));

  private readonly events = emitter();
  readonly upload = emitter();

  status = 0;
  statusText = '';
  responseText = '';
  withCredentials = false;
  method = '';
  url = '';
  body: FormData | null = null;
  aborted = false;

  readonly addEventListener = this.events.addEventListener;
  readonly removeEventListener = this.events.removeEventListener;

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  send(body: FormData): void {
    this.body = body;
    FakeXhr.respond(this);
  }

  abort(): void {
    this.aborted = true;
    this.events.emit('abort');
  }

  progress(loaded: number, total: number): void {
    this.upload.emit('progress', { loaded, total, lengthComputable: true });
  }

  finish(status: number, responseText: string, statusText = ''): void {
    this.status = status;
    this.statusText = statusText;
    this.responseText = responseText;
    this.events.emit('load');
  }
}

function stagedFrom(bundles: StagedBundle[], name: string): StagedBundle {
  const bundle = bundles.find(entry => entry.manifest.name === name);
  if (!bundle) {
    throw new Error(`No staged bundle named "${name}" (got ${bundles.map(b => b.manifest.name)})`);
  }
  return bundle;
}

beforeEach(() => {
  FakeXhr.instances = [];
  FakeXhr.respond = xhr => xhr.finish(201, JSON.stringify({ id: 'ok' }));
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

describe('StoreUploadService.buildPlan — grouping', () => {
  it('makes one bundle per top-level folder and one per lone file', async () => {
    const { service } = makeService();
    const plan = await service.buildPlan([
      dirEntry('ui-kit', [fileEntry('button.png'), dirEntry('nested', [fileEntry('panel.png')])]),
      fileEntry('logo.png'),
    ]);

    expect(plan.issues).toEqual([]);
    expect(plan.bundles).toHaveLength(2);

    const kit = stagedFrom(plan.bundles, 'ui-kit');
    // The top folder itself is not part of the bundle paths — its children sit at the root.
    expect([...kit.files.keys()].sort()).toEqual(['button.png', 'nested/panel.png']);
    expect(kit.manifest.files.sort()).toEqual(['button.png', 'nested/panel.png']);

    const logo = stagedFrom(plan.bundles, 'logo');
    expect([...logo.files.keys()]).toEqual(['logo.png']);
    expect(logo.manifest.type).toBe('image');
  });

  it('reports an entry that holds nothing usable instead of staging an empty bundle', async () => {
    const { service } = makeService();
    const plan = await service.buildPlan([dirEntry('empty', [])]);
    expect(plan.bundles).toEqual([]);
    expect(plan.issues[0]).toContain('"empty"');
  });
});

describe('StoreUploadService.buildPlan — manifests', () => {
  it('honours an in-bundle item.json, id included, so a re-upload updates the same item', async () => {
    const { service } = makeService();
    const declared = {
      id: 'fixed-store-id',
      slug: 'space-ui',
      name: 'Space UI',
      type: 'prefab',
      tags: ['ui', 'sci-fi'],
      license: 'CC0-1.0',
      categoryPath: 'ui/buttons',
      description: 'Panels and buttons',
      preview: 'preview.png',
      files: ['stale.png'],
      source: 'packed',
      createdAt: 111,
      updatedAt: 222,
    };
    const plan = await service.buildPlan([
      dirEntry('whatever', [
        fileEntry('item.json', JSON.stringify(declared)),
        fileEntry('preview.png'),
        fileEntry('panel.pix3scene'),
      ]),
    ]);

    const [bundle] = plan.bundles;
    expect(bundle!.id).toBe('fixed-store-id');
    expect(bundle!.manifest.id).toBe('fixed-store-id');
    expect(bundle!.manifest.name).toBe('Space UI');
    expect(bundle!.manifest.categoryPath).toBe('ui/buttons');
    expect(bundle!.manifest.license).toBe('CC0-1.0');
    expect(bundle!.manifest.createdAt).toBe(111);
    // `item.json` is the manifest, not bundle content, and the stale file list is recomputed.
    expect([...bundle!.files.keys()].sort()).toEqual(['panel.pix3scene', 'preview.png']);
    expect(bundle!.manifest.files.sort()).toEqual(['panel.pix3scene', 'preview.png']);
  });

  it('synthesizes a draft manifest with a fresh id when there is no item.json', async () => {
    const { service } = makeService();
    const plan = await service.buildPlan([
      dirEntry('Enemy Pack', [fileEntry('enemy.pix3scene'), fileEntry('sprite.png')]),
    ]);

    const [bundle] = plan.bundles;
    expect(bundle!.manifest.status).toBe('draft');
    expect(bundle!.manifest.name).toBe('Enemy Pack');
    expect(bundle!.manifest.slug).toBe('enemy-pack');
    expect(bundle!.manifest.id).toMatch(/[0-9a-f-]{8,}/i);
    // The entry decides the type: a scene file outranks the sprite beside it.
    expect(bundle!.manifest.entry).toBe('enemy.pix3scene');
    expect(bundle!.manifest.type).toBe('prefab');
    expect(bundle!.manifest.source).toBe('imported');
    expect(bundle!.manifest.tags).toEqual([]);
  });

  it('prefers a preview.* image, then falls back to the first image alphabetically', async () => {
    const { service } = makeService();
    const plan = await service.buildPlan([
      dirEntry('withPreview', [fileEntry('a.png'), fileEntry('preview.webp')]),
      dirEntry('withoutPreview', [fileEntry('zeta.png'), fileEntry('alpha.png')]),
      dirEntry('noImages', [fileEntry('theme.ts')]),
    ]);

    expect(stagedFrom(plan.bundles, 'withPreview').manifest.preview).toBe('preview.webp');
    expect(stagedFrom(plan.bundles, 'withoutPreview').manifest.preview).toBe('alpha.png');
    expect(stagedFrom(plan.bundles, 'noImages').manifest.preview).toBeUndefined();
  });
});

describe('StoreUploadService.buildPlan — paths and limits', () => {
  it('normalizes separators and discards unsafe paths instead of failing the bundle', async () => {
    const { service } = makeService();
    const plan = await service.buildPlan([
      dirEntry('pack', [fileEntry('sub\\deep.png'), fileEntry('..'), fileEntry('ok.png')]),
    ]);

    const [bundle] = plan.bundles;
    expect([...bundle!.files.keys()].sort()).toEqual(['ok.png', 'sub/deep.png']);
    expect(bundle!.oversize).toBe(false);
    expect(bundle!.issues.join(' ')).toContain('discarded');
  });

  it('blocks a bundle with more files than the server accepts', async () => {
    const { service } = makeService();
    const children = Array.from({ length: STORE_MAX_FILES_PER_BUNDLE + 1 }, (_, index) =>
      fileEntry(`file-${index}.png`)
    );
    const plan = await service.buildPlan([dirEntry('huge', children)]);

    const [bundle] = plan.bundles;
    expect(bundle!.oversize).toBe(true);
    expect(bundle!.issues.join(' ')).toContain(String(STORE_MAX_FILES_PER_BUNDLE));
  });

  it('blocks a bundle holding a file above the 100 MB per-file limit', async () => {
    const { service } = makeService();
    const plan = await service.buildPlan([
      dirEntry('heavy', [fileEntry('video.mp4', 'x', 150 * 1024 * 1024), fileEntry('ok.png')]),
      dirEntry('light', [fileEntry('ok.png')]),
    ]);

    expect(stagedFrom(plan.bundles, 'heavy').oversize).toBe(true);
    expect(stagedFrom(plan.bundles, 'heavy').issues.join(' ')).toContain('video.mp4');
    // A blocked bundle must not take the rest of the drop down with it.
    expect(stagedFrom(plan.bundles, 'light').oversize).toBe(false);
  });
});

describe('StoreUploadService.buildPlan — zip', () => {
  it('treats a .zip as a folder and strips a single wrapping root directory', async () => {
    const zip = new JSZip();
    zip.file('space-ui/preview.png', 'img');
    zip.file('space-ui/parts/panel.png', 'img');
    zip.file('space-ui/__MACOSX/junk', 'junk');
    const archive = await zip.generateAsync({ type: 'blob' });

    const { service } = makeService();
    const plan = await service.buildPlan([
      { kind: 'file', name: 'space-ui.zip', file: async () => new File([archive], 'space-ui.zip') },
    ]);

    const [bundle] = plan.bundles;
    expect(bundle!.manifest.name).toBe('space-ui');
    expect([...bundle!.files.keys()].sort()).toEqual(['parts/panel.png', 'preview.png']);
    expect(bundle!.manifest.preview).toBe('preview.png');
  });

  it('reads an item.json out of the archive too', async () => {
    const zip = new JSZip();
    zip.file('item.json', JSON.stringify({ id: 'zipped-id', name: 'Zipped', tags: ['a'] }));
    zip.file('sound.ogg', 'audio');
    const archive = await zip.generateAsync({ type: 'blob' });

    const { service } = makeService();
    const plan = await service.buildPlan([
      { kind: 'file', name: 'pack.zip', file: async () => new File([archive], 'pack.zip') },
    ]);

    expect(plan.bundles[0]!.manifest.id).toBe('zipped-id');
    expect([...plan.bundles[0]!.files.keys()]).toEqual(['sound.ogg']);
  });
});

describe('StoreUploadService.entriesFromFileList', () => {
  it('re-nests a webkitdirectory selection into the same tree a folder drop produces', async () => {
    const { service } = makeService();
    const entries = service.entriesFromFileList([
      pickedFile('ui-kit/button.png'),
      pickedFile('ui-kit/nested/panel.png'),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('directory');

    const plan = await service.buildPlan(entries);
    expect([...plan.bundles[0]!.files.keys()].sort()).toEqual(['button.png', 'nested/panel.png']);
  });

  it('treats a plain multi-file selection as one item per file', async () => {
    const { service } = makeService();
    const entries = service.entriesFromFileList([
      new File(['a'], 'a.png'),
      new File(['b'], 'b.png'),
    ]);
    const plan = await service.buildPlan(entries);
    expect(plan.bundles.map(bundle => bundle.manifest.name).sort()).toEqual(['a', 'b']);
  });
});

describe('StoreUploadService.upload', () => {
  async function stageTwo(service: StoreUploadService): Promise<StagedBundle[]> {
    const plan = await service.buildPlan([
      dirEntry('first', [fileEntry('a.png')]),
      dirEntry('second', [fileEntry('b.png')]),
    ]);
    return plan.bundles;
  }

  it('POSTs the manifest/paths/files envelope with credentials and reports progress', async () => {
    const { service, refreshStore } = makeService();
    const [bundle] = await stageTwo(service);
    FakeXhr.respond = xhr => {
      xhr.progress(50, 100);
      xhr.finish(201, JSON.stringify({ id: bundle!.id, status: 'draft' }));
    };

    const onProgress = vi.fn();
    const outcomes = await service.upload([bundle!], { onProgress });

    expect(outcomes).toEqual([{ bundleId: bundle!.id, status: 'ok' }]);
    const xhr = FakeXhr.instances[0]!;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toContain(`/api/library/store/items/${encodeURIComponent(bundle!.id)}`);
    expect(xhr.withCredentials).toBe(true);
    expect(JSON.parse(String(xhr.body!.get('paths')))).toEqual(['a.png']);
    expect(JSON.parse(String(xhr.body!.get('manifest'))).id).toBe(bundle!.id);
    expect(xhr.body!.getAll('files')).toHaveLength(1);
    expect(onProgress).toHaveBeenCalledWith(bundle!.id, 50, 100);
    // The catalog is re-pulled so the panel shows the new item without a manual refresh.
    expect(refreshStore).toHaveBeenCalledTimes(1);
  });

  it('keeps going after a failed bundle and carries the server publish checklist', async () => {
    const { service } = makeService();
    const bundles = await stageTwo(service);
    FakeXhr.respond = xhr => {
      if (FakeXhr.instances.length === 1) {
        xhr.finish(
          400,
          JSON.stringify({
            error: 'Item is not ready to publish',
            issues: [{ field: 'license', message: 'License must be one of: MIT' }],
          })
        );
        return;
      }
      xhr.finish(201, '{}');
    };

    const outcomes = await service.upload(bundles);

    expect(outcomes[0]).toMatchObject({
      status: 'error',
      message: 'Item is not ready to publish',
      issues: [{ field: 'license', message: 'License must be one of: MIT' }],
    });
    expect(outcomes[1]).toMatchObject({ status: 'ok' });
  });

  it('never sends a blocked bundle, and says why', async () => {
    const { service } = makeService();
    const plan = await service.buildPlan([
      dirEntry('heavy', [fileEntry('video.mp4', 'x', 150 * 1024 * 1024)]),
    ]);

    const outcomes = await service.upload(plan.bundles);

    expect(outcomes[0]!.status).toBe('error');
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it('aborts the in-flight bundle and marks the rest cancelled', async () => {
    const { service } = makeService();
    const bundles = await stageTwo(service);
    // Leave the first request hanging so there is something to cancel.
    FakeXhr.respond = () => {};

    const controller = new AbortController();
    const pending = service.upload(bundles, { signal: controller.signal });
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    controller.abort();
    const outcomes = await pending;

    expect(FakeXhr.instances[0]!.aborted).toBe(true);
    expect(outcomes.map(outcome => outcome.status)).toEqual(['cancelled', 'cancelled']);
    // The queue stops rather than firing the remaining requests.
    expect(FakeXhr.instances).toHaveLength(1);
  });
});
