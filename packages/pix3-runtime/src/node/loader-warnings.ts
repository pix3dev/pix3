import { ResourceNotDecodedError } from './disk-resources';

/** One `console.warn` the loader emitted, with the `Error` it carried (if any). */
export interface LoaderWarning {
  readonly message: string;
  readonly error?: unknown;
}

/**
 * Under Vite's development condition `@pix3/runtime`'s `lit/decorators.js` re-export announces
 * itself once per process through `console.warn`. Not a scene problem.
 */
const IGNORED_WARNINGS = [/^Lit is in dev mode/];

const formatArg = (arg: unknown): string =>
  arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : String(arg);

/**
 * Run `task` with `console.warn` captured and the loader's debug/info/log chatter silenced.
 *
 * The loader reports soft failures (unregistered component, missing texture, override target not
 * found) only through `console.warn`; a strict harness turns them into diagnostics. Warnings whose
 * error is a {@link ResourceNotDecodedError} are dropped — the file is there, Node just does not
 * decode it. The console is restored even when `task` throws; the throw propagates.
 */
export async function collectLoaderWarnings<T>(
  task: () => Promise<T>
): Promise<{ result: T; warnings: LoaderWarning[] }> {
  const warnings: LoaderWarning[] = [];
  const original = {
    warn: console.warn,
    debug: console.debug,
    info: console.info,
    log: console.log,
  };
  console.warn = (...args: unknown[]) => {
    const error = args.find(arg => arg instanceof Error);
    if (error instanceof ResourceNotDecodedError) return;
    const message = args.map(formatArg).join(' ');
    if (IGNORED_WARNINGS.some(pattern => pattern.test(message))) return;
    warnings.push({ message, error });
  };
  console.debug = () => {};
  console.info = () => {};
  console.log = () => {};
  try {
    const result = await task();
    return { result, warnings };
  } finally {
    console.warn = original.warn;
    console.debug = original.debug;
    console.info = original.info;
    console.log = original.log;
  }
}
