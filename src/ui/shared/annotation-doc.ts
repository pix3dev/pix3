/**
 * The annotation document — strokes drawn over a reference image (design §3.7, phase V7).
 *
 * Storage is deliberately two-layered, and neither layer alone would do:
 *
 *  - `<base>.annot.json` (this model) holds the strokes. It is small, it is editable, and reopening
 *    the picture continues the annotation instead of starting a new one.
 *  - `<base>.annot.png` is the composite, written when the annotation is sent. The model needs an
 *    image block to *see* it, and by the hard rule of the parent plan §5.7 anything the agent is
 *    shown has to exist as a project file — so it survives a compaction and is still reachable by
 *    `analyze_image` / `fs_read` twenty turns later.
 *
 * Coordinates live in the SOURCE IMAGE's pixel space, never in screen pixels: the same annotation
 * has to survive a resized window, a zoomed lightbox and a different monitor, and the flattened PNG
 * is rendered at the image's natural size.
 */

/** Format version. Bumped only for a change a tolerant reader cannot absorb. */
export const ANNOTATION_FORMAT_VERSION = 1;

export type AnnotationTool = 'pen' | 'arrow' | 'rect' | 'text';

/** A point in source-image pixels. `pressure` is 0..1; 0.5 is what a mouse reports. */
export interface AnnotationPoint {
  readonly x: number;
  readonly y: number;
  readonly pressure: number;
}

export interface AnnotationStroke {
  readonly tool: AnnotationTool;
  /** `#rrggbb`. */
  readonly color: string;
  /** Nominal line width in source-image pixels; pen strokes scale it by pressure. */
  readonly width: number;
  /** Pen: the whole path. Arrow/rect: exactly two points (from, to). Text: one (the anchor). */
  readonly points: readonly AnnotationPoint[];
  /** Only for `text`. */
  readonly text?: string;
}

export interface AnnotationDoc {
  readonly version: number;
  /** Project-relative path of the image these strokes belong to. */
  readonly source: string;
  /** Natural size of that image — the space `points` are expressed in. */
  readonly width: number;
  readonly height: number;
  readonly strokes: readonly AnnotationStroke[];
}

/** Where the two sidecars for an image live: next to it, by convention. */
export const annotationPaths = (
  sourcePath: string
): { readonly json: string; readonly png: string } => {
  const base = sourcePath.replace(/\.[^./]+$/, '');
  return { json: `${base}.annot.json`, png: `${base}.annot.png` };
};

/** True for a path this module produced — those must never be annotated again, recursively. */
export const isAnnotationArtifact = (path: string): boolean => /\.annot\.(json|png)$/i.test(path);

export const createAnnotationDoc = (
  source: string,
  width: number,
  height: number,
  strokes: readonly AnnotationStroke[] = []
): AnnotationDoc => ({
  version: ANNOTATION_FORMAT_VERSION,
  source,
  width,
  height,
  strokes,
});

export const serializeAnnotation = (doc: AnnotationDoc): string =>
  `${JSON.stringify(doc, null, 2)}\n`;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const parsePoint = (value: unknown): AnnotationPoint | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!isFiniteNumber(record.x) || !isFiniteNumber(record.y)) {
    return null;
  }
  // A file written before pressure existed, or by a hand-edit, still draws — at mouse weight.
  const pressure = isFiniteNumber(record.pressure) ? record.pressure : 0.5;
  return { x: record.x, y: record.y, pressure: Math.min(1, Math.max(0, pressure)) };
};

const TOOLS: readonly AnnotationTool[] = ['pen', 'arrow', 'rect', 'text'];

