/**
 * Fetch the woff2 files of a Google-hosted family so a project can SHIP them.
 *
 * WHY. The forge inlines a face into the SVG it rasterizes, so the page's preview always shows
 * the real typeface. The engine has no such luxury: a canvas takes a family NAME, and if no face
 * by that name is registered the browser substitutes one silently — which is how a kit designed
 * in Lilita One arrived in the game as Arial. Copying the files into the project and naming them
 * in `pix3project.yaml` is what closes that gap; `ProjectFontLoader` (runtime) registers them
 * before the first frame.
 *
 * Two subsets are taken per family, not one: the Latin and the Cyrillic block, each with its own
 * `unicode-range`. Both are declared at the same family and weight, so without the range the last
 * rule would answer for every character and the Cyrillic file would be asked for Latin glyphs it
 * does not have.
 *
 * Everything here is best-effort: the CDN is a network dependency the editor cannot assume. A
 * failure is reported, never thrown — the kit is still written, and the caption falls back to a
 * system face exactly as it did before.
 */

/** One downloaded subset of one family at one weight. */
export interface FetchedFontFile {
  family: string;
  weight: number;
  /** `latin`, `cyrillic`, … — part of the file name so two subsets never collide. */
  subset: string;
  unicodeRange?: string;
  data: ArrayBuffer;
}

export interface FontFetchResult {
  files: FetchedFontFile[];
  warnings: string[];
}

/** The subsets worth shipping, in the order they are declared in the file name. */
const WANTED_SUBSETS = ['latin', 'cyrillic'];

/** A file-name-safe form of a family (`Lilita One` → `lilita-one`). */
export function fontSlug(family: string): string {
  return family
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The project-relative path a fetched face is written to. */
export function fontFilePath(file: { family: string; weight: number; subset: string }): string {
  return `fonts/${fontSlug(file.family)}-${file.weight}-${file.subset}.woff2`;
}

/**
 * Download every shippable subset of `family` at `weight`.
 *
 * @param fetchImpl injected so a spec can answer without a network (and so the editor can be
 *   pointed at a mirror later without touching the parsing).
 */
export async function fetchGoogleFontFiles(
  family: string,
  weight: number,
  fetchImpl: typeof fetch = fetch
): Promise<FontFetchResult> {
  const warnings: string[] = [];
  const files: FetchedFontFile[] = [];
  try {
    const familyParam = family.replace(/ /g, '+');
    const response = await fetchImpl(
      `https://fonts.googleapis.com/css2?family=${familyParam}:wght@${weight}&display=swap`
    );
    if (!response.ok) throw new Error(`stylesheet HTTP ${response.status}`);
    const sheet = await response.text();

    // The stylesheet is a run of "/* subset */ @font-face {…}" pairs; read the subset off each
    // pair rather than searching for one, because a family may declare neither name.
    const pairs = [...sheet.matchAll(/\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*\{[^}]+\})/g)];
    let blocks: { subset: string; block: string }[] = pairs
      .filter(match => WANTED_SUBSETS.includes(match[1] ?? ''))
      .map(match => ({ subset: match[1] ?? 'latin', block: match[2] ?? '' }));
    if (blocks.length === 0) {
      const any = /@font-face\s*\{[^}]+\}/.exec(sheet)?.[0];
      blocks = any ? [{ subset: 'latin', block: any }] : [];
    }
    if (blocks.length === 0) throw new Error('no @font-face block in the stylesheet');

    for (const { subset, block } of blocks) {
      const url = /url\((https:[^)]+)\)/.exec(block)?.[1];
      if (!url) continue;
      const fileResponse = await fetchImpl(url);
      if (!fileResponse.ok) {
        warnings.push(`${family} ${weight} (${subset}): HTTP ${fileResponse.status}`);
        continue;
      }
      const range = /unicode-range:\s*([^;}]+)/.exec(block)?.[1]?.trim();
      files.push({
        family,
        weight,
        subset,
        ...(range ? { unicodeRange: range } : {}),
        data: await fileResponse.arrayBuffer(),
      });
    }
    if (files.length === 0) warnings.push(`${family} ${weight}: no woff2 url in the stylesheet`);
  } catch (error) {
    warnings.push(
      `${family} ${weight}: ${error instanceof Error ? error.message : String(error)} — captions ` +
        'in that family fall back to a system face until the font is added by hand.'
    );
  }
  return { files, warnings };
}
