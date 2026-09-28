import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import { Mesh, MeshBasicMaterial, Texture } from 'three';
import { describe, expect, it } from 'vitest';

import {
  AnimatedSprite2D,
  AssetLoader,
  AudioService,
  CharacterVisual2DBehavior,
  ResourceManager,
  SceneLoader,
  ScriptRegistry,
  registerBuiltInScripts,
  type AnimationResource,
} from '@pix3/runtime';

import {
  compileCharacter,
  scanNumberedSequences,
  type CharacterClipSpec,
  type SourceFrameFile,
} from './character-compiler';

/**
 * Acceptance on the REAL Seven characters (`samples/LibraryAssets/Project_Seven`): the plan's
 * Phase 0 gate "correct pixels for all 12 clips" plus the §13 checks "Seven compiler" and
 * "alignment". Everything the compiler is judged against is measured here independently — file
 * listings, decoded pixels, alpha bounding boxes — never read back from the compiler's own output.
 *
 * The headless harness does not decode images, so pixels are checked one level down: the runtime
 * sprite names the texture it shows (a path), and that path's decoded pixels must equal the
 * pixels of the source frame the listing says belongs at that clip/index.
 */
const ROOT = 'samples/LibraryAssets/Project_Seven';

/** Minimal PNG decoder: 8-bit RGBA, non-interlaced — the only shape this pack uses. */
function decodePng(bytes: Buffer): { width: number; height: number; rgba: Buffer } {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data[8], data[9], data[12]], 'RGBA8, non-interlaced').toEqual([8, 6, 0]);
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const a = x >= 4 ? rgba[y * stride + x - 4] : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4] : 0;
      let value = raw[y * (stride + 1) + 1 + x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rgba[y * stride + x] = value & 255;
    }
  }
  return { width, height, rgba };
}

interface MeasuredFrame extends SourceFrameFile {
  pixelHash: string;
  /** Last row with an opaque pixel (alpha > 16), y from the top. */
  bottomRow: number;
}

const measured = new Map<string, MeasuredFrame>();
function measure(relativePath: string): MeasuredFrame {
  const cached = measured.get(relativePath);
  if (cached) return cached;
  const { width, height, rgba } = decodePng(readFileSync(join(ROOT, relativePath)));
  let bottomRow = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] > 16) bottomRow = y;
    }
  }
  const frame = {
    path: relativePath,
    width,
    height,
    pixelHash: createHash('sha1').update(rgba).digest('hex'),
    bottomRow,
  };
  measured.set(relativePath, frame);
  return frame;
}

/**
 * The per-pack naming decision a recipe records (Phase 2): `<nn>_[gob_]<state>_<weapon>`, and the
 * author's `stuff` → `staff`. Deliberately here, not in the generic scanner.
 */
const SEVEN_STEM = /^\d+_(?:gob_)?(idle|run|attack|die)_(sword|stuff|bow)$/;
const WEAPON_NAMES: Record<string, string> = { sword: 'sword', stuff: 'staff', bow: 'bow' };

const EXPECTED_FRAMES: Record<string, number> = {
  'sword.idle': 12,
  'sword.run': 8,
  'sword.attack': 8,
  'sword.die': 15,
  'staff.idle': 12,
  'staff.run': 8,
  'staff.attack': 10,
  'staff.die': 15,
  'bow.idle': 12,
  'bow.run': 8,
  'bow.attack': 12,
  'bow.die': 15,
};

const CHARACTERS = [
  { dir: 'gob_animations', name: 'Goblin', slug: 'goblin' },
  { dir: 'knight_animations', name: 'Knight', slug: 'knight' },
];

