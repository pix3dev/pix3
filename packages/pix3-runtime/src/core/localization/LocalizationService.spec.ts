import { describe, expect, it, vi } from 'vitest';
import { LocalizationService } from './LocalizationService';

function makeService(): LocalizationService {
  const svc = new LocalizationService();
  svc.configure({ defaultLocale: 'en', fallbackLocale: 'en', locales: ['en', 'ru'] });
  svc.setTable({
    locale: 'en',
    strings: { 'menu.play': 'Play', 'hud.gold': 'Gold: {amount}', 'only.en': 'English only' },
    sprites: { 'btn.play': 'res://ui/en/play.png' },
  });
  svc.setTable({
    locale: 'ru',
    strings: { 'menu.play': 'Играть', 'hud.gold': 'Золото: {amount}' },
    sprites: { 'btn.play': 'res://ui/ru/play.png' },
  });
  return svc;
}

describe('LocalizationService', () => {
  it('translates keys in the current locale', () => {
    const svc = makeService();
    expect(svc.locale).toBe('en');
    expect(svc.tr('menu.play')).toBe('Play');
  });

  it('switches locale and re-resolves', async () => {
    const svc = makeService();
    await svc.setLocale('ru');
    expect(svc.locale).toBe('ru');
    expect(svc.tr('menu.play')).toBe('Играть');
  });

  it('falls back to the fallback locale, then the key itself', async () => {
    const svc = makeService();
    await svc.setLocale('ru');
    expect(svc.tr('only.en')).toBe('English only'); // ru missing → en fallback
    expect(svc.tr('does.not.exist')).toBe('does.not.exist'); // → key echoed
  });

  it('treats empty entries as untranslated (extraction placeholders fall through)', async () => {
    const svc = makeService();
    svc.setTable({
      locale: 'ru',
      strings: { 'menu.play': 'Играть', 'only.en': '' }, // "" seeded by extraction
      sprites: { 'btn.credits': '' },
    });
    await svc.setLocale('ru');
    expect(svc.tr('only.en')).toBe('English only'); // "" → en fallback, not empty
    expect(svc.has('only.en')).toBe(true); // resolvable via fallback
    expect(svc.trSprite('btn.credits')).toBeNull(); // "" sprite → authored texture
  });

  it('interpolates {token} params', () => {
    const svc = makeService();
    expect(svc.tr('hud.gold', { amount: 250 })).toBe('Gold: 250');
    expect(svc.tr('hud.gold')).toBe('Gold: {amount}'); // no params → left as-is
  });

  it('resolves localized sprite paths with fallback to null', async () => {
    const svc = makeService();
    expect(svc.trSprite('btn.play')).toBe('res://ui/en/play.png');
    await svc.setLocale('ru');
    expect(svc.trSprite('btn.play')).toBe('res://ui/ru/play.png');
    expect(svc.trSprite('missing.sprite')).toBeNull();
  });

  it('reports key presence via the fallback chain', () => {
    const svc = makeService();
    expect(svc.has('menu.play')).toBe(true);
    expect(svc.has('nope')).toBe(false);
  });

  it('notifies listeners on setLocale and setTable', async () => {
    const svc = makeService();
    const listener = vi.fn();
    const off = svc.onChange(listener);
    await svc.setLocale('ru');
    svc.setTable({ locale: 'ru', strings: { 'menu.play': 'Играть!' }, sprites: {} });
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    await svc.setLocale('en');
    expect(listener).toHaveBeenCalledTimes(2); // unsubscribed
  });

  it('returns the key when no tables are loaded', () => {
    const svc = new LocalizationService();
    expect(svc.tr('anything')).toBe('anything');
    expect(svc.tr('')).toBe('');
  });

  it('selects plural suffix keys via Intl.PluralRules', async () => {
    const svc = makeService();
    svc.setTable({
      locale: 'en',
      strings: {
        'lives.one': '{count} LIFE LEFT',
        'lives.other': '{count} LIVES LEFT',
      },
      sprites: {},
    });
    expect(svc.trPlural('lives', 1)).toBe('1 LIFE LEFT');
    expect(svc.trPlural('lives', 3)).toBe('3 LIVES LEFT');

    // Russian: one/few/many categories; missing categories fall to .other.
    svc.setTable({
      locale: 'ru',
      strings: {
        'lives.one': 'ОСТАЛАСЬ {count} ЖИЗНЬ',
        'lives.few': 'ОСТАЛОСЬ {count} ЖИЗНИ',
        'lives.many': 'ОСТАЛОСЬ {count} ЖИЗНЕЙ',
      },
      sprites: {},
    });
    await svc.setLocale('ru');
    expect(svc.trPlural('lives', 1)).toBe('ОСТАЛАСЬ 1 ЖИЗНЬ');
    expect(svc.trPlural('lives', 3)).toBe('ОСТАЛОСЬ 3 ЖИЗНИ');
    expect(svc.trPlural('lives', 5)).toBe('ОСТАЛОСЬ 5 ЖИЗНЕЙ');
  });

  it('trPlural falls back to .other, then the bare key', () => {
    const svc = makeService();
    svc.setTable({
      locale: 'en',
      strings: { 'waves.other': '{count} waves', bare: '{count} things' },
      sprites: {},
    });
    expect(svc.trPlural('waves', 1)).toBe('1 waves'); // no .one → .other
    expect(svc.trPlural('bare', 2)).toBe('2 things'); // no suffixes → bare key
    expect(svc.trPlural('nope', 2)).toBe('nope'); // nothing → key echoed
  });
});
