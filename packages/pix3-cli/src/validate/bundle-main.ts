import { runValidate, type ValidateIo } from './command.ts';
import { validateProject, type ValidateOptions, type ValidateReport } from './validate.ts';

/**
 * Entry of the esbuild bundle (`bundle.ts`). Its siblings `runtime.js` and `three.js` are what
 * compiled project scripts import at level 2, by file URL — the bundle shares one runtime chunk
 * between the validator and those entries, so `instanceof Script` holds across the seam.
 */

const bundledScriptImports = () => ({
  runtime: new URL('./runtime.js', import.meta.url).href,
  three: new URL('./three.js', import.meta.url).href,
});

export const runBundledValidate = (
  argv: readonly string[],
  io: Omit<ValidateIo, 'scriptImports'>
): Promise<number> => runValidate(argv, { ...io, scriptImports: bundledScriptImports() });

/** `pix3 check`'s way in: the report itself, not its printed form. */
export const validateBundledProject = (
  options: Omit<ValidateOptions, 'scriptImports'>
): Promise<ValidateReport> =>
  validateProject({ ...options, scriptImports: bundledScriptImports() });
