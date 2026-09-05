import { Vector2 } from 'three';
import { injectable, inject } from '@/fw/di';
import { appState } from '@/state';
import {
  Button2D,
  Group2D,
  Label2D,
  NodeBase,
  SceneSaver,
  Sprite2D,
  TiledSprite2D,
  ColorRect2D,
  type Node2DLayoutConfig,
  type SceneGraph,
} from '@pix3/runtime';
import {
  buildTemplate,
  walkTemplate,
  type ForgeTheme,
  type TemplateId,
  type TemplateNode,
  type TemplateOptions,
  type TemplateSpec,
} from '@/services/uikit';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import {
  UiKitProjectWriter,
  kitIdForTheme,
  type KitManifest,
  type KitPartRecord,
} from '@/services/uikit-editor/UiKitProjectWriter';

/** Where template prefabs land. A prefab is an ordinary `.pix3scene` (spec §6.20). */
export const UI_PREFAB_ROOT = 'prefabs/ui';

export interface PrefabBuildOptions extends TemplateOptions {
  /** The baked kit whose parts the tree wears. Read from the project when omitted. */
  manifest?: KitManifest;
  /** Overwrite an existing file. Default true — re-baking a template is the normal flow. */
  overwrite?: boolean;
}

export interface PrefabBuildResult {
  /** Project-relative path, e.g. `prefabs/ui/dialog-1a2b3c4d.pix3scene`. */
  path: string;
  /** The same path as the engine addresses it. */
  resourcePath: string;
  templateId: TemplateId;
  kitId: string;
  yaml: string;
  /** Node names in creation order — unique by construction. */
  nodeNames: string[];
  warnings: string[];
}

/**
 * Turn a core {@link TemplateSpec} into a `.pix3scene` prefab.
 *
 * The core deliberately stops at data (§5): it hands over parts plus a layout and knows nothing
 * about nodes. Everything node-shaped lives here — which node type a template row becomes, how
 * the template's top-left/y-down rectangle becomes a pix3 centre-origin/y-up position, and how
 * `TemplateNode.anchor` becomes `Node2D.layout`.
 *
 * Prefab files are written directly rather than through `SaveAsPrefabCommand`: that command saves
 * a branch that already exists in a scene and replaces it with an instance. Here there is no
 * branch yet — the tree is built off-scene, serialized, and only instanced afterwards if the user
 * asks (`CreatePrefabInstanceCommand`).
 */
@injectable()
export class UiKitPrefabBuilder {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(UiKitProjectWriter)
  private readonly writer!: UiKitProjectWriter;

  /**
   * Build the tree and serialize it. No I/O — this is the half a spec can exercise, and the half
   * `buildAndWrite` reuses.
   */
  buildYaml(
    templateId: TemplateId,
    theme: ForgeTheme,
    manifest: KitManifest | null,
    options: TemplateOptions = {}
  ): { yaml: string; spec: TemplateSpec; nodeNames: string[]; warnings: string[] } {
    const spec = buildTemplate(templateId, theme, options);
    const warnings: string[] = [];
    if (!manifest) {
      warnings.push(
        'No design/ui-kit.json — the prefab was built with no textures. Save the kit, then rebuild.'
      );
    }

    const usedNames = new Set<string>();
    const nodeMap = new Map<string, NodeBase>();
    let counter = 0;
    const nextId = (): string => `uikit-${templateId}-${(counter += 1).toString(36)}`;

    const root = this.buildNode(spec.root, null, {
      manifest,
      warnings,
      usedNames,
      nextId,
      nodeMap,
    });

    const graph: SceneGraph = {
      version: '1.0.0',
      description: `UI Kit Forge ${templateId} template`,
      rootNodes: [root],
      nodeMap,
      metadata: {},
    };

    const yaml = new SceneSaver().serializeScene(graph);
    return { yaml, spec, nodeNames: [...usedNames], warnings };
  }

  /** Build, serialize, and write `prefabs/ui/<id>-<kitId>.pix3scene`. */
  async buildAndWrite(
    templateId: TemplateId,
    theme: ForgeTheme,
    options: PrefabBuildOptions = {}
  ): Promise<PrefabBuildResult> {
    if (appState.project.status !== 'ready') {
      throw new Error('No project is open — cannot write a UI kit prefab.');
    }

    const manifest = options.manifest ?? (await this.writer.readManifest());
    const kitId = manifest?.kitId ?? kitIdForTheme(theme);
    const { yaml, nodeNames, warnings } = this.buildYaml(templateId, theme, manifest, options);

    const path = `${UI_PREFAB_ROOT}/${templateId}-${kitId}.pix3scene`;
    if (options.overwrite === false) {
      const existing = await this.storage
        .readTextFile(path)
        .then(() => true)
        .catch(() => false);
      if (existing) {
        return {
          path,
          resourcePath: `res://${path}`,
          templateId,
          kitId,
          yaml,
          nodeNames,
          warnings: [
            ...warnings,
            `${path} already exists and overwrite was off — nothing written.`,
          ],
        };
      }
    }

    try {
      await this.storage.createDirectory(UI_PREFAB_ROOT);
    } catch {
      // Already there; the write below is where a real failure shows up.
    }
    await this.storage.writeTextFile(path, yaml);

    return { path, resourcePath: `res://${path}`, templateId, kitId, yaml, nodeNames, warnings };
  }

  // -- tree construction -----------------------------------------------------