class PathNamedAssetLoader extends AssetLoader {
  constructor(private readonly resource: AnimationResource) {
    super(new ResourceManager('/'), new AudioService());
  }
  async loadAnimationResource(): Promise<AnimationResource> {
    return this.resource;
  }
  async loadTexture(resourcePath: string): Promise<Texture> {
    const texture = new Texture();
    texture.name = resourcePath; // clones keep it: tells us which file a material shows
    return texture;
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

describe.skipIf(!existsSync(ROOT))('Seven characters (real frames)', () => {
  for (const character of CHARACTERS) {
    describe(character.name, () => {
      const files = readdirSync(join(ROOT, character.dir))
        .filter(name => name.endsWith('.png'))
        .map(name => measure(`${character.dir}/${name}`));
      const scan = scanNumberedSequences(files);

      const clips: CharacterClipSpec[] = scan.sequences.map(sequence => {
        const match = SEVEN_STEM.exec(sequence.stem);
        if (!match) throw new Error(`unmapped sequence ${sequence.key}`);
        return {
          variant: WEAPON_NAMES[match[2]],
          state: match[1],
          frames: sequence.frames,
          fps: 12,
        };
      });

      // Feet row, measured independently on the looping/locomotion states (die falls lower).
      const standingRows = new Set(
        clips
          .filter(c => c.state !== 'die')
          .flatMap(c => c.frames.map(f => measure(f.path).bottomRow))
      );
      const feetRow = [...standingRows][0];
      const compiled = compileCharacter({
        name: character.name,
        slug: character.slug,
        clips,
        defaultVariant: 'sword',
        defaultState: 'idle',
        anchor: { x: 0.5, y: (feetRow + 1) / 100 },
      });

      it('scans into 12 clean clips of the documented lengths, 135 frames of 100x100', () => {
        expect(files).toHaveLength(135);
        expect(scan.unnumbered).toEqual([]);
        expect(scan.sequences).toHaveLength(12);
        for (const sequence of scan.sequences) {
          expect(sequence.gaps, sequence.key).toEqual([]);
          expect(sequence.duplicates, sequence.key).toEqual([]);
          expect(sequence.mixedSizes, sequence.key).toEqual([]);
          expect(sequence.frames[0].number, sequence.key).toBe(1);
        }
        const lengths = Object.fromEntries(
          compiled.animation.clips.map(clip => [clip.name, clip.frames.length])
        );
        expect(lengths).toEqual(EXPECTED_FRAMES);
        expect(files.every(f => f.width === 100 && f.height === 100)).toBe(true);
      });

      it('keeps the feet on one row in every standing frame, and anchors the pivot there', () => {
        expect([...standingRows]).toEqual([84]);
        for (const clip of compiled.animation.clips) {
          for (const frame of clip.frames) {
            expect(frame.anchor).toEqual({ x: 0.5, y: 0.85 });
            expect(frame.sourceSize).toEqual({ width: 100, height: 100 });
          }
        }
      });

      it('copies every source frame exactly once, in numeric order, under the managed folder', () => {
        expect(compiled.frameFiles).toHaveLength(135);
        expect(new Set(compiled.frameFiles.map(f => f.sourcePath)).size).toBe(135);
        expect(new Set(compiled.frameFiles.map(f => f.targetPath)).size).toBe(135);
        expect(
          compiled.frameFiles.every(f => f.targetPath.startsWith(`sprites/${character.slug}/`))
        ).toBe(true);
        const staffAttack = compiled.frameFiles.filter(f =>
          f.targetPath.includes('/staff_attack_')
        );
        expect(staffAttack.map(f => f.sourcePath)).toEqual(
          Array.from(
            { length: 10 },
            (_, i) =>
              `${character.dir}/02_${character.slug === 'goblin' ? 'gob_' : ''}attack_stuff_${String(i + 1).padStart(4, '0')}.png`
          )
        );
      });

      it('shows the right pixels for every frame of every clip through the real loader', async () => {
        const registry = new ScriptRegistry();
        registerBuiltInScripts(registry);
        const loader = new SceneLoader(
          new PathNamedAssetLoader(compiled.animation),
          registry,
          new ResourceManager('/')
        );
        const graph = await loader.parseScene(compiled.prefabYaml, {
          filePath: `res://${compiled.prefabPath}`,
        });
        await settle();

        const root = graph.rootNodes[0];
        const sprite = root.children.find(
          (child): child is AnimatedSprite2D => child instanceof AnimatedSprite2D
        );
        expect(sprite).toBeDefined();
        if (!sprite) return;
        const material = (sprite.children.find(c => c instanceof Mesh) as Mesh)
          .material as MeshBasicMaterial;
        const sourceOf = new Map(
          compiled.frameFiles.map(f => [`res://${f.targetPath}`, f.sourcePath])
        );

        for (const clip of clips) {
          const clipName = `${clip.variant}.${clip.state}`;
          expect(sprite.play(clipName, { restart: true }), clipName).toBe(true);
          clip.frames.forEach((expected, index) => {
            sprite.currentFrame = index;
            const shownPath = material.map?.name ?? '';
            const shownSource = sourceOf.get(shownPath);
            expect(shownSource, `${clipName}[${index}]`).toBeDefined();
            expect(measure(shownSource ?? '').pixelHash, `${clipName}[${index}]`).toBe(
              measure(expected.path).pixelHash
            );
          });
        }

        // The check has teeth: at some shared index the clips really differ in pixels, so the
        // old index-keyed collision would have shown the wrong picture here.
        const idle = clips.find(c => c.variant === 'sword' && c.state === 'idle');
        const attack = clips.find(c => c.variant === 'sword' && c.state === 'attack');
        const differing = [1, 2, 3, 4].filter(
          i =>
            measure(idle?.frames[i].path ?? '').pixelHash !==
            measure(attack?.frames[i].path ?? '').pixelHash
        );
        expect(differing.length).toBeGreaterThan(0);

        // The prefab's component drives the same sprite by variant/state.
        const visual = root.components.find(
          (c): c is CharacterVisual2DBehavior => c instanceof CharacterVisual2DBehavior
        );
        expect(visual?.getVariants()).toEqual(['sword', 'staff', 'bow']);
        expect(visual?.getStates('staff')).toEqual(['attack', 'die', 'idle', 'run']);
        expect(visual?.setVariant('staff')).toBe(true);
        expect(visual?.playState('attack', { restart: true })).toBe(true);
        expect(sprite.currentClip).toBe('staff.attack');
      });
    });
  }
});
