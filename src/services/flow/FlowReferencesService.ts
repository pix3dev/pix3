import { injectable, inject } from '@/fw/di';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import type { FileDescriptor } from '@/services/project/FileSystemAPIService';
import {
  guessAttachmentRole,
  sanitizeFileName,
  type AttachmentRole,
} from '@/ui/shared/composer-attachments';

/** The design document, pinned to the top of the list and never deletable from it (design §3.6). */
export const IDEA_DOC_PATH = 'design/gdd.md';

/** Where every design document lives. Its `source/` subfolder is the separate Sources group. */
export const DESIGN_DIR = 'design';

/** Everything the user drops, uploads or the agent generates at the idea stage. */
export const REFERENCES_DIR = 'references';

/** Documents attached to the first prompt. Read-only here: their path is owned by prompt intake. */
export const SOURCES_DIR = 'design/source';

/**
 * Metadata sidecar for {@link REFERENCES_DIR} — role, origin and caption per file.
 *
 * Declared in this module rather than in `PrototypeBootstrapService` (which re-exports it) for the
 * same reason `IDEA_TEMPLATE_ID` lives in `FlowStageService`: the agent tool registry writes this
 * index too, and importing the bootstrap service from there would close a cycle through
 * `AgentChatService`.
 */
export const FLOW_REFERENCES_INDEX_PATH = `${REFERENCES_DIR}/index.json`;

/**
 * What a reference is FOR. The three intake roles plus `style-candidate`, which a moodboard turn
 * writes (skill `idea-stage` §5) and which the "make this the style" action of V6 consumes.
 */
export type FlowReferenceRole = AttachmentRole | 'style-candidate';

/** Who put the file in the project. Decides whether "regenerate" is offered on the card. */
export type FlowReferenceOrigin = 'user' | 'agent';

/**
 * How the file is shown. Deliberately about *presentation*, not about MIME: the column is a list of
 * arbitrary files (design §3.6), and everything that is neither a picture nor readable text gets an
 * honest icon rather than a broken preview.
 */
export type FlowReferenceKind = 'image' | 'markdown' | 'text' | 'other';

/** Which section of the list an item belongs to. */
export type FlowReferenceGroup = 'document' | 'design' | 'references' | 'sources';

/** One entry of `references/index.json`. Every field except the file name itself is optional. */
export interface FlowReferenceIndexEntry {
  readonly role?: FlowReferenceRole;
  readonly caption?: string;
  readonly origin?: FlowReferenceOrigin;
  readonly prompt?: string;
}

export type FlowReferenceIndex = Readonly<Record<string, FlowReferenceIndexEntry>>;

export interface FlowReferenceItem {
  /** Project-relative path, e.g. `references/mood-1.png`. */
  readonly path: string;
  readonly name: string;
  readonly group: FlowReferenceGroup;
  readonly kind: FlowReferenceKind;
  readonly origin: FlowReferenceOrigin;
  /** Only pictures have a role; `null` on everything else, and the chip is not drawn. */
  readonly role: FlowReferenceRole | null;
  /** Index caption (the generation prompt, usually) — preferred over {@link previewLine}. */
  readonly caption: string | null;
  /** First non-empty line of a text/markdown file, so a document card says something. */
  readonly previewLine: string | null;
  readonly sizeBytes: number | null;
  readonly modifiedAt: number | null;
  /** True for `design/source/**`: this panel never writes there, so it never deletes there either. */
  readonly readOnly: boolean;
  /** True for the pinned design document. */
  readonly pinned: boolean;
  /** The pinned document before the agent has written it — listed, but nothing to open. */
  readonly missing: boolean;
}

export interface FlowReferenceList {
  /** Always present, even when the file is not: the document is the list's anchor. */
  readonly document: FlowReferenceItem;
  /** The other documents the agent keeps in `design/` — plan, decisions, style, progress… */
  readonly design: readonly FlowReferenceItem[];
  readonly references: readonly FlowReferenceItem[];
  readonly sources: readonly FlowReferenceItem[];
}

export interface FlowReferenceAddResult {
  /** Project-relative paths actually written. */
  readonly added: readonly string[];
  /** Why some files were skipped — shown inline in the panel, never as a modal. */
  readonly warnings: readonly string[];
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'bmp']);
const TEXT_EXTENSIONS = new Set(['txt', 'csv', 'json', 'yaml', 'yml']);

/**
 * Biggest file the column will take in. Not a token budget (nothing here is inlined into a
 * request) — it is the read into memory: a dropped 400 MB video is buffered whole to be written
 * back out, and the tab would die before the file landed.
 */
