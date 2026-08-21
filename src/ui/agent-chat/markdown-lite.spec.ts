import { describe, expect, it } from 'vitest';
import { render } from 'lit';
import { renderMarkdownLite } from './markdown-lite';

const toHtml = (source: string): string => {
  const host = document.createElement('div');
  render(renderMarkdownLite(source), host);
  // Strip lit's template part markers so assertions can match contiguous markup.
  return host.innerHTML.replace(/<!--[\s\S]*?-->/g, '');
};

describe('renderMarkdownLite', () => {
  it('renders paragraphs, bold, italic, and inline code', () => {
    const markup = toHtml('Set **position.x** to *5* via `set_property`.');
    expect(markup).toContain('<strong>position.x</strong>');
    expect(markup).toContain('<em>5</em>');
    expect(markup).toContain('<code class="md-inline-code">set_property</code>');
  });

  it('renders fenced code blocks verbatim', () => {
    const markup = toHtml('before\n```ts\nconst a = 1 < 2;\n```\nafter');
    expect(markup).toContain('data-lang="ts"');
    // The comparison operator must be escaped text, not markup.
    expect(markup).toContain('1 &lt; 2');
  });

  it('renders lists and headings', () => {
    const markup = toHtml('## Steps\n- one\n- two\n1. first\n2. second');
    expect(markup).toContain('<h4 class="md-h md-h2">Steps</h4>');
    expect(markup).toMatch(/<ul class="md-list">.*<li>one<\/li>.*<li>two<\/li>.*<\/ul>/s);
    expect(markup).toMatch(/<ol class="md-list">.*<li>first<\/li>.*<\/ol>/s);
  });

  it('linkifies only http(s) URLs and never injects raw markup', () => {
    const markup = toHtml('[docs](https://example.com) and <img src=x onerror=alert(1)>');
    expect(markup).toContain('href="https://example.com"');
    expect(markup).toContain('rel="noreferrer"');
    // The HTML-looking text must be escaped, not parsed.
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<img src=x');
  });

  it('ignores javascript: links (regex only matches http/https)', () => {
    const markup = toHtml('[bad](javascript:alert(1))');
    expect(markup).not.toContain('href="javascript:');
    expect(markup).toContain('[bad](javascript:alert(1))');
  });
});

const renderDoc = (source: string, resolveImage?: (src: string) => string | null): HTMLElement => {
  const host = document.createElement('div');
  render(renderMarkdownLite(source, { mode: 'doc', resolveImage }), host);
  return host;
};

const docHtml = (source: string, resolveImage?: (src: string) => string | null): string =>
  renderDoc(source, resolveImage).innerHTML.replace(/<!--[\s\S]*?-->/g, '');

/** The source text a rendered block claims to come from, per its `data-md-lines` range. */
const blockSource = (host: HTMLElement, selector: string, source: string): string => {
  const element = host.querySelector(selector);
  expect(element, `no element for ${selector}`).toBeTruthy();
  const [start, end] = (element!.getAttribute('data-md-lines') ?? '').split('-').map(Number);
  return source
    .split('\n')
    .slice(start, end + 1)
    .join('\n');
};

