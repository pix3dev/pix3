import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { findProjectRoot } from './manifest.ts';

/**
 * `pix3 read` / `pix3 ack` — the agent's read confirmation (plan `.plans/external-agent-authoring.md`
 * §4.3, exit 2 from the protected set `P`; §5 A).
 *
 * Both append `{ path, sha256, at }` to `.pix3/ack.json` (`{ acks: [...] }`). The editor, when it
 * merges the next external version of `path`, releases the protected entries that the version with
 * that hash contained, and removes the ack (one-shot). The hash is always over the RAW BYTES — the
 * same bytes the editor hashes when it writes a file, BOM and line endings included. An ack is a
 * statement by the agent, not a proof: nothing is verified here.
 */

export const ACK_FILE = '.pix3/ack.json';

export interface AckRecord {
  readonly path: string;
  readonly sha256: string;
  readonly at: string;
}

export const sha256Bytes = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Project root for `cwd` (nearest `pix3project.yaml`), else `cwd` itself. */
export const resolveAckProjectRoot = (cwd: string, projectDir?: string): string =>
  projectDir ? resolve(cwd, projectDir) : (findProjectRoot(cwd) ?? resolve(cwd));

/**
 * `file` (relative to `cwd`, or absolute) → project path with forward slashes
 * (`scenes/main.pix3scene`). Throws when the file is outside the project or under `.pix3/`.
 */
export const toAckPath = (root: string, cwd: string, file: string): string => {
  const absolute = isAbsolute(file) ? file : resolve(cwd, file.replace(/^res:\/\//, ''));
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${file} is not inside the project ${root}`);
  }
  const projectPath = rel.split(sep).join('/');
  if (projectPath === '.pix3' || projectPath.startsWith('.pix3/')) {
    throw new Error(`${file} is editor-private (.pix3/)`);
  }
  return projectPath;
};

const readAcks = (root: string): AckRecord[] => {
  let text: string;
  try {
    text = readFileSync(join(root, ACK_FILE), 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const list =
      parsed && typeof parsed === 'object' ? (parsed as { acks?: unknown }).acks : undefined;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (item): item is AckRecord =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as AckRecord).path === 'string' &&
        typeof (item as AckRecord).sha256 === 'string'
    );
  } catch {
    return []; // a torn / foreign file is replaced rather than blocking the ack
  }
};

/** Append one ack (atomic replace: write a temp file, then rename). */
export const appendAck = (root: string, record: AckRecord): void => {
  const acks = readAcks(root).filter(a => !(a.path === record.path && a.sha256 === record.sha256));
  acks.push(record);
  const target = join(root, ACK_FILE);
  mkdirSync(join(root, '.pix3'), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ acks }, null, 2)}\n`);
  renameSync(temp, target);
};

export interface AckCommandOptions {
  readonly cwd: string;
  readonly file: string;
  readonly projectDir?: string;
  readonly now?: () => Date;
}

/** `pix3 read <path>`: the exact bytes printed, and the ack of their hash. */
export const readAndAck = (
  options: AckCommandOptions
): { bytes: Uint8Array; record: AckRecord } => {
  const root = resolveAckProjectRoot(options.cwd, options.projectDir);
  const path = toAckPath(root, options.cwd, options.file);
  const bytes = readFileSync(join(root, path));
  const record: AckRecord = {
    path,
    sha256: sha256Bytes(bytes),
    at: (options.now?.() ?? new Date()).toISOString(),
  };
  appendAck(root, record);
  return { bytes, record };
};

/** `pix3 ack <path> [--sha256 <hash>]`: without a hash, the current file's bytes (weaker). */
export const ackFile = (options: AckCommandOptions & { readonly hash?: string }): AckRecord => {
  const root = resolveAckProjectRoot(options.cwd, options.projectDir);
  const path = toAckPath(root, options.cwd, options.file);
  let hash = options.hash?.trim().toLowerCase();
  if (hash !== undefined && !/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error('--sha256 must be 64 hex characters');
  }
  hash ??= sha256Bytes(readFileSync(join(root, path)));
  const record: AckRecord = {
    path,
    sha256: hash,
    at: (options.now?.() ?? new Date()).toISOString(),
  };
  appendAck(root, record);
  return record;
};
