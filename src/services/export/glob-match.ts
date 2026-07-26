/**
 * Minimal glob matching for export asset selection (`ExportSettings`).
 *
 * Deliberately hand-rolled rather than pulling in `micromatch`/`picomatch`: this
 * runs only in the editor's export pipeline over project-relative paths, and the
 * three constructs below cover every pattern the manifest needs.
 *
 * - `*`  — any run of characters within one path segment
 * - `**` — any run of characters across segments (`a/**` matches `a/b/c.png`);
 *          used as a whole segment it may also match zero segments
 * - `?`  — exactly one character within a segment
 */

const REGEXP_SPECIALS = /[.+^${}()|[\]\\]/g;

const escapeRegExp = (value: string): string => value.replace(REGEXP_SPECIALS, '\\$&');

/** Compile one glob into an anchored `RegExp` over project-relative paths. */
export const globToRegExp = (pattern: string): RegExp => {
  let source = '';
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];

    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` spans zero or more whole segments, so `a/**/b.png` matches both
        // `a/b.png` and `a/deep/b.png`. A trailing/standalone `**` takes the rest.
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 3;
          continue;
        }

        source += '.*';
        index += 2;
        continue;
      }

      source += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    source += escapeRegExp(char ?? '');
    index += 1;
  }

  return new RegExp(`^${source}$`);
};

/**
 * Build a matcher for a pattern list. An empty list yields a matcher that never
 * matches — so an absent/empty manifest block is a no-op, never a catch-all.
 */
export const createGlobMatcher = (patterns: readonly string[]): ((path: string) => boolean) => {
  if (patterns.length === 0) {
    return () => false;
  }

  const expressions = patterns.map(pattern => globToRegExp(pattern));
  return (path: string): boolean => expressions.some(expression => expression.test(path));
};
