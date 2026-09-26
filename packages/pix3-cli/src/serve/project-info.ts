import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';

import { PROJECT_MANIFEST_FILE } from '../manifest.ts';

/** `metadata.projectName` of the manifest in `root`, else the folder name. */
export const readProjectName = (root: string): string => {
  try {
    const parsed = parse(readFileSync(join(root, PROJECT_MANIFEST_FILE), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object') {
      const metadata = (parsed as Record<string, unknown>).metadata;
      if (metadata && typeof metadata === 'object') {
        const name = (metadata as Record<string, unknown>).projectName;
        if (typeof name === 'string' && name.trim()) return name.trim();
      }
    }
  } catch {
    // no or unreadable manifest
  }
  return basename(root);
};
