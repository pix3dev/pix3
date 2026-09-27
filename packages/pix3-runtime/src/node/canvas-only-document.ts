/**
 * The one DOM surface scene hydration touches: `document.createElement('canvas')`.
 *
 * `Label2D` and every `UIControl2D` measure and paint their caption on a 2D canvas **in the
 * constructor**, so hydrating any scene with UI text in plain Node needs a `document` — and that is
 * all it needs (`.plans/measurements/external-agent-phase0-strict-profile.md` §2). The runtime's
 * `testing/canvas-2d-stub.ts` patches `HTMLCanvasElement.prototype`, which only exists under
 * happy-dom; this shim is the pure-Node counterpart: a fake `document` whose canvases hand out a
 * 2D context that accepts every call and measures text as `length × 10` px.
 *
 * The one other element it hands out is the inert `<img>` three's `ImageLoader` asks for through
 * `createElementNS` — `UIControl2D` loads a `texturePath` skin with three's `TextureLoader` directly
 * in its constructor, bypassing the `AssetLoader`. The image never loads (no event ever fires), which
 * is the right answer for a validator: pixels are not its business.
 *
 * Deliberately narrow otherwise: `createElement` of anything but `canvas` throws, so a runtime path
 * that starts needing more of the DOM fails loudly instead of silently rendering garbage.
 */

const STUB_CHAR_WIDTH = 10;

/** A 2D context that accepts everything: `measureText` is `length × 10`, the rest are no-ops. */
export const createStub2DContext = (): unknown => {
  const gradient = { addColorStop: () => {} };
  return new Proxy(
    {},
    {
      get(_target, property: string | symbol) {
        if (property === 'measureText') {
          return (text: string) => ({
            width: text.length * STUB_CHAR_WIDTH,
            actualBoundingBoxAscent: STUB_CHAR_WIDTH,
            actualBoundingBoxDescent: 3,
            actualBoundingBoxLeft: 0,
            actualBoundingBoxRight: text.length * STUB_CHAR_WIDTH,
          });
        }
        if (property === 'getImageData') {
          return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
        }
        if (typeof property === 'string' && property.startsWith('create')) {
          return () => gradient;
        }
        return () => undefined;
      },
      set: () => true,
    }
  );
};

export interface CanvasOnlyDocument {
  createElement(tag: string): unknown;
  createElementNS(namespace: string, tag: string): unknown;
}

const createInertImage = (): Record<string, unknown> => ({
  style: {},
  src: '',
  crossOrigin: null,
  complete: false,
  width: 0,
  height: 0,
  addEventListener: () => {},
  removeEventListener: () => {},
});

export const createCanvasOnlyDocument = (): CanvasOnlyDocument => ({
  createElement(tag: string) {
    if (tag !== 'canvas') {
      throw new Error(`canvas-only document shim: createElement('${tag}') is not provided`);
    }
    return {
      width: 1,
      height: 1,
      style: {},
      getContext: (kind: string) => (kind === '2d' ? createStub2DContext() : null),
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  },
  createElementNS(_namespace: string, tag: string) {
    if (tag !== 'img') {
      throw new Error(`canvas-only document shim: createElementNS('${tag}') is not provided`);
    }
    return createInertImage();
  },
});

/**
 * Install the shim as `globalThis.document`; returns the uninstaller. A no-op (returning a no-op)
 * when a real `document` already exists — under happy-dom or in a browser the shim must never
 * shadow the real thing.
 */
export const installCanvasOnlyDocument = (): (() => void) => {
  if (typeof Reflect.get(globalThis, 'document') !== 'undefined') {
    return () => {};
  }
  Reflect.set(globalThis, 'document', createCanvasOnlyDocument());
  return () => {
    Reflect.deleteProperty(globalThis, 'document');
  };
};
