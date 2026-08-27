import { describe, expect, it } from 'vitest';

import {
  ANNOTATION_FORMAT_VERSION,
  annotationPaths,
  createAnnotationDoc,
  describeAnnotation,
  fitImage,
  isAnnotationArtifact,
  parseAnnotation,
  pressureWidth,
  serializeAnnotation,
  toImageSpace,
  type AnnotationStroke,
} from './annotation-doc';

const pen: AnnotationStroke = {
  tool: 'pen',
  color: '#f5ae39',
  width: 4,
  points: [
    { x: 10, y: 20, pressure: 0.5 },
    { x: 30, y: 40, pressure: 0.9 },
  ],
};

describe('annotationPaths', () => {
  it('names the sidecars after the image, not after its extension', () => {
    expect(annotationPaths('references/mood-1.png')).toEqual({
      json: 'references/mood-1.annot.json',
      png: 'references/mood-1.annot.png',
    });
  });

  it('handles a dotted folder without eating the path', () => {
    expect(annotationPaths('design/v1.2/hero.jpeg').json).toBe('design/v1.2/hero.annot.json');
  });
});

describe('isAnnotationArtifact', () => {
  /** Guards against a composite being annotated again, which would nest drawings forever. */
  it('recognises what this module writes', () => {
    expect(isAnnotationArtifact('references/mood-1.annot.png')).toBe(true);
    expect(isAnnotationArtifact('references/mood-1.annot.json')).toBe(true);
    expect(isAnnotationArtifact('references/mood-1.png')).toBe(false);
  });
});

describe('serialize / parse', () => {
  it('round-trips a document', () => {
    const doc = createAnnotationDoc('references/mood-1.png', 800, 600, [pen]);
    expect(parseAnnotation(serializeAnnotation(doc), 'unused')).toEqual(doc);
    expect(doc.version).toBe(ANNOTATION_FORMAT_VERSION);
  });

  /**
   * A hand-edited or newer sidecar must not cost the user the strokes that ARE readable — the file
   * is their drawing, not a config.
   */
  it('keeps the readable strokes and drops only the broken ones', () => {
    const text = JSON.stringify({
      version: 99,
      source: 'references/mood-1.png',
      width: 800,
      height: 600,
      strokes: [
        pen,
        { tool: 'wormhole', points: [{ x: 1, y: 1 }] },
        { tool: 'pen', points: [] },
        { tool: 'text', color: '#fff', width: 20, points: [{ x: 5, y: 5 }] },
      ],
    });
    const doc = parseAnnotation(text, 'fallback.png');
    expect(doc?.strokes).toHaveLength(1);
    expect(doc?.strokes[0].tool).toBe('pen');
    expect(doc?.version).toBe(99);
  });

  it('defaults a missing pressure to what a mouse reports, so old files still draw', () => {
    const text = JSON.stringify({
      strokes: [{ tool: 'pen', color: '#fff', width: 3, points: [{ x: 1, y: 2 }] }],
    });
    expect(parseAnnotation(text, 'a.png')?.strokes[0].points[0].pressure).toBe(0.5);
  });

  it('falls back to the caller path when the file does not name its source', () => {
    const text = JSON.stringify({ strokes: [pen] });
    expect(parseAnnotation(text, 'references/mood-1.png')?.source).toBe('references/mood-1.png');
  });

  it('is null for something that is not an annotation at all', () => {
    expect(parseAnnotation('not json', 'a.png')).toBeNull();
    expect(parseAnnotation('{"hello":1}', 'a.png')).toBeNull();
  });
});

describe('fitImage / toImageSpace', () => {
  it('contains the image and centres the leftover axis', () => {
    // 800x600 into 400x400: scale 0.5, 100px of letterbox above and below.
    expect(fitImage(800, 600, 400, 400)).toEqual({ scale: 0.5, offsetX: 0, offsetY: 50 });
  });

  /** The transform pair has to invert exactly, or a stroke lands where the cursor was not. */
  it('maps a stage point back to image pixels', () => {
    const fit = fitImage(800, 600, 400, 400);
    expect(toImageSpace(fit, 0, 50)).toEqual({ x: 0, y: 0 });
    expect(toImageSpace(fit, 400, 350)).toEqual({ x: 800, y: 600 });
  });

  it('degrades to identity rather than dividing by zero before the image has loaded', () => {
    expect(fitImage(0, 0, 400, 400)).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });
});

describe('pressureWidth', () => {
  /**
   * A mouse always reports 0.5, which lands exactly on the nominal width — so one code path draws
   * an even line for a mouse and a tapered one for a stylus, with no branch on input type.
   */
  it('is the nominal width at mouse pressure', () => {
    expect(pressureWidth(4, 0.5)).toBe(4);
  });

  it('tapers with a light touch and thickens with a heavy one', () => {
    expect(pressureWidth(4, 0)).toBeLessThan(4);
    expect(pressureWidth(4, 1)).toBeGreaterThan(4);
  });

  it('never reaches zero, which would draw nothing at all', () => {
    expect(pressureWidth(0, 0)).toBeGreaterThan(0);
  });
});

describe('describeAnnotation', () => {
  it('counts what was drawn, in singular and plural', () => {
    const doc = createAnnotationDoc('a.png', 10, 10, [
      pen,
      { ...pen, tool: 'arrow' },
      { ...pen, tool: 'arrow' },
    ]);
    expect(describeAnnotation(doc)).toBe('1 stroke, 2 arrows');
  });

  it('says nothing about an empty annotation', () => {
    expect(describeAnnotation(createAnnotationDoc('a.png', 10, 10))).toBe('');
  });
});
