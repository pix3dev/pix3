import type { FileDescriptor } from '@/services/FileSystemAPIService';
import {
  ASSET_CATEGORIES,
  ASSET_CATEGORY_BY_ID,
  categorizeAssetPath,
  groupedCategoryExpansionKey,
  groupedDirectoryExpansionKey,
  type AssetCategoryId,
} from '@/core/asset-categories';

export type AssetTreeNodeType = 'category' | 'dir' | 'file';

export type AssetTreeNode = {
  /** Display label; compacted grouped dirs use a chain label like `assets/sprites/ui`. */
  name: string;
  /** Real FS path; category nodes carry a virtual `category:<id>` path. */
  path: string;
  kind: FileSystemHandleKind;
  sizeBytes: number | null;
  children?: AssetTreeNode[] | null; // null = not loaded yet, [] = loaded and empty
  expanded?: boolean;
  editing?: boolean;
  /**
   * Folder-mode directories only: whether the directory contains at least one
   * subdirectory. Drives whether the expand triangle is shown (folders with no
   * subfolders aren't expandable in the folders-only tree). Undefined in grouped
   * mode, where expandability is derived from `children`.
   */
  hasChildDirectories?: boolean;
  /** Set on every grouped-view node; undefined in folder mode. */
  nodeType?: AssetTreeNodeType;
  categoryId?: AssetCategoryId;
  /** Total matching files in the category (category nodes only). */
  fileCount?: number;
  /**
   * Folder path shown in parentheses on a category row whose content was lifted
   * out of a lone top-level folder (VS Code single-folder compaction, e.g.
   * `Images (textures)`). Set only when the category collapsed exactly one root
   * folder into itself; undefined otherwise.
   */
  folderLabel?: string;
  /**
   * Real FS path of the folder a category row was lifted from (the sibling of
   * `folderLabel`). Set only when the category maps to exactly one project
   * folder, so clicking the row can open that folder in the asset preview.
   */
  folderPath?: string;
};

export const CATEGORY_PATH_PREFIX = 'category:';

export const isCategoryPath = (path: string | null | undefined): boolean =>
  !!path && path.startsWith(CATEGORY_PATH_PREFIX);

export const categoryPathFor = (categoryId: AssetCategoryId): string =>
  `${CATEGORY_PATH_PREFIX}${categoryId}`;

export const categoryIdFromPath = (path: string | null | undefined): AssetCategoryId | null => {
  if (!path || !path.startsWith(CATEGORY_PATH_PREFIX)) {
    return null;
  }
  const categoryId = path.slice(CATEGORY_PATH_PREFIX.length) as AssetCategoryId;
  return categoryId in ASSET_CATEGORY_BY_ID ? categoryId : null;
};

export interface BuildGroupedTreeOptions {
  /** Expansion keys produced by `collectGroupedExpandedKeys` on a previous tree. */
  expandedKeys: ReadonlySet<string>;
  /** Expand all category rows (first use of the grouped view, nothing persisted yet). */
  defaultCategoryExpanded: boolean;
  /**
   * Emit file leaf nodes (default true). When false the folders-only Assets tree
   * keeps files in the trie — so chain compaction, dir `sizeBytes`, and category
   * `fileCount` are unchanged — but omits the file leaf nodes from the output.
   */
  includeFiles?: boolean;
}