const parseStroke = (value: unknown): AnnotationStroke | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const tool = TOOLS.find(candidate => candidate === record.tool);
  if (!tool) {
    return null;
  }
  const points = Array.isArray(record.points)
    ? record.points.map(parsePoint).filter((point): point is AnnotationPoint => point !== null)
    : [];
  if (points.length === 0) {
    return null;
  }
  const text = typeof record.text === 'string' ? record.text : undefined;
  if (tool === 'text' && !text) {
    return null;
  }
  return {
    tool,
    color: typeof record.color === 'string' ? record.color : '#ff3b30',
    width: isFiniteNumber(record.width) && record.width > 0 ? record.width : 4,
    points,
    ...(text ? { text } : {}),
  };
};

/**
 * Read an annotation file, forgivingly.
 *
 * A sidecar the user hand-edited, or one written by a newer editor, must not cost them the strokes
 * that ARE readable: every malformed stroke is dropped and the rest are kept. Returns null only
 * when the file is not an annotation document at all — the caller then starts a fresh one rather
 * than refusing to open the picture.
 */
export const parseAnnotation = (text: string, fallbackSource: string): AnnotationDoc | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.strokes)) {
    return null;
  }
  const strokes = record.strokes
    .map(parseStroke)
    .filter((stroke): stroke is AnnotationStroke => stroke !== null);
  return {
    version: isFiniteNumber(record.version) ? record.version : ANNOTATION_FORMAT_VERSION,
    source: typeof record.source === 'string' ? record.source : fallbackSource,
    width: isFiniteNumber(record.width) ? record.width : 0,
    height: isFiniteNumber(record.height) ? record.height : 0,
    strokes,
  };
};

/**
 * How the source image sits inside the stage: `contain`, centred.
 *
 * Returned as a scale plus an offset rather than a rect because both directions are needed — screen
 * pointer to image pixels while drawing, image pixels to screen while painting — and deriving one
 * from the other twice is how the two drift apart by a pixel.
 */
export interface AnnotationFit {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export const fitImage = (
  imageWidth: number,
  imageHeight: number,
  stageWidth: number,
  stageHeight: number
): AnnotationFit => {
  if (imageWidth <= 0 || imageHeight <= 0 || stageWidth <= 0 || stageHeight <= 0) {
    return { scale: 1, offsetX: 0, offsetY: 0 };
  }
  const scale = Math.min(stageWidth / imageWidth, stageHeight / imageHeight);
  return {
    scale,
    offsetX: (stageWidth - imageWidth * scale) / 2,
    offsetY: (stageHeight - imageHeight * scale) / 2,
  };
};

/** Stage coordinates → source-image pixels. The inverse of what the painter applies. */
export const toImageSpace = (
  fit: AnnotationFit,
  stageX: number,
  stageY: number
): { readonly x: number; readonly y: number } => ({
  x: (stageX - fit.offsetX) / fit.scale,
  y: (stageY - fit.offsetY) / fit.scale,
});

/**
 * Pen width for one sample: nominal width modulated by pen pressure.
 *
 * A stylus reports a real 0..1; a mouse always reports 0.5, which lands exactly on the nominal
 * width — so the same code draws an even line for a mouse and a tapered one for a pen, with no
 * branch on input type.
 */
export const pressureWidth = (nominal: number, pressure: number): number =>
  Math.max(0.5, nominal * (0.5 + pressure));

/** A one-line description of what was drawn, for the message that carries the annotation. */
export const describeAnnotation = (doc: AnnotationDoc): string => {
  const counts = new Map<AnnotationTool, number>();
  for (const stroke of doc.strokes) {
    counts.set(stroke.tool, (counts.get(stroke.tool) ?? 0) + 1);
  }
  const labels: Record<AnnotationTool, [string, string]> = {
    pen: ['stroke', 'strokes'],
    arrow: ['arrow', 'arrows'],
    rect: ['box', 'boxes'],
    text: ['label', 'labels'],
  };
  const parts = TOOLS.filter(tool => counts.has(tool)).map(tool => {
    const count = counts.get(tool) ?? 0;
    return `${count} ${labels[tool][count === 1 ? 0 : 1]}`;
  });
  return parts.join(', ');
};
