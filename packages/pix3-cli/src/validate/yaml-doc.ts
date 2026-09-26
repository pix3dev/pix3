import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node as YamlNode } from 'yaml';

/** A path into a parsed document: mapping keys and sequence indices. */
export type DocPath = readonly (string | number)[];

/** `root[0].children[1].properties.material.color` */
export const formatPath = (path: DocPath): string => {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out.length === 0 ? segment : `.${segment}`;
  }
  return out;
};

export interface ParsedYaml {
  /** The document as plain JS (what the loader sees). */
  readonly data: unknown;
  /** 1-based line of the value (or, for a mapping key, of the key) at `path`. */
  lineOf(path: DocPath): number | undefined;
}

export interface YamlParseError {
  readonly message: string;
  readonly line?: number;
}

/**
 * Parse a scene the way the loader does (`yaml.parse` semantics — duplicate keys are an error) but
 * keep the CST so diagnostics can carry a line number.
 */
export const parseYamlWithLines = (text: string): ParsedYaml | { errors: YamlParseError[] } => {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    return {
      errors: document.errors.map(error => ({
        message: error.message.split('\n')[0] ?? error.message,
        line: error.linePos?.[0]?.line,
      })),
    };
  }
  const lineOfOffset = (offset: number | undefined): number | undefined =>
    offset === undefined ? undefined : lineCounter.linePos(offset).line;
  return {
    data: document.toJS({ maxAliasCount: 1000 }),
    lineOf(path: DocPath): number | undefined {
      let current: unknown = document.contents;
      let line = lineOfOffset((current as YamlNode | null)?.range?.[0]);
      for (const segment of path) {
        if (isMap(current)) {
          const pair = current.items.find(item =>
            isScalar(item.key) ? item.key.value === segment : item.key === segment
          );
          if (!pair) return line;
          line = lineOfOffset(isScalar(pair.key) ? pair.key.range?.[0] : undefined) ?? line;
          current = pair.value;
        } else if (isSeq(current) && typeof segment === 'number') {
          const item = current.items[segment];
          if (!item) return line;
          line = lineOfOffset((item as YamlNode).range?.[0]) ?? line;
          current = item;
        } else {
          return line;
        }
      }
      return line;
    },
  };
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