describe('renderMarkdownLite doc mode', () => {
  it('leaves the chat path untouched', () => {
    // Doc-only grammar must stay inert in chat mode, and chat markup must carry no line anchors.
    const source = '#### deep\n---\n> quoted\n| a | b |\n| --- | --- |\n| 1 | 2 |\n- [x] done';
    const markup = toHtml(source);
    expect(markup).not.toContain('data-md-lines');
    expect(markup).not.toContain('<h6');
    expect(markup).not.toContain('<hr');
    expect(markup).not.toContain('<blockquote');
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('md-task');
    // `- [x] done` is an ordinary bullet in chat mode, brackets and all.
    expect(markup).toContain('<li>[x] done</li>');
  });

  it('renders h1–h6 with slug anchors and dedupes repeats', () => {
    const markup = docHtml('# Core Loop\n#### Deep Note\n###### Deepest\n# Core Loop');
    expect(markup).toContain('<h1 class="md-h md-h1" id="core-loop"');
    expect(markup).toContain('<h4 class="md-h md-h4" id="deep-note"');
    expect(markup).toContain('<h6 class="md-h md-h6" id="deepest"');
    expect(markup).toContain('id="core-loop-2"');
  });

  it('slugs a fully non-latin heading to a stable fallback', () => {
    const markup = docHtml('# Концепция\n# Механики');
    expect(markup).toContain('id="section"');
    expect(markup).toContain('id="section-2"');
  });

  it('renders horizontal rules for --- and ***', () => {
    const markup = docHtml('one\n\n---\n\ntwo\n\n***\n');
    expect(markup.match(/<hr class="md-hr"/g)).toHaveLength(2);
  });

  it('renders a multi-line blockquote with inline spans', () => {
    const source = '> **Pitch:** ants\n> versus termites';
    const markup = docHtml(source);
    expect(markup).toContain('<blockquote class="md-quote"');
    expect(markup).toContain('<strong>Pitch:</strong>');
    expect(markup).toContain('versus termites');
    expect(blockSource(renderDoc(source), 'blockquote', source)).toBe(source);
  });

  it('renders a GFM table with alignment classes from the separator', () => {
    const markup = docHtml('| Name | Qty | Cost |\n| --- | :-: | ---: |\n| Ant | 3 | `5` |');
    expect(markup).toContain('<table class="md-table"');
    expect(markup).toContain('<th class="md-th">');
    expect(markup).toContain('md-th--center');
    expect(markup).toContain('md-th--right');
    expect(markup).toContain('md-td--center');
    expect(markup).toContain('<code class="md-inline-code">5</code>');
  });

  it('degrades a table with no separator row into a paragraph', () => {
    const markup = docHtml('| a | b |\nplain text');
    expect(markup).not.toContain('<table');
    expect(markup).toContain('| a | b |');
  });

  it('pads a ragged table row instead of dropping cells', () => {
    const host = renderDoc('| a | b | c |\n| --- | --- | --- |\n| 1 |');
    const cells = host.querySelectorAll('tbody td');
    expect(cells).toHaveLength(3);
    expect(cells[0].textContent?.trim()).toBe('1');
    expect(cells[2].textContent?.trim()).toBe('');
  });

  it('renders task list items with done/todo classes', () => {
    const markup = docHtml('- [x] shipped\n- [ ] pending');
    expect(markup).toContain('class="md-task md-task--done"');
    expect(markup).toContain('class="md-task md-task--todo"');
    // The checkbox syntax itself is consumed, not shown as text.
    expect(markup).not.toContain('[x]');
  });

  it('resolves project images through resolveImage and falls back to a plaque', () => {
    const resolve = (src: string): string | null =>
      src === 'res://references/hero.png' ? 'blob:hero' : null;
    const markup = docHtml(
      '![Hero](res://references/hero.png)\n\n![Gone](res://references/gone.png)',
      resolve
    );
    expect(markup).toContain('<img class="md-img"');
    expect(markup).toContain('src="blob:hero"');
    expect(markup).toContain('alt="Hero"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('<figcaption class="md-figcaption">Hero</figcaption>');
    expect(markup).toContain('<span class="md-img-missing" title="res://references/gone.png">');
    expect(markup).toContain('gone.png');
  });

  it('renders an inline image inside a paragraph', () => {
    const markup = docHtml('The hero ![hero](res://a.png) stands.', () => 'blob:a');
    const paragraph = renderDoc(
      'The hero ![hero](res://a.png) stands.',
      () => 'blob:a'
    ).querySelector('p.md-p');
    expect(paragraph?.querySelector('img.md-img')).toBeTruthy();
    expect(markup).toContain('stands.');
  });

  it('never loads a remote image — it becomes a link', () => {
    const markup = docHtml(
      '![shot](https://evil.example/track.png)',
      () => 'blob:should-not-be-used'
    );
    expect(markup).not.toContain('<img');
    expect(markup).toContain('<a class="md-img-link"');
    expect(markup).toContain('href="https://evil.example/track.png"');
    expect(markup).toContain('rel="noreferrer"');
  });

  it('keeps raw HTML in the source as text', () => {
    const markup = docHtml('<script>alert(1)</script>\n\n| <b>x</b> |\n| --- |\n| <i>y</i> |');
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('<b>x</b>');
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('anchors every block to the exact source lines it was built from', () => {
    const source = [
      '# Title', // 0
      '', // 1
      'A paragraph that', // 2
      'wraps two lines.', // 3
      '', // 4
      '- one', // 5
      '- two', // 6
      '', // 7
      '| a | b |', // 8
      '| --- | --- |', // 9
      '| 1 | 2 |', // 10
      '', // 11
      '```ts', // 12
      'const x = 1;', // 13
      '```', // 14
    ].join('\n');
    const host = renderDoc(source);

    expect(blockSource(host, 'h1', source)).toBe('# Title');
    expect(blockSource(host, 'p.md-p', source)).toBe('A paragraph that\nwraps two lines.');
    expect(blockSource(host, 'ul.md-list', source)).toBe('- one\n- two');
    expect(blockSource(host, 'ul.md-list li', source)).toBe('- one');
    expect(blockSource(host, 'table.md-table', source)).toBe(
      ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    );
    expect(blockSource(host, 'pre.md-code', source)).toBe(
      ['```ts', 'const x = 1;', '```'].join('\n')
    );
  });

  it('anchors an unterminated code fence inside the source', () => {
    const source = '```ts\nconst a = 1;';
    expect(blockSource(renderDoc(source), 'pre.md-code', source)).toBe(source);
  });
});
