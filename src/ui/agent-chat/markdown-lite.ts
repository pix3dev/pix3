import { html, type TemplateResult } from 'lit';

/** Options for {@link renderMarkdownLite}. Omit them entirely to get the chat renderer. */
export interface MarkdownLiteOptions {
  /**
   * `'chat'` (the default) is the agent-reply grammar; `'doc'` adds the document grammar (tables,
   * task lists, blockquotes, h4–h6, rules, images, heading anchors) and stamps `data-md-lines` on
   * every block. The two are deliberately separate: chat markup is load-bearing for the transcript
   * and must not drift when the document renderer grows.
   */
  mode?: 'chat' | 'doc';
  /**
   * Maps a non-http image source (`res://references/hero.png`) to a URL the document may load, or
   * `null` when the file is unknown. Synchronous on purpose — the renderer is pure, so the caller
   * pre-resolves blob URLs and hands over a lookup (see `pix3-idea-doc`).
   */
  resolveImage?: (src: string) => string | null;
}

/** Inline-span options; presence of this object is what enables the doc-only inline grammar. */
interface InlineOptions {
  readonly resolveImage?: (src: string) => string | null;
}

/** One accumulated list item. `line` is the single source line it came from. */
interface ListItemAccum {
  readonly text: string;
  readonly line: number;
  readonly task: 'done' | 'todo' | null;
}

interface ListAccum {
  readonly ordered: boolean;
  readonly items: ListItemAccum[];
  readonly start: number;
  end: number;
}

type CellAlignment = 'left' | 'center' | 'right';

/**
 * Minimal markdown renderer for agent replies and for the idea-stage design document. Emits lit
 * templates only — every piece of source text stays a text node (no innerHTML), so model output can
 * never inject markup. That is also why this renderer grew a document mode instead of the codebase
 * gaining marked/markdown-it + a sanitizer: the safety here is structural, not a filter.
 *
 * Chat mode (no options) supports: fenced code blocks, #–### headings, unordered/ordered lists,
 * paragraphs; inline `code`, **bold**, *italic*, and [links](https://…) (http/https only).
 * Everything else renders as plain text.
 *
 * Document mode (`{ mode: 'doc' }`) adds h4–h6, `---`/`***` rules, `>` blockquotes, GFM pipe
 * tables, `- [x]` task items, `![alt](src)` images resolved through {@link
 * MarkdownLiteOptions.resolveImage}, slug `id`s on headings, and — the load-bearing part —
 * `data-md-lines="<start>-<end>"` on every block element.
 *
 * **`data-md-lines` is 0-based and inclusive on both ends**, against `source.split('\n')`. So
 * `source.split('\n').slice(start, end + 1).join('\n')` is exactly the source text the block was
 * built from, fence/separator lines included. Selection-to-`str_replace` depends on that identity:
 * the slice of the *source* is what a model can edit, whereas rendered text has lost the syntax.
 */
