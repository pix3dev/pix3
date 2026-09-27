import type { DiagnosticCode } from './diagnostics.ts';
import type { ProjectFiles } from './project.ts';

/**
 * Whether an `.svg` a scene references will actually render as a texture.
 *
 * Every texture path in Pix3 (editor viewport proxy, play mode `AssetLoader.loadTexture`, the
 * single-file export's embedded-asset Blob) ends the same way: bytes -> `Blob` -> object URL ->
 * three's `TextureLoader` -> an `<img>` -> `texImage2D`. So an SVG sprite renders exactly when a
 * browser `<img>` decodes it, and at the size the `<img>` reports. Measured in Chromium 129:
 *
 * - no `xmlns="http://www.w3.org/2000/svg"` on the root: decode error (nothing renders);
 * - `width` + `height` (px, or absolute units): exact natural size;
 * - one of them + `viewBox`: the other is derived from the viewBox ratio;
 * - `viewBox` only, `%` sizes, sizes in `style=`: a 300x150 default box, the art letterboxed in it;
 * - neither: 300x150, cropped; one dimension without a viewBox: the other is 150;
 * - `<image href>` / CSS `url()` / `@import` to anything but a `#fragment` or `data:` never loads in
 *   the browser's SVG-as-image mode — even a file next to the SVG — so that part draws nothing.
 *
 * Pure string work (no XML dependency): the root open tag and a scan for references are all it needs.
 */

export interface SvgFinding {
  readonly code: Extract<
    DiagnosticCode,
    'E_SVG_INVALID' | 'E_SVG_NO_SIZE' | 'W_SVG_VIEWBOX_ONLY' | 'W_SVG_EXTERNAL_REF'
  >;
  readonly message: string;
  readonly fix: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Absolute CSS length units an `<img>` resolves (em/ex against the 16px default font). */
const ABSOLUTE_LENGTH =
  /^\s*(\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?\s*(px|pt|pc|mm|cm|in|q|em|ex)?\s*$/i;

/** Root `<svg …>` open tag, after any prolog, comments, doctype and processing instructions. */
const findRootTag = (text: string): string | null => {
  let rest = text.replace(/^\uFEFF/, '');
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (rest.startsWith('<?')) {
      const end = rest.indexOf('?>');
      if (end < 0) return null;
      rest = rest.slice(end + 2);
    } else if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end < 0) return null;
      rest = rest.slice(end + 3);
    } else if (/^<!DOCTYPE/i.test(rest)) {
      const match = /^<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/i.exec(rest);
      if (!match) return null;
      rest = rest.slice(match[0].length);
    } else {
      break;
    }
  }
  const match = /^<((?:[A-Za-z_][\w.-]*:)?svg)(?=[\s/>])[^>]*>/.exec(rest);
  return match ? match[0] : null;
};

