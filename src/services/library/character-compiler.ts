/**
 * Pure compiler for a **2D flipbook character** (Store pack asset kind `character2d`).
 *
 * Input: frame files already grouped into `variant + state` clips (the wizard / a recipe does the
 * grouping; `scanNumberedSequences` is the generic first pass). Output: the files a self-contained
 * character bundle needs, as data — the caller writes them (editor storage, a Store upload, a test
 * fixture) and copies the frame files by the returned plan.
 *
 * Layout follows the project's **managed sprite folder** convention, so the Sprite Editor shows the
 * character as one card and can write frames back:
 *
 * ```text
 * sprites/<slug>/<slug>.pix3anim          clips named <variant>.<state> (sword.idle, bow.attack)
 * sprites/<slug>/sword_idle_0001.png      one file per frame, <clip-prefix>_<nnnn>
 * prefabs/<Name>.pix3scene                Group2D root + core:CharacterVisual2D → AnimatedSprite2D Visual
 * ```
 *
 * No timestamps, ids or randomness: the same input yields byte-identical output (the Store's
 * revision hashes rely on it). Host-agnostic — no DI, no DOM, no file system.
 */

import { stringify } from 'yaml';

import type { AnimationClip, AnimationFrame, AnimationResource } from '@pix3/runtime';
import {
  buildAnimationFrameResourcePath,
  sanitizeFrameFilePrefix,
} from '@/features/scene/animation-asset-utils';

/** One source raster the caller has measured (decode is the host's job). */
export interface SourceFrameFile {
  /** Source-relative path (never absolute; never written into any output). */
  path: string;
  width: number;
  height: number;
}

export interface NumberedFrame extends SourceFrameFile {
  /** The numeric suffix parsed from the file name, as written (`0007` → 7). */
  number: number;
}

/** Files that share a directory and a name stem, ordered by their numeric suffix. */
export interface NumberedSequence {
  /** `<directory>/<stem>` — the identity the wizard maps to a variant/state. */
  key: string;
  directory: string;
  stem: string;
  frames: NumberedFrame[];
  /** Numbers missing between the first and the last frame (the author decides what they mean). */
  gaps: number[];
  /** Numbers that occur more than once (e.g. `run_03.png` and `run_003.png`). */
  duplicates: number[];
  /** Distinct `WxH` sizes when the frames do not all share one. */
  mixedSizes: string[];
}

export interface SequenceScan {
  sequences: NumberedSequence[];
  /** Files without a numeric suffix — stills, sheets, covers; never silently a one-frame clip. */
  unnumbered: SourceFrameFile[];
}

const NUMBERED_STEM = /^(.*?)[ _\-.]*(\d+)$/;

/**
 * Group frame files by `<directory>/<stem>` and numeric suffix, numerically sorted. Generic on
 * purpose: nothing here knows any pack's naming; sequences need not start at 1 and gaps are
 * reported, not filled.
 */
export function scanNumberedSequences(files: readonly SourceFrameFile[]): SequenceScan {
  const byKey = new Map<string, NumberedSequence>();
  const unnumbered: SourceFrameFile[] = [];

  for (const file of files) {
    const normalized = file.path.replace(/\\/g, '/');
    const slash = normalized.lastIndexOf('/');
    const directory = slash >= 0 ? normalized.slice(0, slash) : '';
    const fileName = normalized.slice(slash + 1);
    const dot = fileName.lastIndexOf('.');
    const stemWithNumber = dot > 0 ? fileName.slice(0, dot) : fileName;
    const match = NUMBERED_STEM.exec(stemWithNumber);
    if (!match || match[1].length === 0) {
      unnumbered.push(file);
      continue;
    }
    const stem = match[1];
    const key = directory ? `${directory}/${stem}` : stem;
    let sequence = byKey.get(key);
    if (!sequence) {
      sequence = { key, directory, stem, frames: [], gaps: [], duplicates: [], mixedSizes: [] };
      byKey.set(key, sequence);
    }
    sequence.frames.push({ ...file, path: normalized, number: Number.parseInt(match[2], 10) });
  }

  const sequences = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const sequence of sequences) {
    sequence.frames.sort((a, b) => a.number - b.number || a.path.localeCompare(b.path));
    const seen = new Set<number>();
    for (const frame of sequence.frames) {
      if (seen.has(frame.number) && !sequence.duplicates.includes(frame.number)) {
        sequence.duplicates.push(frame.number);
      }
      seen.add(frame.number);
    }
    const first = sequence.frames[0]?.number ?? 0;
    const last = sequence.frames[sequence.frames.length - 1]?.number ?? 0;
    for (let n = first; n <= last; n += 1) {
      if (!seen.has(n)) sequence.gaps.push(n);
    }
    const sizes = new Set(sequence.frames.map(f => `${f.width}x${f.height}`));
    sequence.mixedSizes = sizes.size > 1 ? [...sizes] : [];
  }

  return { sequences, unnumbered };
}

