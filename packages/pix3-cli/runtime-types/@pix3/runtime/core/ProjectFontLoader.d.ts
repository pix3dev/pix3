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
    failed: {
        face: string;
        reason: string;
    }[];
}
/** Human-readable name of a face, for a log line or a report row. */
export declare const describeFontFace: (spec: ProjectFontFaceSpec) => string;
/** Forget what has been registered — tests only; the document keeps its faces. */
export declare function resetProjectFontRegistry(): void;
/** True when this face has already been added to `document.fonts` in this session. */
export declare function isFontFaceRegistered(spec: ProjectFontFaceSpec): boolean;
/**
 * Load and register every face, resolving once they are usable.
 *
 * @param faces  the manifest's `fonts` list (empty/undefined resolves immediately)
 * @param reader reads the font file — the same seam textures and locale tables use
 * @param timeoutMs per-face budget; a font that never arrives must not hang the boot
 */
export declare function loadProjectFonts(faces: readonly ProjectFontFaceSpec[] | undefined, reader: FontResourceReader, timeoutMs?: number): Promise<FontLoadReport>;
