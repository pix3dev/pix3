import { runValidate, type ValidateIo } from './command.ts';

/**
 * Entry of the esbuild bundle (`bundle.ts`). Its siblings `runtime.js` and `three.js` are what
 * compiled project scripts import at level 2, by file URL — the bundle shares one runtime chunk
 * between the validator and those entries, so `instanceof Script` holds across the seam.
 */
export const runBundledValidate = (
  argv: readonly string[],
  io: Omit<ValidateIo, 'scriptImports'>
): Promise<number> =>
  runValidate(argv, {
    ...io,
    scriptImports: {
      runtime: new URL('./runtime.js', import.meta.url).href,
      three: new URL('./three.js', import.meta.url).href,
    },
  });