  private buildNode(
    template: TemplateNode,
    parent: { w: number; h: number } | null,
    ctx: BuildContext
  ): NodeBase {
    const name = uniqueName(template.name, ctx.usedNames);
    const id = ctx.nextId();

    // Template space is top-left origin with y DOWN; pix3's 2D space is centre-origin with y UP,
    // and a node's position is its CENTRE. A root has no parent to be centred inside, so it sits
    // at the origin.
    const position = parent
      ? new Vector2(
          template.x + template.w / 2 - parent.w / 2,
          parent.h / 2 - (template.y + template.h / 2)
        )
      : new Vector2(0, 0);

    const layout = template.anchor
      ? {
          enabled: true,
          horizontalAlign: template.anchor.h,
          verticalAlign: template.anchor.v,
        }
      : undefined;

    const common = {
      id,
      name,
      position,
      ...(layout ? { layout } : {}),
    };

    const node = this.instantiate(template, common, ctx);
    ctx.nodeMap.set(id, node);

    for (const child of template.children ?? []) {
      node.add(this.buildNode(child, { w: template.w, h: template.h }, ctx));
    }
    return node;
  }

  private instantiate(template: TemplateNode, common: CommonProps, ctx: BuildContext): NodeBase {
    const w = Math.max(1, Math.round(template.w));
    const h = Math.max(1, Math.round(template.h));

    switch (template.type) {
      case 'Group2D':
        return new Group2D({ ...common, width: w, height: h });

      case 'TiledSprite2D': {
        const part = this.resolvePart(template.part, ctx);
        return new TiledSprite2D({
          ...common,
          width: w,
          height: h,
          texture: part ? textureRef(part) : null,
          ...(part?.sliceBorder
            ? { patchMode: 'nine-slice' as const, sliceBorder: part.sliceBorder }
            : {}),
        });
      }

      case 'Sprite2D': {
        const part = this.resolvePart(template.part, ctx);
        return new Sprite2D({
          ...common,
          width: w,
          height: h,
          ...(part ? { texture: textureRef(part) } : {}),
        });
      }

      case 'ColorRect2D':
        return new ColorRect2D({ ...common, width: w, height: h });

      case 'Label2D':
        return new Label2D({
          ...common,
          width: w,
          height: h,
          label: template.label ?? '',
          labelAlign: 'center',
          labelVAlign: 'middle',
        });

      case 'Button2D': {
        const states = template.states ?? {};
        const normal = this.resolvePart(states.normal ?? template.part, ctx);
        const border = normal?.sliceBorder ?? null;
        return new Button2D({
          ...common,
          width: w,
          height: h,
          label: template.label ?? '',
          textureNormal: normal ? textureRef(normal) : null,
          textureHover: refOrNull(this.resolvePart(states.hover, ctx)),
          texturePressed: refOrNull(this.resolvePart(states.pressed, ctx)),
          textureDisabled: refOrNull(this.resolvePart(states.disabled, ctx)),
          ...(border ? { sliceBorder: border } : {}),
        });
      }

      default: {
        const never: never = template.type;
        throw new Error(`UI Kit prefab: unsupported template node type "${String(never)}"`);
      }
    }
  }

  /** The kit record a template part key names, or `null` when there is no kit / no such part. */
  private resolvePart(partKeyName: string | undefined, ctx: BuildContext): KitPartRecord | null {
    if (!partKeyName || !ctx.manifest) return null;
    const record = ctx.manifest.parts[TEMPLATE_PART_TO_KIT[partKeyName] ?? partKeyName];
    if (!record) {
      ctx.warnings.push(`Kit has no part for "${partKeyName}" — that node is untextured.`);
      return null;
    }
    return record;
  }
}

/**
 * A template names its parts in ITS own vocabulary (`panel-body`, `close-normal`) because it is
 * host-agnostic; the kit manifest names them by component/role/state. This maps the fixed set the
 * two templates use onto the kit's keys.
 *
 * Colour roles are pinned to the ones `TemplateSpec` builds with (`buildTemplate`: the frame is
 * `sky` unless told otherwise, close is `red`, OK `green`, Cancel `gray`, toggles `blue`) so the
 * prefab looks like the preview the user just approved.
 */
const TEMPLATE_PART_TO_KIT: Record<string, string> = {
  'panel-body': 'panel-body/sky',
  'header-plate': 'header-plate/sky',
  // The close control is a GLYPH button (`TemplateSpec`: an "X", never the word "Close"), so it
  // resolves against the kit's icon-button parts.
  'close-normal': 'icon-button/close/red/normal',
  'close-hover': 'icon-button/close/red/hover',
  'close-pressed': 'icon-button/close/red/pressed',
  'close-disabled': 'icon-button/close/red/disabled',
  'ok-normal': 'button/green/normal',
  'ok-hover': 'button/green/hover',
  'ok-pressed': 'button/green/pressed',
  'ok-disabled': 'button/green/disabled',
  'cancel-normal': 'button/gray/normal',
  'cancel-hover': 'button/gray/hover',
  'cancel-pressed': 'button/gray/pressed',
  'cancel-disabled': 'button/gray/disabled',
  'toggle-normal': 'button/blue/normal',
  'toggle-hover': 'button/blue/hover',
  'toggle-pressed': 'button/blue/pressed',
  'toggle-disabled': 'button/blue/disabled',
};

interface BuildContext {
  manifest: KitManifest | null;
  warnings: string[];
  usedNames: Set<string>;
  nextId: () => string;
  nodeMap: Map<string, NodeBase>;
}

interface CommonProps {
  id: string;
  name: string;
  position: Vector2;
  layout?: Node2DLayoutConfig;
}

function textureRef(record: KitPartRecord): { type: 'texture'; url: string } {
  return { type: 'texture', url: `res://${record.path}` };
}

function refOrNull(record: KitPartRecord | null): { type: 'texture'; url: string } | null {
  return record ? textureRef(record) : null;
}

/** Node names are the handle a script and a prefab override both use — they must not collide. */
function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}${n++}`;
  used.add(name);
  return name;
}

/** Exposed for specs and for hosts that want the tree without the file. */
export { walkTemplate };