export const MAX_REFERENCE_BYTES = 64 * 1024 * 1024;

/** Text files above this are listed without a preview line: the caption is not worth the read. */
const MAX_PREVIEW_BYTES = 256 * 1024;

/** How the panel shows a file, from its extension alone. */
export const classifyReferenceKind = (name: string): FlowReferenceKind => {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (IMAGE_EXTENSIONS.has(ext)) {
    return 'image';
  }
  if (ext === 'md' || ext === 'markdown') {
    return 'markdown';
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    return 'text';
  }
  return 'other';
};

/**
 * The idea stage's file list: the `design/` documents (`gdd.md` pinned on top, then whatever else
 * the agent has written there), everything in `references/**`, and the read-only documents the
 * first prompt left in `design/source/**` (design §3.6).
 *
 * Three properties carry the feature:
 *  - **The directory listing is the truth, `references/index.json` is a convenience.** A file with
 *    no index entry is a normal file — it degrades to its own name, `origin: 'user'` and a guessed
 *    role. Nothing here throws over a missing or malformed index: the user's own dropped files
 *    arrive that way by definition, and an empty column would be a lie about their project.
 *  - **The index is written read-merge-write, never rebuilt.** The panel, prompt intake and
 *    `generate_asset` all write it; whoever writes last must not drop the other two's keys.
 *  - **Files go in as they are.** Unlike prompt intake, which splits images into `references/` and
 *    documents into `design/source/`, a file dropped *into the references column* is written to
 *    `references/` whatever its type — that is the folder the user aimed at.
 */
