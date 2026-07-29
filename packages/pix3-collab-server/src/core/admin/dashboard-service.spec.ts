// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { roomsVersionNote } from './dashboard-service.js';

/**
 * The rooms row's note, which carries the one thing its status badge cannot.
 *
 * The badge answers "is this build from HEAD?" — a commit question. Platform-version alignment is a
 * different question with a different failure mode: pix3 gets bumped, the sibling repository's
 * `Directory.Build.props` does not, and every commit-based check keeps saying "current" while the
 * three components no longer claim the same release. That case is exactly what this note exists for,
 * so it is worth pinning.
 */
describe('roomsVersionNote', () => {
  const stats = { version: '1.2.0', commit: 'e734ce024f89' };

  it('confirms the shared platform version when everything lines up', () => {
    expect(roomsVersionNote(stats, 'e734ce024f89', '1.2.0', '1.2.0')).toEqual({
      note: 'общая версия платформы, как у cloud и клиента; решает коммит',
      noteSeverity: 'info',
    });
  });

  it('warns when the fabric reports a different platform version than cloud', () => {
    const result = roomsVersionNote(stats, 'e734ce024f89', '1.1.0', '1.2.0');

    expect(result.noteSeverity).toBe('warn');
    expect(result.note).toContain('1.2.0');
    expect(result.note).toContain('Directory.Build.props');
  });

  it('reports the missing fabric before anything else', () => {
    // Nothing was read, so "versions disagree" would be a claim about data that does not exist.
    expect(roomsVersionNote(null, null, null, '1.2.0')).toEqual({
      note: 'фабрика не ответила — версия и коммит неизвестны',
      noteSeverity: 'warn',
    });
  });

  it('reports a build with no provenance before comparing versions', () => {
    const result = roomsVersionNote({ version: '1.1.0' }, null, '1.1.0', '1.2.0');

    expect(result.noteSeverity).toBe('warn');
    expect(result.note).toContain('коммит неизвестен');
  });
});
