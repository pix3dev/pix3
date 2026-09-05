/**
 * The core's load-bearing invariant, enforced by scanning its own sources.
 *
 * `src/services/uikit/**` is a PURE generator two very different hosts sit on top of: the
 * standalone page (no editor services at all) and the editor panel. They diverge the moment a
 * generator learns about a host — the plan calls this out as a named risk (§7: "two hosts over
 * one core drift apart if the generator starts knowing about the host; the invariant is held
 * by a test"). So: no editor imports, no three.js, no browser globals. Rasterization, file
 * writing and storage are the host's, always.
 *
 * The scan strips comments and string literals first, because prose legitimately says
 * "document" and a generated SVG legitimately contains `http://www.w3.org/2000/svg`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const UIKIT_ROOT = __dirname;

/** Every non-spec source of the core. */
function listSources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listSources(entryPath));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) found.push(entryPath);
  }
  return found;
}

const rel = (file: string): string => path.relative(UIKIT_ROOT, file).split(path.sep).join('/');

interface Frame {
  mode: 'code' | 'tplcode' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
  depth: number;
}

/**
 * Drop comments and string/template literal bodies, keeping the code — including the code
 * inside a `${}` substitution, which is real code and could hide a global.
 *
 * Deliberately not a full parser: it does not track regex literals, which is safe here
 * because none of the core's regexes contain a `//`, `/*` or a quote character.
 */
function codeOnly(src: string): string {
  const stack: Frame[] = [{ mode: 'code', depth: 0 }];
  let out = '';
  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const d = src[i + 1];
    if (top.mode === 'line') {
      if (c === '\n') {
        stack.pop();
        out += '\n';
      }
      i++;
      continue;
    }
    if (top.mode === 'block') {
      if (c === '*' && d === '/') {
        stack.pop();
        i += 2;
      } else i++;
      continue;
    }
    if (top.mode === 'sq' || top.mode === 'dq' || top.mode === 'tpl') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (
        (top.mode === 'sq' && c === "'") ||
        (top.mode === 'dq' && c === '"') ||
        (top.mode === 'tpl' && c === '`')
      ) {
        stack.pop();
        out += ' ';
        i++;
        continue;
      }
      if (top.mode === 'tpl' && c === '$' && d === '{') {
        stack.push({ mode: 'tplcode', depth: 0 });
        i += 2;
        out += ' ';
        continue;
      }
      i++;
      continue;
    }
    // code / tplcode
    if (c === '/' && d === '/') {
      stack.push({ mode: 'line', depth: 0 });
      i += 2;
      continue;
    }
    if (c === '/' && d === '*') {
      stack.push({ mode: 'block', depth: 0 });
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      stack.push({ mode: c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl', depth: 0 });
      i++;
      continue;
    }
    if (top.mode === 'tplcode') {
      if (c === '{') top.depth++;
      else if (c === '}') {
        if (top.depth === 0) {
          stack.pop();
          i++;
          out += ' ';
          continue;
        }
        top.depth--;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Every module specifier the file imports or re-exports from.
 *
 * Line-scoped on purpose: a naive whole-file regex also matched the word "from" inside a
 * multi-line English sentence in `style-doc.ts` and reported the next string literal as an
 * import.
 */
function specifiersOf(src: string): string[] {
  const out: string[] = [];
  const importLine = /^\s*(?:import\b|export\b|\}?\s*from\b)/;
  const specifier = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  for (const line of src.split('\n')) {
    if (!importLine.test(line)) continue;
    specifier.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = specifier.exec(line)) !== null) out.push(m[1]);
  }
  return out;
}

/** Globals a pure generator must never touch — rasterization and storage belong to a host. */
const FORBIDDEN_GLOBALS = [
  'document',
  'window',
  'localStorage',
  'sessionStorage',
  'navigator',
  'fetch',
  'XMLHttpRequest',
  'indexedDB',
  'globalThis',
  'process',
];

describe('uikit core is host-agnostic', () => {
  const sources = listSources(UIKIT_ROOT);

  it('has sources to scan at all', () => {
    // Guards against the scan silently passing because the walk found nothing.
    expect(sources.length).toBeGreaterThan(10);
  });

  it('imports nothing from outside src/services/uikit', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const src = readFileSync(file, 'utf8');
      for (const spec of specifiersOf(src)) {
        if (!spec.startsWith('.')) {
          offenders.push(`${rel(file)}: "${spec}"`);
          continue;
        }
        const resolved = path.resolve(path.dirname(file), spec);
        if (!resolved.startsWith(UIKIT_ROOT + path.sep)) {
          offenders.push(`${rel(file)}: "${spec}" escapes the folder`);
        }
      }
    }

    expect(
      offenders,
      'The uikit core must not import from @/services (outside uikit), @/ui, @/state, @/fw, ' +
        'three or @pix3/runtime — two hosts share this generator and it drifts the moment one ' +
        'of them leaks into it. Every import is relative and stays inside src/services/uikit.'
    ).toEqual([]);
  });

  it('never touches a browser global', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const name of FORBIDDEN_GLOBALS) {
        if (new RegExp(`\\b${name}\\b`).test(code)) offenders.push(`${rel(file)}: ${name}`);
      }
    }

    expect(
      offenders,
      'Rasterization, file writing and storage are a HOST concern. The core builds strings; ' +
        'the standalone page and the editor panel decide what to do with them.'
    ).toEqual([]);
  });

  it('the comment/string stripper itself works', () => {
    // If this regressed, the global scan above would pass by accident.
    const stripped = codeOnly(
      `// window is fine in a comment\n` +
        `/* so is document */\n` +
        `const a = 'localStorage';\n` +
        `const b = \`http://x/y \${theme().radius}\`;\n` +
        `const c = 1;\n`
    );
    expect(stripped).not.toContain('window');
    expect(stripped).not.toContain('document');
    expect(stripped).not.toContain('localStorage');
    expect(stripped).not.toContain('http');
    expect(stripped).toContain('theme().radius');
    expect(stripped).toContain('const c = 1;');
  });
});
