/**
 * Register a project's web fonts before anything draws text.
 *
 * WHY THIS EXISTS. Canvas text takes a family NAME; if no face by that name is registered the
 * browser silently substitutes one — the caption still paints, at a different width, in a
 * different face. That is how a generated UI kit lost its typography between the forge preview
 * (which inlines the face into the SVG it rasterizes) and the game, where every caption came out
 * in Arial. `ProjectManifest.fonts` names the files; this loads them.
 *
 * Two properties matter and are both deliberate:
 *
 *  - **Awaited before the first frame.** A face that arrives late repaints every label a frame
 *    or two in — and a paused or unfocused session freezes on the frame that has the wrong face.
 *    The same argument the localization seed makes (`SceneRunner.setupLocalization`).
 *  - **It never throws.** A missing or corrupt font file must not stop a game from starting; the
 *    caption falls back to a system face, exactly as it did before the manifest named one.
 *
 * Loading is idempotent per family+weight+style, so re-entering play mode costs nothing and the
 * editor and the runtime can both call it against the same document.
 */

/** One face to register, as it appears in `pix3project.yaml`. */
export interface ProjectFontFaceSpec {
  family: string;
  /** Project-relative path (`fonts/nunito-900-latin.woff2`); read through the resource seam. */
  path: string;
  weight?: number | string;
  style?: 'normal' | 'italic';
  unicodeRange?: string;
}

/** What the loader needs from the host: bytes for a `res://` path. */
export interface FontResourceReader {
  readBlob(resourcePath: string): Promise<Blob>;
}

export interface FontLoadReport {
  loaded: string[];
  failed: { face: string; reason: string }[];
}

const registered = new Set<string>();

const faceKey = (spec: ProjectFontFaceSpec): string =>
  `${spec.family}|${spec.weight ?? 400}|${spec.style ?? 'normal'}|${spec.path}`;

/** Human-readable name of a face, for a log line or a report row. */
export const describeFontFace = (spec: ProjectFontFaceSpec): string =>
  `${spec.family} ${spec.weight ?? 400}${spec.style === 'italic' ? ' italic' : ''}`;

type FaceOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Loads still in the air, by face key. The editor registers a project's fonts on open and play
 * mode registers the same list moments later; without this the second call would race the first
 * to `document.fonts` and add the face twice.
 */
const inFlight = new Map<string, Promise<FaceOutcome>>();

/** Forget what has been registered — tests only; the document keeps its faces. */
export function resetProjectFontRegistry(): void {
  registered.clear();
  inFlight.clear();
}

/** True when this face has already been added to `document.fonts` in this session. */
export function isFontFaceRegistered(spec: ProjectFontFaceSpec): boolean {
  return registered.has(faceKey(spec));
}

/**
 * Load and register every face, resolving once they are usable.
 *
 * @param faces  the manifest's `fonts` list (empty/undefined resolves immediately)
 * @param reader reads the font file — the same seam textures and locale tables use
 * @param timeoutMs per-face budget; a font that never arrives must not hang the boot
 */
export async function loadProjectFonts(
  faces: readonly ProjectFontFaceSpec[] | undefined,
  reader: FontResourceReader,
  timeoutMs = 5000
): Promise<FontLoadReport> {
  const report: FontLoadReport = { loaded: [], failed: [] };
  if (!faces || faces.length === 0) return report;
  // `document.fonts` is absent under Node and in a worker: nothing to register, and the caller
  // must not have to know which environment it is in.
  if (typeof document === 'undefined' || !document.fonts || typeof FontFace === 'undefined') {
    return report;
  }

  await Promise.all(
    faces.map(async spec => {
      const key = faceKey(spec);
      if (registered.has(key)) return;
      let pending = inFlight.get(key);
      if (!pending) {
        pending = registerFace(spec, reader, timeoutMs).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      const outcome = await pending;
      if (outcome.ok) {
        report.loaded.push(describeFontFace(spec));
      } else {
        report.failed.push({ face: describeFontFace(spec), reason: outcome.reason });
      }
    })
  );
  return report;
}

async function registerFace(
  spec: ProjectFontFaceSpec,
  reader: FontResourceReader,
  timeoutMs: number
): Promise<FaceOutcome> {
  try {
    const resourcePath = spec.path.startsWith('res://') ? spec.path : `res://${spec.path}`;
    const blob = await reader.readBlob(resourcePath);
    const buffer = await blob.arrayBuffer();
    const face = new FontFace(spec.family, buffer, {
      weight: String(spec.weight ?? 400),
      style: spec.style ?? 'normal',
      ...(spec.unicodeRange ? { unicodeRange: spec.unicodeRange } : {}),
    });
    const loaded = await withTimeout(face.load(), timeoutMs, describeFontFace(spec));
    document.fonts.add(loaded);
    registered.add(faceKey(spec));
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[ProjectFontLoader] ${describeFontFace(spec)} (${spec.path}) could not be loaded; ` +
        `captions in that family fall back to a system face: ${reason}`
    );
    return { ok: false, reason };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}
