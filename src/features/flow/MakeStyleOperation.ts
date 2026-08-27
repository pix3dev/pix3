import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { appState } from '@/state';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import {
  FlowReferencesService,
  type FlowReferenceRole,
} from '@/services/flow/FlowReferencesService';
import { DECISIONS_PATH, appendDecision } from '@/services/flow/decision-log';
import {
  STYLE_DECISION_QUESTION,
  STYLE_DOC_PATH,
  parseStyleReference,
  renderStyleFromReference,
} from '@/services/flow/style-doc';
import { extractPalette } from '@/services/image-gen/image-ops';

export interface MakeStyleParams {
  /** Project-relative path of the chosen image, e.g. `references/mood-2.png`. */
  readonly path: string;
}

/** How many swatches the style document carries. Same count the brief-driven writer uses. */
const PALETTE_SIZE = 5;

/**
 * Make one reference image THE style of the project — the deterministic half of the moodboard
 * (design §3.9).
 *
 * The agent's part of a moodboard is asking the question in pictures; answering it is a click, and
 * this is what the click does: promote the picture's role, measure its palette, write
 * `design/style.md`, and file the choice in the decision log. Not one token, and no chance of the
 * model paraphrasing the colours it "sees" into something the image does not contain.
 *
 * Three files change together, so undo restores all three or the project is left describing a style
 * it no longer points at. The losing candidates are deliberately left alone: they are the user's to
 * keep or delete, and the transition reads only the `style` role.
 */
export class MakeStyleOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'flow.make-style',
    title: 'Make It the Style',
    description: 'Adopt a reference image as the project style',
    tags: ['flow', 'references', 'style'],
  };

  constructor(private readonly params: MakeStyleParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const storage = context.container.getService<ProjectStorageService>(
      context.container.getOrCreateToken(ProjectStorageService)
    );
    const references = context.container.getService<FlowReferencesService>(
      context.container.getOrCreateToken(FlowReferencesService)
    );

    const path = this.params.path;
    const fileName = path.split('/').pop() ?? path;

    let blob: Blob;
    try {
      blob = await storage.readBlob(path);
    } catch {
      // The card is showing a file that is no longer there; adopting it would write a style
      // document pointing at nothing.
      return { didMutate: false };
    }

    // Median cut, no random seeding: the same image always yields the same palette, so re-adopting
    // a style can never silently recolour the project.
    const palette = (await extractPalette(blob, PALETTE_SIZE)).map(swatch => swatch.hex);

    const entry = await references.readIndexEntry(fileName);
    const previousRole: FlowReferenceRole | null = entry?.role ?? null;
    const caption = entry?.caption ?? entry?.prompt ?? '';

    const previousStyle = await readOrNull(storage, STYLE_DOC_PATH);
    const previousDecisions = await readOrNull(storage, DECISIONS_PATH);

    const styleDoc = renderStyleFromReference({
      title: appState.project.projectName || 'this project',
      referencePath: path,
      caption,
      palette,
    });

    // The losing candidates are named in the log, so a later reader can see what the look was
    // chosen AGAINST — the one thing the surviving file cannot say by itself.
    const rejected = (await references.list()).references
      .filter(item => item.role === 'style-candidate' && item.name !== fileName)
      .map(item => item.name);

    /**
     * The picture a previous click adopted, if it is still carrying the role.
     *
     * Changing your mind is the normal path through a moodboard, and without this the project ends
     * up with two files marked `style` while `style.md` names one — the transition reads the role,
     * so it would hand the planner both. Only the file `style.md` itself points at is demoted:
     * anything else marked `style` was set by the user's own role chip, and is not ours to undo.
     */
    const supersededName = (() => {
      const previousPath = previousStyle ? parseStyleReference(previousStyle) : null;
      const name = previousPath?.split('/').pop() ?? null;
      return name && name !== fileName ? name : null;
    })();
    const supersededRole = supersededName
      ? ((await references.readIndexEntry(supersededName))?.role ?? null)
      : null;
    const demoted = supersededName && supersededRole === 'style';

    const apply = async (): Promise<void> => {
      if (demoted && supersededName) {
        await references.setRole(supersededName, 'style-candidate');
      }
      await references.setRole(fileName, 'style');
      await storage.writeTextFile(STYLE_DOC_PATH, styleDoc);
      const { text } = appendDecision(previousDecisions ?? '', {
        question: STYLE_DECISION_QUESTION,
        // The caption of a generated candidate is its whole generation prompt — a paragraph. The
        // log is re-read at the start of every compacted conversation, so it gets the gist; the
        // full wording stays in `style.md`, which is read when the style itself is the subject.
        reason: condense(caption),
        choice: fileName,
        rejected,
      });
      await storage.writeTextFile(DECISIONS_PATH, text);
    };

    await apply();

    return {
      didMutate: true,
      commit: {
        label: `Make ${fileName} the style`,
        undo: async () => {
          if (previousRole) {
            await references.setRole(fileName, previousRole);
          }
          if (demoted && supersededName) {
            await references.setRole(supersededName, 'style');
          }
          await restore(storage, STYLE_DOC_PATH, previousStyle);
          await restore(storage, DECISIONS_PATH, previousDecisions);
        },
        redo: apply,
      },
    };
  }
}

/** Longest reason the decision log takes for a style — about a line, not a generation prompt. */
const REASON_LIMIT = 90;

/**
 * The gist of a caption: its first sentence, capped.
 *
 * Cutting at a sentence rather than mid-word because the result is read by a human and by a model,
 * and "flat vector illustration style, clean bold sh" reads as damage in both.
 */
const condense = (caption: string): string => {
  const flat = caption.replace(/\s+/g, ' ').trim();
  const firstSentence = /^(.+?)[.!?](?:\s|$)/.exec(flat)?.[1] ?? flat;
  if (firstSentence.length <= REASON_LIMIT) {
    return firstSentence;
  }
  const clipped = firstSentence.slice(0, REASON_LIMIT);
  // A comma is a phrase boundary and a space is only a word one, so the comma is preferred even
  // though it cuts shorter: "…warm inviting colours…" reads finished, "…colours, flat…" dangles.
  const comma = clipped.lastIndexOf(', ');
  const space = clipped.lastIndexOf(' ');
  const cut = comma > 40 ? comma : space > 40 ? space : REASON_LIMIT;
  return `${clipped.slice(0, cut).replace(/[,;]$/, '')}…`;
};

const readOrNull = async (storage: ProjectStorageService, path: string): Promise<string | null> => {
  try {
    return await storage.readTextFile(path);
  } catch {
    return null;
  }
};

/**
 * Put a file back the way it was.
 *
 * A file that did not exist before is emptied rather than deleted: `design/style.md` and
 * `design/decisions.md` are read by name all over the Flow, and an undo that removes one turns a
 * "no style chosen yet" into a missing-file path in code that never expected one. An empty document
 * reads as "nothing settled" everywhere — `extractDecisionEntries` and `parseStylePalette` both
 * answer empty for it.
 */
const restore = async (
  storage: ProjectStorageService,
  path: string,
  previous: string | null
): Promise<void> => {
  await storage.writeTextFile(path, previous ?? '');
};
