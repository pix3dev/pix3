/**
 * Finding and probing a CLI agent's executable.
 *
 * Adapted (Apache-2.0, with attribution) from `nexu-io/open-design`'s
 * `apps/daemon/src/runtimes/{executables,invocation,launch}.ts`. Their daemon runs 27 installed CLI
 * agents as subprocesses, so the edge cases below are theirs, learned the hard way:
 *
 *   - PATH lookup must return EVERY match, not the first: a stale shim earlier on PATH otherwise
 *     shadows the real binary, and on Windows the extension matters (`agy` vs `agy.exe`, PATHEXT).
 *   - Probes run with `cwd: os.tmpdir()`. Theirs ran `opencode models` in the working copy, which
 *     triggered a `bun install` that wiped the pnpm store. A probe must not touch a real directory.
 *   - `killSignal: 'SIGKILL'`. `execFile`'s `timeout` only SIGNALs the child; the promise still
 *     waits for `close`, so a CLI that traps SIGTERM hangs the probe forever.
 *   - The child's PATH gets Node's own directory prepended, because our MCP shim is spawned as
 *     `node <shim>` by the agent, and `npx`-based MCP servers in the user's own config want it too.
 *
 * Not taken: their codex bundle handling, AMR, and `rememberUnusableExecutable` cache.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWindows = process.platform === 'win32';

/** Extensions Windows considers executable, from PATHEXT (with a sane default). */
const pathExtensions = (): string[] => {
  if (!isWindows) return [''];
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return raw
    .split(';')
    .map(ext => ext.trim().toLowerCase())
    .filter(Boolean);
};

/**
 * True when `candidate` is a file this platform would actually run. On Windows the executable bit
 * does not exist, so the extension is the test; on POSIX it is `X_OK`.
 */
export const executableFilePath = (candidate: string): boolean => {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
  } catch {
    return false;
  }
  if (!isWindows) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const ext = path.extname(candidate).toLowerCase();
  return ext.length > 0 && pathExtensions().includes(ext);
};

/** Every match for `name` on PATH, in PATH order (Windows: each PATHEXT spelling per directory). */
export const resolveAllOnPath = (name: string): string[] => {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const suffixes = isWindows ? ['', ...pathExtensions()] : [''];
  const found: string[] = [];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${name}${suffix}`);
      if (executableFilePath(candidate) && !found.includes(candidate)) found.push(candidate);
    }
  }
  return found;
};

export interface ResolveExecutableOptions {
  /** Absolute path that wins over everything (a `*_BIN` env var or an explicit config entry). */
  readonly override?: string | undefined;
  /** Directories to search when PATH has nothing — installers that never touch PATH. */
  readonly wellKnownDirs?: readonly string[];
}

/**
 * Locate a CLI: explicit override → PATH → well-known install dirs. Returns null when the agent is
 * simply not installed, which is a normal, non-exceptional state for discovery.
 */
export const resolveExecutable = (
  name: string,
  options: ResolveExecutableOptions = {}
): string | null => {
  const override = options.override?.trim();
  if (override) {
    // An override is a deliberate operator statement: honour it even if the extension check would
    // reject it, as long as it is a real file.
    if (executableFilePath(override)) return override;
    try {
      if (fs.statSync(override).isFile()) return override;
    } catch {
      /* fall through to the normal search */
    }
  }
  const onPath = resolveAllOnPath(name);
  if (onPath.length > 0) return onPath[0];
  const suffixes = isWindows ? pathExtensions() : [''];
  for (const dir of options.wellKnownDirs ?? []) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${name}${suffix}`);
      if (executableFilePath(candidate)) return candidate;
    }
  }
  return null;
};

export interface ProbeResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** Null when the process was killed by a signal or never started. */
  readonly code: number | null;
  /** True when the probe hit its own deadline rather than exiting. */
  readonly timedOut: boolean;
}

/**
 * Run a short, side-effect-free command and capture its output.
 *
 * Deliberately hardened: a temp cwd (a probe must never run inside a project), SIGKILL on timeout
 * (SIGTERM can be trapped), and a bounded buffer so a chatty CLI cannot exhaust memory.
 */
export const probeExecutable = (
  file: string,
  args: readonly string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<ProbeResult> =>
  new Promise(resolve => {
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? 20_000;
    const child = execFile(
      file,
      [...args],
      {
        cwd: os.tmpdir(),
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        ...(options.env ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code as number)
            : error
              ? null
              : 0;
        resolve({
          ok: !error,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code,
          timedOut,
        });
      }
    );
    // `execFile`'s own timeout fires the kill but does not tell the callback why, so note it here.
    const timer = setTimeout(() => {
      timedOut = true;
    }, timeoutMs);
    timer.unref();
    child.on('close', () => clearTimeout(timer));
  });

/**
 * Environment for a spawned agent: the parent's env plus `extra`, with Node's own directory and the
 * agent's directory prepended to PATH.
 *
 * The PATH key is matched case-insensitively — on Windows `process.env` is case-insensitive but a
 * plain object literal is not, so writing `PATH` next to an inherited `Path` gives the child two
 * keys and the one it reads is anyone's guess.
 */
export const agentLaunchEnv = (
  executablePath: string,
  extra: Record<string, string> = {}
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const prepend = [path.dirname(process.execPath), path.dirname(executablePath)];
  const current = (env[pathKey] ?? '').split(path.delimiter).filter(Boolean);
  const merged = [...prepend.filter(dir => !current.includes(dir)), ...current];
  env[pathKey] = merged.join(path.delimiter);
  return env;
};
