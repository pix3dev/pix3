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
});