const attribute = (tag: string, name: string): string | undefined => {
  const re = new RegExp(`\\s${name.replace(':', '\\:')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = re.exec(tag);
  return match ? (match[1] ?? match[2]) : undefined;
};

const absoluteLength = (raw: string | undefined): boolean => {
  if (raw === undefined) return false;
  const match = ABSOLUTE_LENGTH.exec(raw);
  return match !== null && Number(match[1]) > 0;
};

const validViewBox = (raw: string | undefined): boolean => {
  if (raw === undefined) return false;
  const parts = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  return parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0;
};

/** References that leave the document: everything but `#fragment` and `data:` URIs. */
const externalReferences = (text: string): string[] => {
  const found: string[] = [];
  const external = (value: string): boolean => {
    const v = value.trim();
    return v !== '' && !v.startsWith('#') && !/^data:/i.test(v);
  };
  for (const match of text.matchAll(/\s(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = match[1] ?? match[2] ?? '';
    if (external(value)) found.push(`href="${value.trim()}"`);
  }
  for (const match of text.matchAll(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi)) {
    if (external(match[2])) found.push(`url(${match[2].trim()})`);
  }
  for (const match of text.matchAll(/@import\s+([^;]+);?/gi)) {
    found.push(`@import ${match[1].trim()}`);
  }
  return [...new Set(found)];
};

const TEMPLATE_HINT =
  'start from <svg xmlns="http://www.w3.org/2000/svg" width="W" height="H" viewBox="0 0 W H">';

/** Findings for one SVG document (empty = renders as a texture at its declared size). */
export const inspectSvg = (text: string): SvgFinding[] => {
  const root = findRootTag(text);
  if (!root) {
    return [
      {
        code: 'E_SVG_INVALID',
        message: 'the file does not start with an <svg> root element, so no browser decodes it.',
        fix: TEMPLATE_HINT,
      },
    ];
  }
  const findings: SvgFinding[] = [];
  const prefix = /^<([A-Za-z_][\w.-]*):svg/.exec(root)?.[1];
  const xmlns = attribute(root, prefix ? `xmlns:${prefix}` : 'xmlns');
  if (xmlns !== SVG_NS) {
    findings.push({
      code: 'E_SVG_INVALID',
      message: `the <svg> root has ${xmlns === undefined ? 'no xmlns' : `xmlns="${xmlns}"`}; as an image (which every texture load is) the browser refuses to decode it.`,
      fix: `add xmlns="${SVG_NS}" to the <svg> tag`,
    });
  }
  const hasWidth = absoluteLength(attribute(root, 'width'));
  const hasHeight = absoluteLength(attribute(root, 'height'));
  const hasViewBox = validViewBox(attribute(root, 'viewBox'));
  if (!hasWidth && !hasHeight) {
    findings.push(
      hasViewBox
        ? {
            code: 'W_SVG_VIEWBOX_ONLY',
            message:
              'the <svg> root has a viewBox but no width/height (or only % / style sizes): browsers give it no natural size — Chrome rasterises it into a 300x150 box with the art letterboxed inside, so the sprite has the wrong size and aspect.',
            fix: 'add width/height in px to the <svg> tag (the viewBox size, or the size the node draws it at)',
          }
        : {
            code: 'E_SVG_NO_SIZE',
            message:
              'the <svg> root has no width/height and no viewBox: it rasterises into a default 300x150 box and the art is cropped to it.',
            fix: `add width/height in px and a matching viewBox — ${TEMPLATE_HINT}`,
          }
    );
  } else if (hasWidth !== hasHeight && !hasViewBox) {
    findings.push({
      code: 'E_SVG_NO_SIZE',
      message: `the <svg> root has only ${hasWidth ? 'width' : 'height'} and no viewBox: the missing dimension defaults to ${hasWidth ? '150' : '300'}px.`,
      fix: `add ${hasWidth ? 'height' : 'width'} in px (and a viewBox) to the <svg> tag`,
    });
  }
  const refs = externalReferences(text);
  if (refs.length > 0) {
    findings.push({
      code: 'W_SVG_EXTERNAL_REF',
      message: `references outside the file (${refs.slice(0, 3).join(', ')}${refs.length > 3 ? ', …' : ''}) never load when an SVG is drawn as an image — not in the editor, not in play mode, not in the export.`,
      fix: 'inline the shapes or embed the image as a data: URI; use generic font families (sans-serif), no webfonts',
    });
  }
  return findings;
};

const cache = new WeakMap<ProjectFiles, Map<string, SvgFinding[]>>();

/** {@link inspectSvg} of a project file, parsed once per validation run. */
export const inspectProjectSvg = (project: ProjectFiles, projectPath: string): SvgFinding[] => {
  let perProject = cache.get(project);
  if (!perProject) {
    perProject = new Map();
    cache.set(project, perProject);
  }
  let findings = perProject.get(projectPath);
  if (!findings) {
    let text: string;
    try {
      text = project.readText(projectPath);
    } catch {
      text = '';
    }
    findings = inspectSvg(text);
    perProject.set(projectPath, findings);
  }
  return findings;
};

export const isSvgPath = (projectPath: string): boolean => /\.svg$/i.test(projectPath);