const normalizeAssetPath = (path: string): string =>
  path.replace(/\\+/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');

interface TrieDir {
  label: string;
  /** Real normalized path; '' for the category root. */
  path: string;
  dirs: Map<string, TrieDir>;
  files: FileDescriptor[];
}

const createTrieDir = (label: string, path: string): TrieDir => ({
  label,
  path,
  dirs: new Map(),
  files: [],
});

const sumTrieSizes = (dir: TrieDir): number => {
  let total = 0;
  for (const file of dir.files) {
    total += file.size ?? 0;
  }
  for (const child of dir.dirs.values()) {
    total += sumTrieSizes(child);
  }
  return total;
};

/**
 * Builds the "group by type" tree from a flat list of project files.
 * Categories without files are omitted; folder chains without branching are
 * compacted VS Code-style into a single node labeled with the joined path.
 */
export function buildGroupedTree(
  files: readonly FileDescriptor[],
  options: BuildGroupedTreeOptions
): AssetTreeNode[] {
  const filesByCategory = new Map<AssetCategoryId, FileDescriptor[]>();
  for (const file of files) {
    const categoryId = categorizeAssetPath(file.path);
    const bucket = filesByCategory.get(categoryId);
    if (bucket) {
      bucket.push(file);
    } else {
      filesByCategory.set(categoryId, [file]);
    }
  }

  const includeFiles = options.includeFiles ?? true;
  const tree: AssetTreeNode[] = [];
  for (const definition of ASSET_CATEGORIES) {
    const categoryFiles = filesByCategory.get(definition.id);
    if (!categoryFiles || categoryFiles.length === 0) {
      continue;
    }

    const root = createTrieDir('', '');
    for (const file of categoryFiles) {
      const segments = normalizeAssetPath(file.path).split('/');
      let current = root;
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i];
        let child = current.dirs.get(segment);
        if (!child) {
          child = createTrieDir(segment, current.path ? `${current.path}/${segment}` : segment);
          current.dirs.set(segment, child);
        }
        current = child;
      }
      current.files.push(file);
    }

    let children = trieToNodes(root, definition.id, options.expandedKeys, includeFiles);
    let folderLabel: string | undefined;
    let folderPath: string | undefined;
    // VS Code-style single-folder compaction: when a category holds exactly one
    // top-level folder and no loose files, drop that redundant intermediate level
    // and lift its content straight into the category row, surfacing the folder's
    // (already chain-compacted) path in parentheses on the category label.
    // The loose-file check reads the trie (`root.files`), not `children`, so the
    // decision is identical whether or not file leaf nodes are emitted
    // (`includeFiles: false` in the folders-only tree).
    if (
      root.files.length === 0 &&
      root.dirs.size === 1 &&
      children.length === 1 &&
      children[0].nodeType === 'dir'
    ) {
      const [lone] = children;
      folderLabel = lone.name;
      folderPath = lone.path;
      children = lone.children ?? [];
    }

    tree.push({
      name: definition.label,
      path: categoryPathFor(definition.id),
      kind: 'directory',
      nodeType: 'category',
      categoryId: definition.id,
      fileCount: categoryFiles.length,
      folderLabel,
      folderPath,
      sizeBytes: null,
      expanded:
        options.expandedKeys.has(groupedCategoryExpansionKey(definition.id)) ||
        options.defaultCategoryExpanded,
      children,
    });
  }

  return tree;
}

function trieToNodes(
  dir: TrieDir,
  categoryId: AssetCategoryId,
  expandedKeys: ReadonlySet<string>,
  includeFiles: boolean
): AssetTreeNode[] {
  const dirNodes = Array.from(dir.dirs.values(), child =>
    compactedDirNode(child, categoryId, expandedKeys, includeFiles)
  );
  dirNodes.sort((a, b) => a.name.localeCompare(b.name));

  if (!includeFiles) {
    return dirNodes;
  }

  const fileNodes = dir.files.map<AssetTreeNode>(file => ({
    name: file.name,
    path: file.path,
    kind: 'file',
    nodeType: 'file',
    categoryId,
    sizeBytes: file.size ?? null,
    children: [],
  }));

  fileNodes.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirNodes, ...fileNodes];
}

function compactedDirNode(
  dir: TrieDir,
  categoryId: AssetCategoryId,
  expandedKeys: ReadonlySet<string>,
  includeFiles: boolean
): AssetTreeNode {
  let current = dir;
  let label = dir.label;
  while (current.files.length === 0 && current.dirs.size === 1) {
    const only = current.dirs.values().next().value as TrieDir;
    label = `${label}/${only.label}`;
    current = only;
  }

  return {
    name: label,
    path: current.path,
    kind: 'directory',
    nodeType: 'dir',
    categoryId,
    sizeBytes: sumTrieSizes(current),
    expanded: expandedKeys.has(groupedDirectoryExpansionKey(categoryId, current.path)),
    children: trieToNodes(current, categoryId, expandedKeys, includeFiles),
  };
}

/** Collects expansion keys of expanded grouped-view rows (categories and dirs). */
export function collectGroupedExpandedKeys(
  nodes: readonly AssetTreeNode[],
  into: Set<string>
): void {
  for (const node of nodes) {
    if (node.kind === 'directory' && node.expanded) {
      if (node.nodeType === 'category' && node.categoryId) {
        into.add(groupedCategoryExpansionKey(node.categoryId));
      } else if (node.nodeType === 'dir' && node.categoryId) {
        into.add(groupedDirectoryExpansionKey(node.categoryId, normalizeAssetPath(node.path)));
      }
    }
    if (node.children && node.children.length > 0) {
      collectGroupedExpandedKeys(node.children, into);
    }
  }
}
