import { injectable, inject } from '@/fw/di';
import { appState } from '@/state';
import { AssetGenService } from '@/services/image-gen/AssetGenService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { rasterizeSvg, type SvgRasterSize } from '@/services/image-gen/svg-render';
import {
  BUTTON_STATES,
  PALETTE,
  buildSkin,
  engineLaneTheme,
  frameMeta,
  normalizeTheme,
  skinBuildTheme,
  type ButtonSkinState,
  type ForgeTheme,
  type PaletteId,
  type RgbaBuffer,
  type SkinComponent,
  type SkinPart,
  type SkinSpec,
} from '@/services/uikit';
import {
  UI_KIT_MANIFEST_PATH,
  UI_THEME_GENERATOR,
  UiKitThemeService,
} from '@/services/uikit-editor/UiKitThemeService';
import { iconPartKey, partKey } from '@/services/uikit-editor/skin-planner';

/** Raster nine-slice insets, in pixels of the written PNG. */
export interface KitSliceBorder {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** One written picture, as `design/ui-kit.json` records it. */
export interface KitPartRecord {
  /** Project-relative path (no `res://`), e.g. `sprites/ui/1a2b3c4d/btn_green_normal_250x88.png`. */
  path: string;
  /** Raster size. */
  w: number;
  h: number;
  /** Insets in RASTER px, or `null` when the theme's silhouette is not nine-sliceable. */
  sliceBorder: KitSliceBorder | null;
  role: PaletteId | null;
  component: SkinComponent;
  state: ButtonSkinState | null;
  /** `icon-button` only: which glyph the picture carries. */
  icon?: string;
}

export interface KitManifest {
  version: string;
  generator: string;
  /** First 8 hex of a stable hash of the normalized theme — the folder name and the dedupe key. */
  kitId: string;
  /** Design units → raster px. */
  scale: number;
  createdAt: string;
  theme: ForgeTheme;
  parts: Record<string, KitPartRecord>;
  warnings: string[];
}

export interface KitWriteOptions {
  /** Design units → raster px. Defaults to the project manifest's `quality.maxPixelRatio`. */
  scale?: number;
  /** Which palette roles get buttons / panels / bar fills. Defaults to every role. */
  colorRoles?: readonly PaletteId[];
  /** Extra button sizes beyond {@link DEFAULT_BUTTON_SIZE}, in design units. */
  buttonSizes?: readonly { w: number; h: number }[];
  /** Bake the glyph buttons of {@link ICON_BUTTON_GLYPHS}. Default true. */
  iconButtons?: boolean;
  /** Extra colour roles for EVERY glyph, beyond each glyph's own semantic role. */
  iconButtonRoles?: readonly PaletteId[];
  /** Progress ticks, so a panel can show "17 / 76" without polling. */
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface KitWriteResult {
  kitId: string;
  scale: number;
  /** Every project-relative path written, PNGs first, then the two JSON documents. */
  paths: string[];
  manifest: KitManifest;
  warnings: string[];
}

export const KIT_MANIFEST_VERSION = '1.0';
export const UI_SPRITE_ROOT = 'sprites/ui';

/**
 * The size buttons are baked at.
 *
 * `Button2D` DOES carry `sliceBorder*` on this branch, so one source could in principle cover
 * every button size. It is still baked at a real size rather than a 64×64 stamp because the
 * gloss band's height is a PERCENT of the face (`ForgeTheme.glossH`) and the bevel lip is an
 * absolute number: stretching a tiny source vertically would smear both. 250×88 is the forge's
 * own default button, so what the preview shows is what the project gets.
 */
export const DEFAULT_BUTTON_SIZE = { w: 250, h: 88 } as const;

/**
 * The canonical design size of every non-button part. Each is nine-sliced onto whatever the node
 * is actually sized to, so these numbers decide texel density, not layout.
 */
const PART_SIZES: Record<
  Exclude<SkinComponent, 'button' | 'icon-button' | 'panel'>,
  { w: number; h: number }
> = {
  'panel-body': { w: 256, h: 256 },
  'header-plate': { w: 256, h: 70 },
  slot: { w: 320, h: 56 },
  checkbox: { w: 64, h: 64 },
  'checkbox-mark': { w: 64, h: 64 },
  'slider-track': { w: 240, h: 24 },
  'slider-thumb': { w: 48, h: 48 },
  'bar-trough': { w: 240, h: 36 },
  'bar-fill': { w: 240, h: 36 },
};

/**
 * The size a glyph button is baked at.
 *
 * Square, and NOT nine-sliced (`buildSkin` returns a null border for an icon button — the glyph
 * lives in the region a nine-slice stretches), so a node of another size scales this uniformly.
 */
export const ICON_BUTTON_SIZE = { w: 64, h: 64 } as const;

/**
 * The glyph buttons a kit ships, each with the role it means.
 *
 * One role per glyph rather than the full ten: the meaning is in the glyph (a close is red, a
 * plus is green), and 7 glyphs x 10 roles x 4 states would more than triple a bake for pictures
 * nothing asks for. `KitWriteOptions.iconButtonRoles` widens it when a caller wants more.
 *
 * Names are the ones `icons.ts` registers — "settings" is the `gear` glyph, and
 * `resolveIconName` accepts either spelling.
 */
export const ICON_BUTTON_GLYPHS: Readonly<Record<string, PaletteId>> = {
  close: 'red',
  gear: 'bluegray',
  plus: 'green',
  minus: 'red',
  left: 'blue',
  right: 'blue',
  check: 'green',
};

/** The parts that carry no colour role — one copy serves every role. */
const NEUTRAL_PARTS: readonly Exclude<SkinComponent, 'button' | 'icon-button' | 'panel'>[] = [
  'slot',
  'checkbox',
  'checkbox-mark',
  'slider-track',
  'slider-thumb',
  'bar-trough',
];

/** The parts baked once per colour role. */
const ROLE_PARTS: readonly Exclude<SkinComponent, 'button' | 'icon-button' | 'panel'>[] = [
  'panel-body',
  'header-plate',
  'bar-fill',
];

/**
 * A stable 32-bit FNV-1a over the theme's canonical JSON, as 8 lowercase hex.
 *
 * Stable across machines and sessions is the whole point (plan §7): the kit id is the folder
 * name, so re-baking an UNCHANGED theme overwrites the same files instead of littering the
 * project, while a re-theme writes a NEW folder and leaves the old skins in place — which is
 * exactly what makes Ctrl+Z on the property edit still show the previous art, and what
 * `export.pruneUnusedAssets` later collects.
 */
export function kitIdForTheme(theme: ForgeTheme): string {
  const canonical = canonicalJson(normalizeTheme(theme));
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** JSON with object keys sorted, so key order cannot change the hash. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

// The two key helpers live with the planner that consumes them; re-exported here because the
// manifest they address is this module's shape.
export { iconPartKey, partKey };

/**
 * Decode a PNG blob back to RGBA so `frameMeta` can measure it. Browser-only; returns `null`
 * wherever there is no canvas (a happy-dom spec), and the caller then falls back to scaling the
 * generator's own design-unit border.
 */
async function readRasterPixels(blob: Blob, w: number, h: number): Promise<RgbaBuffer | null> {
  try {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(bitmap, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    } finally {
      bitmap.close?.();
    }
  } catch {
    return null;
  }
}

/**
 * Bakes the engine lane of a {@link ForgeTheme} into the open project: PNG skins under
 * `sprites/ui/<kitId>/`, the manifest `design/ui-kit.json`, and the theme `design/ui-theme.json`.
 *
 * Two things are deliberately NOT here. There is no undo: binary writes are not reversible in
 * this editor and inventing a bulk-asset undo would be a worse trade than hash-named files that
 * simply stay on disk (plan §7). And there is no atlas packing: the project's own
 * `TextureAtlasService` packs at launch, and the kit has no business duplicating its caps.
 */
@injectable()
export class UiKitProjectWriter {
  @inject(AssetGenService)
  private readonly assets!: AssetGenService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(UiKitThemeService)
  private readonly themeService!: UiKitThemeService;

  /**
   * Rasterization and pixel read-back are instance fields rather than imports so a spec can swap
   * them for stubs — both need a real browser canvas, and neither is what these tests are about.
   */
  rasterize: (svg: string, size: SvgRasterSize) => Promise<Blob> = rasterizeSvg;
  readPixels: (blob: Blob, w: number, h: number) => Promise<RgbaBuffer | null> = readRasterPixels;

  /** The default raster scale: the quality preset's pixel-ratio ceiling, clamped to 1…4. */
  defaultScale(): number {
    const ratio = appState.project.manifest?.quality?.maxPixelRatio;
    const n = typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : 2;
    return Math.min(4, Math.max(1, Math.round(n)));
  }

  async writeKit(theme: ForgeTheme, options: KitWriteOptions = {}): Promise<KitWriteResult> {
    if (appState.project.status !== 'ready') {
      throw new Error('No project is open — cannot write the UI kit.');
    }

    const normalized = normalizeTheme(theme);
    const engineTheme = engineLaneTheme(normalized);
    const kitId = kitIdForTheme(normalized);
    const scale = options.scale ?? this.defaultScale();
    const roles: readonly PaletteId[] = options.colorRoles ?? PALETTE.map(entry => entry.id);
    const buttonSizes = [DEFAULT_BUTTON_SIZE, ...(options.buttonSizes ?? [])];

    const jobs = this.planJobs(roles, buttonSizes, normalized, options);
    const parts: Record<string, KitPartRecord> = {};
    const paths: string[] = [];
    const warnings: string[] = [];

    let done = 0;
    for (const job of jobs) {
      options.onProgress?.(done, jobs.length, job.fileName);
      const record = await this.writePart(job, kitId, scale, engineTheme, warnings);
      parts[job.key] = record;
      paths.push(record.path);
      done += 1;
    }
    options.onProgress?.(done, jobs.length, 'manifest');

    const manifest: KitManifest = {
      version: KIT_MANIFEST_VERSION,
      generator: UI_THEME_GENERATOR,
      kitId,
      scale,
      createdAt: new Date().toISOString(),
      theme: normalized,
      parts,
      warnings,
    };

    await this.writeJson(UI_KIT_MANIFEST_PATH, manifest);
    paths.push(UI_KIT_MANIFEST_PATH);
    paths.push(await this.themeService.save());

    return { kitId, scale, paths, manifest, warnings };
  }

  /** Read back the manifest the last bake wrote, or `null` when the project has no kit yet. */
  async readManifest(): Promise<KitManifest | null> {
    try {
      const text = await this.storage.readTextFile(UI_KIT_MANIFEST_PATH);
      const parsed = JSON.parse(text) as KitManifest;
      return parsed && typeof parsed === 'object' && parsed.parts ? parsed : null;
    } catch {
      return null;
    }
  }

  // -- internals -------------------------------------------------------------

  private planJobs(
    roles: readonly PaletteId[],
    buttonSizes: readonly { w: number; h: number }[],
    theme: ForgeTheme,
    options: KitWriteOptions
  ): PartJob[] {
    const jobs: PartJob[] = [];

    for (const role of roles) {
      for (const size of buttonSizes) {
        for (const state of BUTTON_STATES) {
          const isDefaultSize =
            size.w === DEFAULT_BUTTON_SIZE.w && size.h === DEFAULT_BUTTON_SIZE.h;
          jobs.push({
            // Extra sizes get their own key so the default one stays addressable as
            // `button/<role>/<state>` — the key `ApplyUiKitSkinOperation` resolves.
            key: isDefaultSize
              ? partKey('button', role, state)
              : `${partKey('button', role, state)}@${size.w}x${size.h}`,
            component: 'button',
            role,
            state,
            width: size.w,
            height: size.h,
            fileName: `btn_${role}_${state}_${size.w}x${size.h}.png`,
            theme,
          });
        }
      }
      for (const component of ROLE_PARTS) {
        const size = PART_SIZES[component];
        jobs.push({
          key: partKey(component, role),
          component,
          role,
          state: null,
          width: size.w,
          height: size.h,
          fileName: `${component}_${role}_${size.w}x${size.h}.png`,
          theme,
        });
      }
    }

    if (options.iconButtons !== false) {
      for (const [icon, semanticRole] of Object.entries(ICON_BUTTON_GLYPHS)) {
        const iconRoles = [...new Set([semanticRole, ...(options.iconButtonRoles ?? [])])];
        for (const role of iconRoles) {
          for (const state of BUTTON_STATES) {
            jobs.push({
              key: iconPartKey(icon, role, state),
              component: 'icon-button',
              role,
              state,
              icon,
              width: ICON_BUTTON_SIZE.w,
              height: ICON_BUTTON_SIZE.h,
              fileName: `icon_${icon}_${role}_${state}_${ICON_BUTTON_SIZE.w}x${ICON_BUTTON_SIZE.h}.png`,
              theme,
            });
          }
        }
      }
    }

    for (const component of NEUTRAL_PARTS) {
      const size = PART_SIZES[component];
      jobs.push({
        key: partKey(component),
        component,
        role: null,
        state: null,
        width: size.w,
        height: size.h,
        fileName: `${component}_${size.w}x${size.h}.png`,
        theme,
      });
    }

    return jobs;
  }

  private async writePart(
    job: PartJob,
    kitId: string,
    scale: number,
    engineTheme: ForgeTheme,
    warnings: string[]
  ): Promise<KitPartRecord> {
    const spec: SkinSpec = {
      component: job.component,
      // The neutral parts ignore the role; `sky` is simply what the generator defaults to.
      colorRole: job.role ?? 'sky',
      width: job.width,
      height: job.height,
      ...(job.state ? { state: job.state } : {}),
      ...(job.icon ? { icon: job.icon } : {}),
    };
    const part: SkinPart = buildSkin(spec, job.theme);
    // The theme this PART was drawn with, which is the author's minus the gloss cap on a
    // stretchable shape. `frameMeta` re-derives the insets from it below, and handing it the
    // uncapped one is how a 256 px panel came back with a 228 px top inset (and squashed).
    const partTheme = skinBuildTheme(spec, engineTheme);

    const rasterW = Math.max(1, Math.round(part.w * scale));
    const rasterH = Math.max(1, Math.round(part.h * scale));
    const blob = await this.rasterize(part.svg, { width: rasterW, height: rasterH });

    const relativePath = `${UI_SPRITE_ROOT}/${kitId}/${job.fileName}`;
    const handle = await this.assets.importBlob(blob, 'image/png', part.svg);
    try {
      await this.assets.save(handle.id, relativePath);
    } finally {
      this.assets.discard(handle.id);
    }

    return {
      path: relativePath,
      w: rasterW,
      h: rasterH,
      sliceBorder: await this.measureBorder(
        blob,
        part,
        rasterW,
        rasterH,
        scale,
        partTheme,
        job,
        warnings
      ),
      role: job.role,
      component: job.component,
      state: job.state,
      ...(job.icon ? { icon: job.icon } : {}),
    };
  }

  /**
   * The nine-slice insets in RASTER px.
   *
   * Measured from the rasterized pixels through `frameMeta` when a canvas is available — that is
   * the reading that accounts for what actually landed on the bitmap. Without one (a spec), the
   * generator's own design-unit border is scaled instead; the two agree by construction, the
   * measurement only catches a shape the theme made non-uniform.
   */
  private async measureBorder(
    blob: Blob,
    part: SkinPart,
    rasterW: number,
    rasterH: number,
    scale: number,
    partTheme: ForgeTheme,
    job: PartJob,
    warnings: string[]
  ): Promise<KitSliceBorder | null> {
    if (part.sliceBorder === null) return null;

    const rgba = await this.readPixels(blob, rasterW, rasterH);
    if (!rgba) {
      return {
        left: Math.round(part.sliceBorder.left * scale),
        right: Math.round(part.sliceBorder.right * scale),
        top: Math.round(part.sliceBorder.top * scale),
        bottom: Math.round(part.sliceBorder.bottom * scale),
      };
    }

    // No `caps`: the caps of the jam forge belonged to another game's atlas, and this project's
    // TextureAtlasService applies its own (plan §9.1).
    const meta = frameMeta({
      rgba,
      w: rasterW,
      h: rasterH,
      theme: partTheme,
      comp: { name: job.key, kind: job.component, w: part.w, h: part.h },
      scale,
    });
    for (const warning of meta.warnings) warnings.push(`${job.key}: ${warning}`);
    return {
      left: meta.border.left,
      right: meta.border.right,
      top: meta.border.top,
      bottom: meta.border.bottom,
    };
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    const directory = path.slice(0, path.lastIndexOf('/'));
    if (directory) {
      try {
        await this.storage.createDirectory(directory);
      } catch {
        // Already there; a genuine problem surfaces on the write below.
      }
    }
    await this.storage.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }
}

interface PartJob {
  key: string;
  component: SkinComponent;
  role: PaletteId | null;
  state: ButtonSkinState | null;
  icon?: string;
  width: number;
  height: number;
  fileName: string;
  theme: ForgeTheme;
}
