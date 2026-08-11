import { blobToBase64 } from '@/services/image-gen/image-ops';

/**
 * Files staged in a prompt composer before it is sent — the chat composer and the Flow prompt-hero
 * accept the same three ways in (paste, drag-and-drop, file picker) and must agree on what an
 * attachment *is*, because both feed the same downstream contract: images land in
 * `res://references/`, documents in `design/source/`, and neither may exist only inside a
 * conversation that context compaction will eventually throw away (design §5.7).
 *
 * Kept deliberately dependency-free (no Lit, no DI): it is intake and classification, and the two
 * hosts differ in everything else — the chat composer sends attachments to the agent verbatim,
 * while the hero also hands them to the planner and persists them into a project that does not
 * exist yet.
 */

/**
 * What an attached image is FOR, which decides how it is used and is the single most consequential
 * field here (design §5.7, measured in eval S2 — a full-scene reference passed to a generator comes
 * back as a copied composition, not a sprite):
 *  - `style` — a moodboard or a screenshot of another game. Its palette is quantized and its style
 *    tokens are described in *words* into every generate-prompt. The image itself is never handed
 *    to the image generator.
 *  - `content` — one concrete object ("the hero looks like this"). Goes to the generator as a
 *    reference for ITS asset and nothing else; copying is the point here.
 *  - `layout` — a screen mockup or level sketch. Described structurally for the agent; never sent
 *    to the generator at all.
 *
 * Auto-classification is allowed to be wrong, which is why the UI always shows the role as a chip
 * the user can flip before sending.
 */
export type AttachmentRole = 'style' | 'content' | 'layout';

export const ATTACHMENT_ROLES: readonly AttachmentRole[] = ['style', 'content', 'layout'];

/** Short human label for a role chip. */
export const attachmentRoleLabel = (role: AttachmentRole): string => {
  switch (role) {
    case 'style':
      return 'style';
    case 'content':
      return 'object';
    case 'layout':
      return 'layout';
  }
};

/** One-line explanation of what picking this role will do (chip tooltip). */
export const attachmentRoleHint = (role: AttachmentRole): string => {
  switch (role) {
    case 'style':
      return 'Moodboard — its palette and look drive every generated asset';
    case 'content':
      return 'A specific object — used as a reference for that asset only';
    case 'layout':
      return 'A screen or level mockup — read for structure, never copied';
  }
};

export interface ComposerImageAttachment {
  readonly id: string;
  readonly kind: 'image';
  readonly name: string;
  readonly mimeType: string;
  /** Base64 WITHOUT the `data:` prefix (the wire format every LLM provider takes). */
  readonly base64: string;
  readonly size: number;
  readonly role: AttachmentRole;
}

export interface ComposerTextAttachment {
  readonly id: string;
  readonly kind: 'text';
  readonly name: string;
  readonly content: string;
  readonly size: number;
}

export type ComposerAttachment = ComposerImageAttachment | ComposerTextAttachment;

/** File extensions treated as attachable text (mirrors the agent's `fs_read` text set, loosely). */
const TEXT_ATTACHMENT_EXT = new Set([
  'txt',
  'md',
  'json',
  'ts',
  'tsx',
  'js',
  'jsx',
  'css',
  'html',
  'htm',
  'xml',
  'yaml',
  'yml',
  'csv',
  'ini',
  'cfg',
  'toml',
  'glsl',
  'vert',
  'frag',
  'pix3scene',
  'pix3anim',
  'log',
]);

/** True when a dropped/pasted file should be read as text rather than rejected. */
export const isTextualFile = (file: File): boolean => {
  if (file.type.startsWith('text/') || file.type === 'application/json') {
    return true;
  }
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  return TEXT_ATTACHMENT_EXT.has(ext);
};

/** Base64 (no `data:` prefix) of a blob — re-exported so composers have one import for intake. */
export { blobToBase64 };

/** "12 KB" / "1.4 MB" — the size shown on a document pill. */
export const formatAttachmentSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** `data:` URL for rendering an image attachment thumbnail. */
export const attachmentPreviewUrl = (attachment: ComposerImageAttachment): string =>
  `data:${attachment.mimeType};base64,${attachment.base64}`;

