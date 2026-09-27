import { describe, expect, it } from 'vitest';

import { keyForCode } from './key-for-code';

describe('keyForCode', () => {
  it('maps letters, digits and Space as before', () => {
    expect(keyForCode('KeyW')).toBe('w');
    expect(keyForCode('Digit7')).toBe('7');
    expect(keyForCode('Space')).toBe(' ');
  });

  it('maps US-layout punctuation to the printed character', () => {
    expect(keyForCode('Minus')).toBe('-');
    expect(keyForCode('Equal')).toBe('=');
    expect(keyForCode('BracketLeft')).toBe('[');
    expect(keyForCode('BracketRight')).toBe(']');
    expect(keyForCode('Backslash')).toBe('\\');
    expect(keyForCode('Semicolon')).toBe(';');
    expect(keyForCode('Quote')).toBe("'");
    expect(keyForCode('Comma')).toBe(',');
    expect(keyForCode('Period')).toBe('.');
    expect(keyForCode('Slash')).toBe('/');
    expect(keyForCode('Backquote')).toBe('`');
  });

  it('maps the numpad: digits as themselves, operators as characters, Enter by name', () => {
    expect(keyForCode('Numpad0')).toBe('0');
    expect(keyForCode('Numpad9')).toBe('9');
    expect(keyForCode('NumpadAdd')).toBe('+');
    expect(keyForCode('NumpadSubtract')).toBe('-');
    expect(keyForCode('NumpadMultiply')).toBe('*');
    expect(keyForCode('NumpadDivide')).toBe('/');
    expect(keyForCode('NumpadDecimal')).toBe('.');
    expect(keyForCode('NumpadEnter')).toBe('Enter');
  });

  it('keeps named keys as their own name, arrows and modifiers included', () => {
    expect(keyForCode('Enter')).toBe('Enter');
    expect(keyForCode('Escape')).toBe('Escape');
    expect(keyForCode('Tab')).toBe('Tab');
    expect(keyForCode('Backspace')).toBe('Backspace');
    expect(keyForCode('ArrowLeft')).toBe('ArrowLeft');
    expect(keyForCode('ArrowUp')).toBe('ArrowUp');
    expect(keyForCode('ShiftLeft')).toBe('Shift');
    expect(keyForCode('F5')).toBe('F5');
  });

  it('falls back to the code itself for anything unknown', () => {
    expect(keyForCode('Lang1')).toBe('Lang1');
  });
});
