import { describe, expect, it } from 'vitest';
import { extractJsonObject } from '@/services/model-gen/model-gen-json';

describe('extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('strips a ```json fence', () => {
    const text = 'Here you go:\n```json\n{ "ok": true }\n```';
    expect(extractJsonObject(text)).toEqual({ ok: true });
  });

  it('extracts the first balanced object out of surrounding prose', () => {
    const text = 'Sure! { "nested": { "deep": [1, 2] }, "name": "cog" } — hope that helps.';
    expect(extractJsonObject(text)).toEqual({ nested: { deep: [1, 2] }, name: 'cog' });
  });

  it('ignores braces inside string values', () => {
    const text = '{"note":"a } brace in a string","n":2}';
    expect(extractJsonObject(text)).toEqual({ note: 'a } brace in a string', n: 2 });
  });

  it('throws on text with no object', () => {
    expect(() => extractJsonObject('no json here')).toThrow();
  });

  it('throws on empty input', () => {
    expect(() => extractJsonObject('   ')).toThrow();
  });

  it('throws on a truncated object', () => {
    expect(() => extractJsonObject('{"a":1, "b":')).toThrow();
  });
});