/**
 * First guess at an image's role from its file name and shape. Deliberately crude: the point is a
 * sensible pre-selected chip, and `style` is the default because it is the role whose mistake is
 * cheapest — a wrongly-styled palette is one click to fix, while a full scene wrongly sent to the
 * generator as `content` comes back baked into a sprite.
 */
export const guessAttachmentRole = (fileName: string): AttachmentRole => {
  const name = fileName.toLowerCase();
  if (/(mockup|layout|screen|ui|wireframe|level|map)/.test(name)) {
    return 'layout';
  }
  if (/(hero|player|char|enemy|item|icon|sprite|object|asset)/.test(name)) {
    return 'content';
  }
  return 'style';
};

export interface AttachmentIntakeOptions {
  /** Reject images (a text-only model is selected); the warning explains why. */
  readonly allowImages?: boolean;
  /** Skip files larger than this. Default 8 MB — an inlined 40 MB PSD helps nobody. */
  readonly maxBytes?: number;
  /** Id factory; defaults to a monotonic `att-<n>` per call batch. */
  readonly makeId?: (index: number) => string;
}

export interface AttachmentIntakeResult {
  readonly attachments: ComposerAttachment[];
  /** Human-readable reasons some files were skipped (shown next to the composer, never a modal). */
  readonly warnings: string[];
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Turn dropped/pasted/picked files into attachments, skipping (never throwing on) what cannot be
 * used. Returns warnings for everything skipped so the UI can say why inline.
 */
export const readFilesAsAttachments = async (
  files: FileList | readonly File[],
  options: AttachmentIntakeOptions = {}
): Promise<AttachmentIntakeResult> => {
  const allowImages = options.allowImages ?? true;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const makeId = options.makeId ?? ((index: number) => `att-${Date.now().toString(36)}-${index}`);
  const attachments: ComposerAttachment[] = [];
  const warnings: string[] = [];

  const list = Array.from(files);
  for (let index = 0; index < list.length; index += 1) {
    const file = list[index];
    if (file.size > maxBytes) {
      warnings.push(`${file.name} is too large (${formatAttachmentSize(file.size)}).`);
      continue;
    }
    if (file.type.startsWith('image/')) {
      if (!allowImages) {
        warnings.push('The selected model does not accept images — pick a vision model.');
        continue;
      }
      try {
        attachments.push({
          id: makeId(index),
          kind: 'image',
          name: file.name || 'pasted-image.png',
          mimeType: file.type,
          base64: await blobToBase64(file),
          size: file.size,
          role: guessAttachmentRole(file.name || ''),
        });
      } catch {
        warnings.push(`Could not read ${file.name || 'the pasted image'}.`);
      }
      continue;
    }
    if (isTextualFile(file)) {
      try {
        attachments.push({
          id: makeId(index),
          kind: 'text',
          name: file.name || 'document.txt',
          content: await file.text(),
          size: file.size,
        });
      } catch {
        warnings.push(`Could not read ${file.name}.`);
      }
      continue;
    }
    warnings.push(`${file.name || 'That file'} is not an image or a text document.`);
  }

  return { attachments, warnings };
};

/** Replace one attachment's role (the chip the user flips before sending). */
export const withAttachmentRole = (
  attachments: readonly ComposerAttachment[],
  id: string,
  role: AttachmentRole
): ComposerAttachment[] =>
  attachments.map(attachment =>
    attachment.id === id && attachment.kind === 'image' ? { ...attachment, role } : attachment
  );

/** True when a drag carries files (as opposed to text/HTML being dragged around the page). */
export const dragCarriesFiles = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files');

/**
 * Project-relative path an attachment is persisted to (design §5.7's hard rule). Images become
 * ordinary project assets under `references/`; documents become markdown under `design/source/` so
 * the agent can read them by section instead of inlining a 20-page GDD into every request.
 */
export const attachmentProjectPath = (attachment: ComposerAttachment): string =>
  attachment.kind === 'image'
    ? `references/${sanitizeFileName(attachment.name)}`
    : `design/source/${sanitizeFileName(stripExtension(attachment.name))}.md`;

const stripExtension = (name: string): string => name.replace(/\.[^./\\]+$/, '');

/** Make a user-supplied file name safe as a project-relative path segment. */
export const sanitizeFileName = (name: string): string => {
  const cleaned = name
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/-+/g, '-');
  return cleaned || 'file';
};