export interface CharacterClipSpec {
  /** Clip-name prefix (`sword`); empty for a variant-less state (`die`). */
  variant: string;
  state: string;
  frames: readonly SourceFrameFile[];
  /** Defaults to {@link DEFAULT_CHARACTER_FPS} — a proposal for the author, not a recovered speed. */
  fps?: number;
  /** Defaults per {@link ONE_SHOT_STATES}. */
  loop?: boolean;
}

export interface CharacterCompileSpec {
  /** Display name; also the prefab file name. */
  name: string;
  /** Folder / file stem for the sprite folder (`goblin`). */
  slug: string;
  clips: readonly CharacterClipSpec[];
  /** Pair the prefab starts on; defaults to the first clip's. */
  defaultVariant?: string;
  defaultState?: string;
  /** Between variant and state in clip names. Default `.`. */
  separator?: string;
  /**
   * Frame anchor for every frame, normalized with y from the top (`AnimationFrame.anchor`): the
   * point of the canvas that lands on the node's position. For a character this is the feet — a
   * canvas whose last opaque row is 84 of 100 wants `{ x: 0.5, y: 0.85 }`, so positioning the node
   * places the character on the ground. Default `{ x: 0.5, y: 0.5 }` (canvas centre).
   */
  anchor?: { x: number; y: number };
  /** Project-relative directories. Defaults: `sprites`, `prefabs`. */
  spriteDirectory?: string;
  prefabDirectory?: string;
}

export interface CompiledCharacterFrameFile {
  /** Where the caller reads the raster from (spec-relative). */
  sourcePath: string;
  /** Project-relative path the `.pix3anim` references (no `res://`). */
  targetPath: string;
}

export interface CompiledCharacter {
  animationPath: string;
  animation: AnimationResource;
  /** `animation` serialized exactly as it should be written. */
  animationJson: string;
  prefabPath: string;
  prefabYaml: string;
  frameFiles: CompiledCharacterFrameFile[];
  /** Non-fatal findings for the author (mixed sizes, defaulted fps/loop). */
  warnings: string[];
}

export const DEFAULT_CHARACTER_FPS = 12;
/** States that end and hold their last frame unless the author says otherwise. */
export const ONE_SHOT_STATES: readonly string[] = ['attack', 'die', 'death', 'hit', 'hurt'];

export function defaultLoopForState(state: string): boolean {
  return !ONE_SHOT_STATES.includes(state.trim().toLowerCase());
}

const toResourcePath = (projectPath: string): string => `res://${projectPath}`;

/**
 * Compile a character. Throws on input that cannot become a valid bundle (no clips, an empty clip,
 * a duplicate variant/state pair, a default pair no clip provides); everything else is a warning.
 */