export function renderMarkdownLite(
  source: string,
  options?: MarkdownLiteOptions
): TemplateResult[] {
  const docMode = options?.mode === 'doc';
  const inline: InlineOptions | undefined = docMode
    ? { resolveImage: options?.resolveImage }
    : undefined;
  const blocks: TemplateResult[] = [];
  const lines = source.split('\n');
  const usedAnchors = new Set<string>();
  let paragraph: string[] = [];
  let paragraphStart = 0;
  let paragraphEnd = 0;
  let list: ListAccum | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      const content = renderInline(paragraph.join('\n'), inline);
      blocks.push(
        docMode
          ? html`<p class="md-p" data-md-lines=${lineRange(paragraphStart, paragraphEnd)}>
              ${content}
            </p>`
          : html`<p class="md-p">${content}</p>`
      );
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      const accum = list;
      const items = accum.items.map(item =>
        docMode ? renderDocListItem(item, inline) : html`<li>${renderInline(item.text)}</li>`
      );
      if (docMode) {
        const range = lineRange(accum.start, accum.end);
        blocks.push(
          accum.ordered
            ? html`<ol class="md-list" data-md-lines=${range}>
                ${items}
              </ol>`
            : html`<ul class="md-list" data-md-lines=${range}>
                ${items}
              </ul>`
        );
      } else {
        blocks.push(
          accum.ordered
            ? html`<ol class="md-list">
                ${items}
              </ol>`
            : html`<ul class="md-list">
                ${items}
              </ul>`
        );
      }
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushParagraph();
      flushList();
      const start = i;
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      // `i` sits on the closing fence, or past the end when the fence was never closed — clamp so
      // the range never points outside the source.
      const end = Math.min(i, lines.length - 1);
      const lang = fence[1] || '';
      const text = code.join('\n');
      blocks.push(
        docMode
          ? html`<pre
              class="md-code"
              data-lang=${lang}
              data-md-lines=${lineRange(start, end)}
            ><code>${text}</code></pre>`
          : html`<pre class="md-code" data-lang=${lang}><code>${text}</code></pre>`
      );
      continue;
    }

    if (docMode && line.includes('|')) {
      const table = parseTable(lines, i, inline);
      // A pipe line without an alignment row is not a table — fall through so it degrades into a
      // paragraph instead of eating the rest of the document.
      if (table) {
        flushParagraph();
        flushList();
        blocks.push(table.block);
        i = table.end;
        continue;
      }
    }

    const heading = line.match(docMode ? /^(#{1,6})\s+(.*)$/ : /^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const content = renderInline(heading[2], inline);
      if (docMode) {
        blocks.push(
          renderDocHeading(
            heading[1].length,
            content,
            uniqueAnchor(heading[2], usedAnchors),
            lineRange(i, i)
          )
        );
      } else {
        blocks.push(
          heading[1].length === 1
            ? html`<h3 class="md-h md-h1">${content}</h3>`
            : heading[1].length === 2
              ? html`<h4 class="md-h md-h2">${content}</h4>`
              : html`<h5 class="md-h md-h3">${content}</h5>`
        );
      }
      continue;
    }

    if (docMode && /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push(html`<hr class="md-hr" data-md-lines=${lineRange(i, i)} />`);
      continue;
    }

    const quote = docMode ? line.match(/^\s*>\s?(.*)$/) : null;
    if (quote) {
      flushParagraph();
      flushList();
      const start = i;
      const quoted = [quote[1]];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) {
        i++;
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
      }
      blocks.push(
        html`<blockquote class="md-quote" data-md-lines=${lineRange(start, i)}>
          ${renderInline(quoted.join('\n'), inline)}
        </blockquote>`
      );
      continue;
    }

    // An image alone on its line becomes a figure; inside a paragraph it stays inline (renderInline
    // handles that case), so both authoring styles work.
    const blockImage = docMode ? line.trim().match(/^!\[([^\]\n]*)\]\(([^\s)]+)\)$/) : null;
    if (blockImage && inline) {
      flushParagraph();
      flushList();
      const alt = blockImage[1];
      blocks.push(
        html`<figure class="md-figure" data-md-lines=${lineRange(i, i)}>
          ${renderImage(alt, blockImage[2], inline)}
          ${alt ? html`<figcaption class="md-figcaption">${alt}</figcaption>` : null}
        </figure>`
      );
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [], start: i, end: i };
      }
      list.items.push(parseListItem((bullet ?? numbered)![1], i, docMode));
      list.end = i;
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    if (paragraph.length === 0) {
      paragraphStart = i;
    }
    paragraphEnd = i;
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

/** Inline spans: `code`, **bold**, *italic*, [text](http/https url); doc mode adds `![alt](src)`. */
function renderInline(text: string, options?: InlineOptions): Array<TemplateResult | string> {
  const out: Array<TemplateResult | string> = [];
  // Built per call, never hoisted: the function recurses for bold/italic content and a shared
  // /g/ regex would carry `lastIndex` into the nested pass.
  const pattern = options
    ? /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|!\[([^\]\n]*)\]\(([^\s)]+)\)/g
    : /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      out.push(text.slice(last, match.index));
    }
    if (match[1]) {
      out.push(html`<code class="md-inline-code">${match[1].slice(1, -1)}</code>`);
    } else if (match[2]) {
      out.push(html`<strong>${renderInline(match[2].slice(2, -2), options)}</strong>`);
    } else if (match[3]) {
      out.push(html`<em>${renderInline(match[3].slice(1, -1), options)}</em>`);
    } else if (match[4] && match[5]) {
      out.push(html`<a href=${match[5]} target="_blank" rel="noreferrer">${match[4]}</a>`);
    } else if (options && match[6] !== undefined && match[7]) {
      out.push(renderImage(match[6], match[7], options));
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out;
}

/**
 * One image. Remote sources are rendered as a link and never fetched: a design document is model
 * output, and a document that loads `http(s)` images would ping third-party hosts (and leak that it
 * was opened) on every render.
 */
function renderImage(alt: string, src: string, options: InlineOptions): TemplateResult {
  if (/^https?:\/\//i.test(src)) {
    return html`<a class="md-img-link" href=${src} target="_blank" rel="noreferrer"
      >${alt || src}</a
    >`;
  }
  const resolved = options.resolveImage?.(src) ?? null;
  if (!resolved) {
    return html`<span class="md-img-missing" title=${src}>${fileNameOf(src)}</span>`;
  }
  return html`<img class="md-img" src=${resolved} alt=${alt} loading="lazy" />`;
}