@injectable()
export class FlowReferencesService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  /** The whole list, ready to render: groups resolved, metadata merged, newest first. */
  async list(): Promise<FlowReferenceList> {
    const index = await this.readIndex();
    const [document, design, references, sources] = await Promise.all([
      this.describeDocument(),
      this.describeDesignDocs(),
      this.describeGroup(REFERENCES_DIR, 'references', index, false),
      this.describeGroup(SOURCES_DIR, 'sources', index, true),
    ]);
    return { document, design, references, sources };
  }

  /** `references/index.json`, or an empty index when it is absent or unreadable. */
  async readIndex(): Promise<FlowReferenceIndex> {
    let raw: string;
    try {
      raw = await this.storage.readTextFile(FLOW_REFERENCES_INDEX_PATH);
    } catch {
      return {};
    }
    return parseReferencesIndex(raw);
  }

  async readIndexEntry(fileName: string): Promise<FlowReferenceIndexEntry | null> {
    const index = await this.readIndex();
    return index[fileName] ?? null;
  }

  /** Merge one entry into the index, keeping every other key. */
  async upsert(fileName: string, entry: FlowReferenceIndexEntry): Promise<void> {
    const index = await this.readIndex();
    const merged: Record<string, FlowReferenceIndexEntry> = { ...index };
    merged[fileName] = { ...index[fileName], ...entry };
    await this.writeIndex(merged);
  }

  /** Drop one entry. Used by the delete operation, whose undo puts it back with {@link upsert}. */
  async removeEntry(fileName: string): Promise<void> {
    const index = await this.readIndex();
    if (!(fileName in index)) {
      return;
    }
    const merged: Record<string, FlowReferenceIndexEntry> = { ...index };
    delete merged[fileName];
    await this.writeIndex(merged);
  }

  async setRole(fileName: string, role: FlowReferenceRole): Promise<void> {
    await this.upsert(fileName, { role });
  }

  /**
   * Write dropped/picked files into `references/`, never overwriting: a name that is taken gets a
   * `-2`, `-3` suffix. Silent overwrite is the one behaviour a drop zone must not have — the file
   * it would eat is the one the user brought last time.
   */
  async addFiles(files: readonly File[]): Promise<FlowReferenceAddResult> {
    if (files.length === 0) {
      return { added: [], warnings: [] };
    }
    await this.ensureReferencesDirectory();

    const taken = new Set((await this.listFiles(REFERENCES_DIR)).map(entry => entry.name));
    const added: string[] = [];
    const warnings: string[] = [];

    for (const file of files) {
      if (file.size > MAX_REFERENCE_BYTES) {
        warnings.push(`${file.name || 'That file'} is too large for the references column.`);
        continue;
      }
      const name = uniqueFileName(sanitizeFileName(file.name || 'file'), taken);
      const path = `${REFERENCES_DIR}/${name}`;
      try {
        // Binary for everything, text files included: the bytes the user brought are the bytes the
        // project should hold, and a text round-trip would rewrite line endings behind their back.
        await this.storage.writeBinaryFile(path, await file.arrayBuffer());
      } catch (error) {
        warnings.push(
          `Could not save ${file.name}: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
      taken.add(name);
      added.push(path);
      const kind = classifyReferenceKind(name);
      try {
        await this.upsert(name, {
          origin: 'user',
          // Only pictures carry a role, and the guess is only a pre-selected chip the user flips.
          ...(kind === 'image' ? { role: guessAttachmentRole(name) } : {}),
        });
      } catch {
        // The file is in the project, which is what matters; a missing index entry degrades to
        // "name + origin user" on the card and is not worth failing the drop over.
      }
    }

    return { added, warnings };
  }

  /** Create `references/` if it is not there. `writeTextFile` does NOT create parent directories. */
  async ensureReferencesDirectory(): Promise<void> {
    try {
      await this.storage.createDirectory(REFERENCES_DIR);
    } catch {
      // Already there, or unwritable — the write that follows reports the real problem.
    }
  }

  private async writeIndex(
    index: Readonly<Record<string, FlowReferenceIndexEntry>>
  ): Promise<void> {
    await this.ensureReferencesDirectory();
    await this.storage.writeTextFile(
      FLOW_REFERENCES_INDEX_PATH,
      `${JSON.stringify(index, null, 2)}\n`
    );
  }

  /** The pinned card. Present even when the file is not — the document is the list's anchor. */
  private async describeDocument(): Promise<FlowReferenceItem> {
    const name = IDEA_DOC_PATH.split('/').pop() ?? 'gdd.md';
    const descriptor = (await this.listFiles('design')).find(entry => entry.path === IDEA_DOC_PATH);
    const base = {
      path: IDEA_DOC_PATH,
      name,
      group: 'document' as const,
      kind: 'markdown' as const,
      origin: 'agent' as const,
      role: null,
      caption: null,
      readOnly: false,
      pinned: true,
    };
    if (!descriptor) {
      return { ...base, previewLine: null, sizeBytes: null, modifiedAt: null, missing: true };
    }
    return {
      ...base,
      previewLine: await this.readPreviewLine(IDEA_DOC_PATH, descriptor.size ?? null),
      sizeBytes: descriptor.size ?? null,
      modifiedAt: await this.readModifiedAt(IDEA_DOC_PATH),
      missing: false,
    };
  }

  /**
   * The rest of `design/`: the plan, the decision log, the style sheet — whatever the agent has
   * written beside the gdd. Listed because the agent *says* it wrote them ("План записан в
   * design/plan.md") and the column was the one place the user would look for them.
   *
   * Not recursive and not a hardcoded list of names: `design/source/**` is the Sources group and
   * gets skipped as a directory, while the agent invents document names as it goes (`plan.md` is
   * one it made up), so anything else in the folder is a real artefact of this project.
   *
   * Sorted by name, not by mtime like the other groups: these few files are rewritten on almost
   * every turn, and a newest-first order would reshuffle the column under the user's cursor.
   */
  private async describeDesignDocs(): Promise<FlowReferenceItem[]> {
    let entries: FileDescriptor[];
    try {
      entries = await this.storage.listDirectory(DESIGN_DIR);
    } catch {
      return [];
    }
    const descriptors = entries
      .filter(entry => entry.kind !== 'directory' && entry.path !== IDEA_DOC_PATH)
      .sort((a, b) => a.name.localeCompare(b.name));

    return Promise.all(
      descriptors.map(async (descriptor): Promise<FlowReferenceItem> => {
        const kind = classifyReferenceKind(descriptor.name);
        return {
          path: descriptor.path,
          name: descriptor.name,
          group: 'design',
          kind,
          origin: 'agent',
          role: null,
          caption: null,
          previewLine: await this.readPreviewLine(descriptor.path, descriptor.size ?? null, kind),
          sizeBytes: descriptor.size ?? null,
          modifiedAt: await this.readModifiedAt(descriptor.path),
          // The panel never writes here, so it never deletes here either: these are the agent's own
          // working memory, and deleting decisions.md from under it breaks the next turn.
          readOnly: true,
          // Only the gdd is pinned — it is the list's anchor, and the highlight has to mean that
          // one document, not the whole folder.
          pinned: false,
          missing: false,
        };
      })
    );
  }

  private async describeGroup(
    directory: string,
    group: FlowReferenceGroup,
    index: FlowReferenceIndex,
    readOnly: boolean
  ): Promise<FlowReferenceItem[]> {
    const descriptors = (await this.listFiles(directory)).filter(
      // The index describes the folder; it is metadata, not one of the artefacts in it.
      entry => entry.path !== FLOW_REFERENCES_INDEX_PATH
    );
    const items = await Promise.all(
      descriptors.map(async (descriptor): Promise<FlowReferenceItem> => {
        const kind = classifyReferenceKind(descriptor.name);
        // Keyed by file name, matching what prompt intake writes — the index sits in the folder it
        // describes, so a path key would repeat that folder in every key.
        const entry = index[descriptor.name];
        return {
          path: descriptor.path,
          name: descriptor.name,
          group,
          kind,
          origin: entry?.origin === 'agent' ? 'agent' : 'user',
          role: resolveRole(kind, entry?.role, descriptor.name),
          caption: entry?.caption?.trim() || null,
          previewLine: await this.readPreviewLine(descriptor.path, descriptor.size ?? null, kind),
          sizeBytes: descriptor.size ?? null,
          modifiedAt: await this.readModifiedAt(descriptor.path),
          readOnly,
          pinned: false,
          missing: false,
        };
      })
    );
    return items.sort(byNewestFirst);
  }

  /** Every file under `directory`, recursively. A missing directory is an empty list, not an error. */
  private async listFiles(directory: string): Promise<FileDescriptor[]> {
    let entries: FileDescriptor[];
    try {
      entries = await this.storage.listDirectory(directory);
    } catch {
      return [];
    }
    const files: FileDescriptor[] = [];
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        files.push(...(await this.listFiles(entry.path)));
        continue;
      }
      files.push(entry);
    }
    return files;
  }

  private async readModifiedAt(path: string): Promise<number | null> {
    try {
      return await this.storage.getLastModified(path);
    } catch {
      // Local backends read the mtime off a file handle, which can fail on a file being written.
      return null;
    }
  }

  private async readPreviewLine(
    path: string,
    sizeBytes: number | null,
    kind: FlowReferenceKind = 'markdown'
  ): Promise<string | null> {
    if (kind !== 'markdown' && kind !== 'text') {
      return null;
    }
    if (sizeBytes !== null && sizeBytes > MAX_PREVIEW_BYTES) {
      return null;
    }
    try {
      return firstMeaningfulLine(await this.storage.readTextFile(path));
    } catch {
      return null;
    }
  }
}

/**
 * Parse the index defensively: it is hand-editable, written by three separate call sites and read on
 * every refresh, so a stray value has to degrade to "no metadata" rather than empty the column.
 */
export const parseReferencesIndex = (raw: string): FlowReferenceIndex => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const index: Record<string, FlowReferenceIndexEntry> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    index[key] = {
      ...(isRole(record.role) ? { role: record.role } : {}),
      ...(typeof record.caption === 'string' ? { caption: record.caption } : {}),
      ...(record.origin === 'agent' || record.origin === 'user' ? { origin: record.origin } : {}),
      ...(typeof record.prompt === 'string' ? { prompt: record.prompt } : {}),
    };
  }
  return index;
};

