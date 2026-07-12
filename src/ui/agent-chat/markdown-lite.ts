import { html, type TemplateResult } from 'lit';

/**
 * Minimal markdown renderer for agent replies. Emits lit templates only — every piece of source
 * text stays a text node (no innerHTML), so model output can never inject markup.
 *
 * Supported: fenced code blocks, #–### headings, unordered/ordered lists, paragraphs; inline
 * `code`, **bold**, *italic*, and [links](https://…) (http/https only). Everything else renders
 * as plain text. Deliberately not a full markdown engine — extend only when a real reply breaks.
 */
export function renderMarkdownLite(source: string): TemplateResult[] {
  const blocks: TemplateResult[] = [];
  const lines = source.split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push(html`<p class="md-p">${renderInline(paragraph.join('\n'))}</p>`);
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      const items = list.items.map(item => html`<li>${renderInline(item)}</li>`);
      blocks.push(
        list.ordered
          ? html`<ol class="md-list">
              ${items}
            </ol>`
          : html`<ul class="md-list">
              ${items}
            </ul>`
      );
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      blocks.push(
        html`<pre class="md-code" data-lang=${fence[1] || ''}><code>${code.join('\n')}</code></pre>`
      );
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const content = renderInline(heading[2]);
      blocks.push(
        heading[1].length === 1
          ? html`<h3 class="md-h md-h1">${content}</h3>`
          : heading[1].length === 2
            ? html`<h4 class="md-h md-h2">${content}</h4>`
            : html`<h5 class="md-h md-h3">${content}</h5>`
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
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

/** Inline spans: `code`, **bold**, *italic*, [text](http/https url). */
function renderInline(text: string): Array<TemplateResult | string> {
  const out: Array<TemplateResult | string> = [];
  const pattern =
    /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      out.push(text.slice(last, match.index));
    }
    if (match[1]) {
      out.push(html`<code class="md-inline-code">${match[1].slice(1, -1)}</code>`);
    } else if (match[2]) {
      out.push(html`<strong>${renderInline(match[2].slice(2, -2))}</strong>`);
    } else if (match[3]) {
      out.push(html`<em>${renderInline(match[3].slice(1, -1))}</em>`);
    } else if (match[4] && match[5]) {
      out.push(html`<a href=${match[5]} target="_blank" rel="noreferrer">${match[4]}</a>`);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out;
}