function fileNameOf(src: string): string {
  const withoutQuery = src.split(/[?#]/)[0];
  const segments = withoutQuery.split('/').filter(segment => segment.length > 0);
  return segments[segments.length - 1] ?? src;
}

function lineRange(start: number, end: number): string {
  return `${start}-${end}`;
}

function parseListItem(text: string, line: number, docMode: boolean): ListItemAccum {
  const task = docMode ? text.match(/^\[([ xX])\]\s*(.*)$/) : null;
  if (task) {
    return { text: task[2], line, task: task[1] === ' ' ? 'todo' : 'done' };
  }
  return { text, line, task: null };
}

function renderDocListItem(
  item: ListItemAccum,
  options: InlineOptions | undefined
): TemplateResult {
  const range = lineRange(item.line, item.line);
  const content = renderInline(item.text, options);
  if (item.task) {
    // The check glyph is CSS (::before): a pure renderer has no access to IconService, and a task
    // list needs no interactivity here — the document is edited through the agent or the source.
    return html`<li class=${`md-task md-task--${item.task}`} data-md-lines=${range}>
      ${content}
    </li>`;
  }
  return html`<li data-md-lines=${range}>${content}</li>`;
}

/** Heading tags cannot be interpolated into a lit template, hence the switch. */
function renderDocHeading(
  level: number,
  content: Array<TemplateResult | string>,
  id: string,
  range: string
): TemplateResult {
  const cls = `md-h md-h${level}`;
  switch (level) {
    case 1:
      return html`<h1 class=${cls} id=${id} data-md-lines=${range}>${content}</h1>`;
    case 2:
      return html`<h2 class=${cls} id=${id} data-md-lines=${range}>${content}</h2>`;
    case 3:
      return html`<h3 class=${cls} id=${id} data-md-lines=${range}>${content}</h3>`;
    case 4:
      return html`<h4 class=${cls} id=${id} data-md-lines=${range}>${content}</h4>`;
    case 5:
      return html`<h5 class=${cls} id=${id} data-md-lines=${range}>${content}</h5>`;
    default:
      return html`<h6 class=${cls} id=${id} data-md-lines=${range}>${content}</h6>`;
  }
}

/**
 * Heading anchor slug: ASCII letters/digits/dashes only. No transliteration — a fully non-latin
 * heading collapses to `section`, and the dedup suffix keeps such anchors distinct.
 */
function uniqueAnchor(text: string, used: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[`*_[\]()!#>]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section';
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  used.add(candidate);
  return candidate;
}

/**
 * A GFM pipe table starting at `start`, or `null` when the line is not a table head (no alignment
 * row underneath). Returns the index of the table's last line so the caller can skip it.
 */
function parseTable(
  lines: readonly string[],
  start: number,
  options: InlineOptions | undefined
): { block: TemplateResult; end: number } | null {
  const header = splitTableRow(lines[start]);
  if (!header) {
    return null;
  }
  const separator = start + 1 < lines.length ? splitTableRow(lines[start + 1]) : null;
  if (!separator || !separator.every(cell => /^:?-+:?$/.test(cell))) {
    return null;
  }
  const alignment = separator.map(alignmentOf);
  const body: string[][] = [];
  let end = start + 1;
  for (let i = start + 2; i < lines.length; i++) {
    const row = splitTableRow(lines[i]);
    if (!row) {
      break;
    }
    // Ragged rows are padded to the header width rather than dropped: a half-typed table must stay
    // readable, and losing a cell would be worse than an empty one.
    while (row.length < header.length) {
      row.push('');
    }
    body.push(row);
    end = i;
  }
  const block = html`<table class="md-table" data-md-lines=${lineRange(start, end)}>
    <thead>
      <tr>
        ${header.map(
          (cell, index) =>
            html`<th class=${cellClass('md-th', alignment[index])}>
              ${renderInline(cell, options)}
            </th>`
        )}
      </tr>
    </thead>
    <tbody>
      ${body.map(
        row =>
          html`<tr>
            ${row.map(
              (cell, index) =>
                html`<td class=${cellClass('md-td', alignment[index])}>
                  ${renderInline(cell, options)}
                </td>`
            )}
          </tr>`
      )}
    </tbody>
  </table>`;
  return { block, end };
}

function splitTableRow(line: string | undefined): string[] | null {
  if (line === undefined || !line.includes('|')) {
    return null;
  }
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = trimmed.split('|').map(cell => cell.trim());
  return cells.length > 0 ? cells : null;
}

function alignmentOf(cell: string): CellAlignment {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) {
    return 'center';
  }
  return right ? 'right' : 'left';
}

function cellClass(base: string, alignment: CellAlignment | undefined): string {
  return alignment && alignment !== 'left' ? `${base} ${base}--${alignment}` : base;
}