const isRole = (value: unknown): value is FlowReferenceRole =>
  value === 'style' || value === 'content' || value === 'layout' || value === 'style-candidate';

/** Roles belong to pictures. A guessed role on a picture with no entry is intake's own default. */
const resolveRole = (
  kind: FlowReferenceKind,
  role: FlowReferenceRole | undefined,
  name: string
): FlowReferenceRole | null => {
  if (kind !== 'image') {
    return null;
  }
  return role ?? guessAttachmentRole(name);
};

/**
 * Newest first: a file that was just generated or dropped has to be visible without scrolling
 * (design §3.6). Unknown mtimes sort last rather than first — an unreadable timestamp is not news.
 */
const byNewestFirst = (a: FlowReferenceItem, b: FlowReferenceItem): number => {
  if (a.modifiedAt !== b.modifiedAt) {
    if (a.modifiedAt === null) return 1;
    if (b.modifiedAt === null) return -1;
    return b.modifiedAt - a.modifiedAt;
  }
  return a.name.localeCompare(b.name);
};

/** `hero.png` → `hero-2.png` when `hero.png` is taken; the suffix goes before the extension. */
export const uniqueFileName = (name: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(name)) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return `${stem}-${Date.now().toString(36)}${extension}`;
};

/** First line with words in it, stripped of markdown heading/quote/list markers. */
export const firstMeaningfulLine = (text: string): string | null => {
  for (const line of text.slice(0, MAX_PREVIEW_BYTES).split('\n')) {
    const cleaned = line
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*[>*-]\s+/, '')
      .trim();
    if (cleaned) {
      return cleaned.length > 160 ? `${cleaned.slice(0, 159)}…` : cleaned;
    }
  }
  return null;
};
