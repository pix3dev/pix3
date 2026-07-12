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
