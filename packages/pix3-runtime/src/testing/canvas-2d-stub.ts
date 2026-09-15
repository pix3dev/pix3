/**
 * A 2D canvas context that answers every call, for environments that have none.
 *
 * happy-dom and jsdom both ship `HTMLCanvasElement` with a `getContext` that returns `null`, and
 * `Label2D` measures and paints its text **in its constructor**. The consequence is sharper than it
 * sounds: a scene containing any UI text cannot be *parsed* headlessly at all, let alone run — the
 * loader throws while building the node. That is why every attempt to test a real game scene outside
 * a browser has so far ended at "open Chrome".
 *
 * Nothing here pretends to rasterize. `measureText` is the only call whose return value is load
 * bearing (layout code divides by it), and a flat per-character estimate is enough for every
 * assertion a headless run can honestly make — glyph-accurate text is a screenshot's job.
 */

/** Width in pixels this stub reports per character. Arbitrary, stable, and non-zero. */
const STUB_CHAR_WIDTH = 10;

let installed = false;

export interface Canvas2DStubHandle {
  /** Put back whatever `getContext` was there before. Safe to call twice. */
  uninstall(): void;
}

/**
 * Install the stub on `HTMLCanvasElement.prototype`, once per process.
 *
 * Idempotent: repeated calls (one per spec file in a shared worker) do not stack, and the handle
 * from the first call is the one that restores. A missing `HTMLCanvasElement` — a pure-node
 * environment — is not an error; there is nothing to stub and nothing that would ask.
 */
export function installCanvas2DStub(): Canvas2DStubHandle {
  const proto = globalThis.HTMLCanvasElement?.prototype;
  if (!proto || installed) {
    return { uninstall: () => {} };
  }

  const original = proto.getContext;
  installed = true;

  proto.getContext = function stubGetContext(kind: string) {
    // WebGL is a different problem with a different answer (the null renderer); claiming to
    // provide it here would turn a clear "no GL in this environment" into a mystery.
    if (kind !== '2d') {
      return null;
    }
    const gradient = { addColorStop: () => {} };
    return new Proxy(
      {},
      {
        get(_target, property: string) {
          if (property === 'measureText') {
            return (text: string) => ({
              width: text.length * STUB_CHAR_WIDTH,
              actualBoundingBoxAscent: STUB_CHAR_WIDTH,
              actualBoundingBoxDescent: Math.round(STUB_CHAR_WIDTH * 0.3),
              actualBoundingBoxLeft: 0,
              actualBoundingBoxRight: text.length * STUB_CHAR_WIDTH,
            });
          }
          if (property === 'canvas') {
            return { width: 1, height: 1 };
          }
          if (property === 'getImageData') {
            return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
          }
          if (typeof property === 'string' && property.startsWith('create')) {
            return () => gradient;
          }
          return () => undefined;
        },
        // Painting state (`fillStyle`, `font`, …) is written constantly and never read back here.
        set: () => true,
      }
    );
  } as unknown as HTMLCanvasElement['getContext'];

  return {
    uninstall: () => {
      if (!installed) return;
      proto.getContext = original;
      installed = false;
    },
  };
}