export function compileCharacter(spec: CharacterCompileSpec): CompiledCharacter {
  const name = spec.name.trim();
  const slug = spec.slug.trim();
  if (!name || !slug) {
    throw new Error('[character-compiler] name and slug are required.');
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug)) {
    throw new Error(`[character-compiler] slug "${slug}" must be a plain folder name.`);
  }
  if (spec.clips.length === 0) {
    throw new Error('[character-compiler] a character needs at least one clip.');
  }
  const separator = spec.separator && spec.separator.length > 0 ? spec.separator : '.';
  const spriteDirectory = (spec.spriteDirectory ?? 'sprites').replace(/^\/+|\/+$/g, '');
  const prefabDirectory = (spec.prefabDirectory ?? 'prefabs').replace(/^\/+|\/+$/g, '');
  const animationPath = `${spriteDirectory}/${slug}/${slug}.pix3anim`;
  const animationResourcePath = toResourcePath(animationPath);

  const anchor = spec.anchor ?? { x: 0.5, y: 0.5 };
  if (![anchor.x, anchor.y].every(v => Number.isFinite(v))) {
    throw new Error('[character-compiler] anchor must be finite numbers.');
  }
  const warnings: string[] = [];
  const frameFiles: CompiledCharacterFrameFile[] = [];
  const clips: AnimationClip[] = [];
  const clipNames = new Set<string>();

  for (const clipSpec of spec.clips) {
    const variant = clipSpec.variant.trim();
    const state = clipSpec.state.trim();
    if (!state) {
      throw new Error('[character-compiler] every clip needs a state.');
    }
    const clipName = variant ? `${variant}${separator}${state}` : state;
    if (clipNames.has(clipName)) {
      throw new Error(`[character-compiler] duplicate clip "${clipName}".`);
    }
    clipNames.add(clipName);
    if (clipSpec.frames.length === 0) {
      throw new Error(`[character-compiler] clip "${clipName}" has no frames.`);
    }

    const sizes = new Set(clipSpec.frames.map(f => `${f.width}x${f.height}`));
    if (sizes.size > 1) {
      warnings.push(
        `${clipName}: frames differ in size (${[...sizes].join(', ')}); sizeMode native keeps each frame's own size.`
      );
    }
    if (clipSpec.fps === undefined) {
      warnings.push(`${clipName}: fps defaulted to ${DEFAULT_CHARACTER_FPS}.`);
    }
    const loop = clipSpec.loop ?? defaultLoopForState(state);
    if (clipSpec.loop === undefined) {
      warnings.push(`${clipName}: loop defaulted to ${loop}.`);
    }

    const frames: AnimationFrame[] = clipSpec.frames.map((frame, index) => {
      const targetPath = buildAnimationFrameResourcePath(animationResourcePath, index + 1, {
        clipName,
        extension: extensionOf(frame.path),
      }).replace(/^res:\/\//, '');
      frameFiles.push({ sourcePath: frame.path, targetPath });
      return {
        textureIndex: 0,
        offset: { x: 0, y: 0 },
        repeat: { x: 1, y: 1 },
        durationMultiplier: 1,
        anchor: { x: anchor.x, y: anchor.y },
        texturePath: toResourcePath(targetPath),
        boundingBox: { x: 0, y: 0, width: frame.width, height: frame.height },
        collisionPolygon: [],
        events: [],
        sourceSize: { width: frame.width, height: frame.height },
        points: [],
      };
    });

    clips.push({
      name: clipName,
      fps: clipSpec.fps ?? DEFAULT_CHARACTER_FPS,
      loop,
      playbackMode: 'normal',
      frames,
    });
  }

  const defaultVariant = (spec.defaultVariant ?? spec.clips[0].variant).trim();
  const defaultState = (spec.defaultState ?? spec.clips[0].state).trim();
  const defaultClipName = defaultVariant
    ? `${defaultVariant}${separator}${defaultState}`
    : defaultState;
  const defaultClip = clips.find(clip => clip.name === defaultClipName);
  if (!defaultClip) {
    throw new Error(
      `[character-compiler] default pair ${defaultVariant || '<none>'}/${defaultState} has no clip (have: ${[...clipNames].join(', ')}).`
    );
  }
  const size = defaultClip.frames[0].sourceSize ?? { width: 64, height: 64 };

  const animation: AnimationResource = { version: '1.0.0', texturePath: '', clips };
  const animationJson = `${JSON.stringify(animation, null, 2)}\n`;

  // A fresh object per node — sharing one would make the YAML writer emit an anchor/alias pair.
  const transform = () => ({ position: [0, 0], scale: [1, 1], rotation: 0 });
  const prefab = {
    version: '1.0.0',
    metadata: { name, description: `${name} — 2D character (variant/state flipbook)` },
    root: [
      {
        id: slug,
        type: 'Group2D',
        name,
        properties: { width: size.width, height: size.height, transform: transform() },
        components: [
          {
            id: `${slug}-character`,
            type: 'core:CharacterVisual2D',
            enabled: true,
            config: { variant: defaultVariant, state: defaultState, separator },
          },
        ],
        children: [
          {
            id: `${slug}-visual`,
            type: 'AnimatedSprite2D',
            name: 'Visual',
            properties: {
              animationResourcePath,
              currentClip: defaultClipName,
              isPlaying: true,
              sizeMode: 'native',
              width: size.width,
              height: size.height,
              transform: transform(),
            },
            children: [],
          },
        ],
      },
    ],
  };

  return {
    animationPath,
    animation,
    animationJson,
    prefabPath: `${prefabDirectory}/${name.replace(/[\\/:*?"<>|]+/g, '_')}.pix3scene`,
    prefabYaml: stringify(prefab, { lineWidth: 0 }),
    frameFiles,
    warnings,
  };
}

/** Clip prefix a file name would get for a clip (exposed for reimport diffs). */
export function clipFilePrefix(clipName: string): string {
  return sanitizeFrameFilePrefix(clipName);
}

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : 'png';
}
