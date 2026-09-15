import { describe, expect, it } from 'vitest';
import {
  VERIFY_RIDER_MAX_DIAGNOSTICS,
  buildScriptWriteRider,
  isCompilableScriptPath,
} from './verify-rider';

describe('isCompilableScriptPath', () => {
  it('matches the files compile_scripts actually bundles', () => {
    expect(isCompilableScriptPath('scripts/Player.ts')).toBe(true);
    expect(isCompilableScriptPath('scripts/ui/Hud.ts')).toBe(true);
    expect(isCompilableScriptPath('src/scripts/Player.ts')).toBe(true);
    expect(isCompilableScriptPath('scripts/legacy.js')).toBe(true);
  });

  it('skips what the compiler skips, so the rider never claims to check it', () => {
    expect(isCompilableScriptPath('scripts/Player.spec.ts')).toBe(false);
    expect(isCompilableScriptPath('scripts/types.d.ts')).toBe(false);
    expect(isCompilableScriptPath('design/plan.md')).toBe(false);
    expect(isCompilableScriptPath('scenes/main.pix3scene')).toBe(false);
    // A .ts outside the script roots is not part of the project bundle.
    expect(isCompilableScriptPath('tools/gen.ts')).toBe(false);
  });
});

describe('buildScriptWriteRider', () => {
  const cleanCompile = {
    ok: true,
    bundled: true,
    registered: true,
    fileCount: 3,
    elapsedMs: 812,
    filesChecked: 3,
    errorCount: 0,
    warningCount: 0,
    diagnostics: [],
  };

  it('reports a clean compile and still names what it did not check', () => {
    const rider = buildScriptWriteRider(cleanCompile);

    expect(rider?.compile).toMatchObject({ ok: true, errorCount: 0, elapsedMs: 812 });
    // The whole point of the gate: a green compile must not read as a verified increment.
    expect(rider?.unverified).toHaveLength(2);
    expect(rider?.unverified.join(' ')).toMatch(/runtime/);
    expect(rider?.unverified.join(' ')).toMatch(/game_run/);
    expect(rider?.note).toMatch(/do not call it again/i);
  });

  /**
   * `{"verify": {"compile": {"ok": true` is the substring a skimming model latches onto. The prose
   * it reads next has to carry the limit itself — an `unverified` array after the fact does not
   * survive a skim, and "verified" is then the obvious reading of a block literally named verify.
   */
  it('says in PROSE that nothing ran, not only in the unverified array', () => {
    expect(buildScriptWriteRider(cleanCompile)?.note).toMatch(/nothing has RUN this code/);
  });

  /**
   * The two red branches differ in the one way that decides the agent's next move: a type error
   * leaves the previous-but-registered build live, a bundle failure does not.
   */
  it('says whether the build actually reached the running game', () => {
    expect(buildScriptWriteRider(cleanCompile)?.compile?.registered).toBe(true);

    const typeErrors = buildScriptWriteRider({ ...cleanCompile, ok: false, errorCount: 1 });
    expect(typeErrors?.compile?.registered).toBe(true);
    expect(typeErrors?.note).toMatch(/play_restart does run this code/);

    const bundleFailed = buildScriptWriteRider({ ok: false, error: 'Unexpected token' });
    expect(bundleFailed?.compile?.registered).toBe(false);
  });

  it('points at play_start too — in Studio there is no running game to restart', () => {
    expect(buildScriptWriteRider(cleanCompile)?.unverified[0]).toMatch(/play_start/);
  });

  /**
   * `compile_scripts` answers ok with a `message` for a project that has no scripts (or none that
   * extend Script). Riding that back would be an empty block that reads like a pass.
   */
  it('rides nothing when the compile had nothing to say about code', () => {
    expect(
      buildScriptWriteRider({ ok: true, fileCount: 0, message: 'No script files found.' })
    ).toBeNull();
    expect(
      buildScriptWriteRider({ ok: true, fileCount: 2, message: 'No Script subclasses found.' })
    ).toBeNull();
  });

  it('carries type errors, capped, with the count of what it dropped', () => {
    const diagnostics = Array.from({ length: 8 }, (_, index) => ({
      file: 'scripts/Player.ts',
      line: index + 1,
      column: 1,
      message: `error ${index}`,
      category: 'error',
      code: 2339,
    }));

    const rider = buildScriptWriteRider({
      ...cleanCompile,
      ok: false,
      errorCount: 8,
      diagnostics,
    });

    expect(rider?.compile?.ok).toBe(false);
    expect(rider?.compile?.errorCount).toBe(8);
    expect(rider?.compile?.diagnostics).toHaveLength(VERIFY_RIDER_MAX_DIAGNOSTICS);
    expect(rider?.compile?.moreDiagnostics).toBe(3);
  });

  it('drops warnings — a rider that reports both makes the blocking half cheap to skim', () => {
    const rider = buildScriptWriteRider({
      ...cleanCompile,
      ok: false,
      errorCount: 1,
      diagnostics: [
        { file: 'a.ts', line: 1, column: 1, message: 'unused', category: 'warning', code: 6133 },
        { file: 'a.ts', line: 2, column: 1, message: 'real', category: 'error', code: 2339 },
      ],
    });

    expect(rider?.compile?.diagnostics).toEqual([{ file: 'a.ts', line: 2, message: 'real' }]);
  });

  it('truncates one runaway message instead of flooding the result', () => {
    const rider = buildScriptWriteRider({
      ...cleanCompile,
      ok: false,
      errorCount: 1,
      diagnostics: [
        { file: 'a.ts', line: 1, column: 1, message: 'x'.repeat(4000), category: 'error', code: 1 },
      ],
    });

    const message = rider?.compile?.diagnostics?.[0].message ?? '';
    expect(message.length).toBeLessThan(400);
    expect(message.endsWith('…')).toBe(true);
  });

  it('reports a bundle failure with its location and says the game is on the old build', () => {
    const rider = buildScriptWriteRider({
      ok: false,
      elapsedMs: 120,
      error: 'Unexpected token',
      file: 'scripts/Player.ts',
      line: 12,
    });

    expect(rider?.compile).toMatchObject({
      ok: false,
      error: 'Unexpected token',
      file: 'scripts/Player.ts',
      line: 12,
    });
    expect(rider?.compile?.errorCount).toBeUndefined();
    expect(rider?.note).toMatch(/previous build/);
  });

  /**
   * The false alarm this design creates: the first file of a multi-file feature compiles against
   * imports that do not exist yet. The note must be keyed to the SYMPTOM — a missing-import
   * diagnostic's `file` names the file that exists, so "errors naming a file you have not created"
   * would describe nothing the agent can see — and it must not greet a genuine type error, which
   * would be telling the agent to postpone a real fix.
   */
  it('names the unresolved import and says so only when there is one', () => {
    const missing = buildScriptWriteRider({
      ...cleanCompile,
      ok: false,
      errorCount: 1,
      diagnostics: [
        {
          file: 'scripts/Player.ts',
          line: 2,
          column: 1,
          message: "Cannot find module './Enemy' or its corresponding type declarations.",
          category: 'error',
          code: 2307,
        },
      ],
    });
    expect(missing?.compile?.missingImports).toEqual(['./Enemy']);
    expect(missing?.note).toMatch(/write the rest before chasing/);

    // A real type error gets no "write the rest" advice — it is not waiting on another file.
    const realError = buildScriptWriteRider({
      ...cleanCompile,
      ok: false,
      errorCount: 1,
      diagnostics: [
        {
          file: 'scripts/Player.ts',
          line: 9,
          column: 5,
          message: "Cannot assign to 'position' because it is a read-only property.",
          category: 'error',
          code: 2540,
        },
      ],
    });
    expect(realError?.compile?.missingImports).toBeUndefined();
    expect(realError?.note).not.toMatch(/write the rest before chasing/);
  });

  it("reads esbuild's wording for the same thing, not just TypeScript's", () => {
    const rider = buildScriptWriteRider({
      ok: false,
      error: 'Could not resolve "./Enemy"',
      file: 'scripts/Player.ts',
      line: 2,
    });

    expect(rider?.compile?.missingImports).toEqual(['./Enemy']);
    expect(rider?.note).toMatch(/write the rest before chasing/);
  });

  it('stays small enough to ride in a tool result', () => {
    const rider = buildScriptWriteRider({
      ...cleanCompile,
      ok: false,
      errorCount: 20,
      diagnostics: Array.from({ length: 20 }, () => ({
        file: 'scripts/Player.ts',
        line: 1,
        column: 1,
        message: 'y'.repeat(1000),
        category: 'error',
        code: 1,
      })),
    });

    expect(JSON.stringify(rider).length).toBeLessThan(2500);
  });
});
