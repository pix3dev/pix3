import { Vector2, Vector3 } from 'three';
import type { CommandBase } from '@/core/command';
import type { CreateNodeCommandPayload } from '@/features/scene/CreateNodeBaseCommand';
import { CreateSprite2DCommand } from '@/features/scene/CreateSprite2DCommand';
import { CreateTiledSprite2DCommand } from '@/features/scene/CreateTiledSprite2DCommand';
import { CreateAnimatedSprite2DCommand } from '@/features/scene/CreateAnimatedSprite2DCommand';
import { CreateSpineSkeleton2DCommand } from '@/features/scene/CreateSpineSkeleton2DCommand';
import { CreateColorRect2DCommand } from '@/features/scene/CreateColorRect2DCommand';
import { CreateLabel2DCommand } from '@/features/scene/CreateLabel2DCommand';
import { CreateButton2DCommand } from '@/features/scene/CreateButton2DCommand';
import { CreateGroup2DCommand } from '@/features/scene/CreateGroup2DCommand';
import { CreateBar2DCommand } from '@/features/scene/CreateBar2DCommand';
import { CreateCamera2DCommand } from '@/features/scene/CreateCamera2DCommand';
import { CreateNode3DCommand } from '@/features/scene/CreateNode3DCommand';
import { CreateMeshInstanceCommand } from '@/features/scene/CreateMeshInstanceCommand';
import { CreateSprite3DCommand } from '@/features/scene/CreateSprite3DCommand';
import { CreateCamera3DCommand } from '@/features/scene/CreateCamera3DCommand';
import { CreateBoxCommand } from '@/features/scene/CreateBoxCommand';
import { CreateCheckbox2DCommand } from '@/features/scene/CreateCheckbox2DCommand';
import { CreateAmbientLightCommand } from '@/features/scene/CreateAmbientLightCommand';
import { CreateDirectionalLightCommand } from '@/features/scene/CreateDirectionalLightCommand';
import { CreateHemisphereLightCommand } from '@/features/scene/CreateHemisphereLightCommand';
import { CreatePointLightCommand } from '@/features/scene/CreatePointLightCommand';
import { CreateSpotLightCommand } from '@/features/scene/CreateSpotLightCommand';

/**
 * Normalized, type-agnostic creation options accepted by {@link buildCreateNodeCommand}. Each
 * factory forwards the fields its node type understands (the rest are set afterwards through the
 * generic property path). `position` is the 2D plane; 3D types take `position3` instead — a 3D node
 * created at the origin and moved by a follow-up property edit was one round-trip per light, and
 * the round-trip that got skipped is how lights ended up inside the geometry they were lighting.
 */
export interface CreateNodeOptions {
  name?: string;
  parentNodeId?: string | null;
  position?: Vector2;
  /** World position for 3D types (lights, meshes). Ignored by 2D factories. */
  position3?: Vector3;
  width?: number;
  height?: number;
  texturePath?: string | null;
  text?: string;
  /** res:// or templ:// path to a .glb/.gltf for MeshInstance3D. */
  src?: string | null;
}

type CreateCommand = CommandBase<CreateNodeCommandPayload, void>;
type CreateCommandFactory = (options: CreateNodeOptions) => CreateCommand;

/**
 * Canonical node type → Create*Command factory. Covers the node types worth creating
 * programmatically (all 2D content/UI plus the core 3D nodes); the interactive Create menu remains
 * the source of truth for the full catalogue. Keyed by a normalized lookup (see {@link normalize}).
 */
const REGISTRY: Record<string, { readonly label: string; readonly factory: CreateCommandFactory }> =
  {
    sprite2d: {
      label: 'Sprite2D',
      factory: o =>
        new CreateSprite2DCommand({
          spriteName: o.name,
          texturePath: o.texturePath,
          width: o.width,
          height: o.height,
          position: o.position,
          parentNodeId: o.parentNodeId,
        }),
    },
    tiledsprite2d: {
      label: 'TiledSprite2D',
      factory: o =>
        new CreateTiledSprite2DCommand({
          nodeName: o.name,
          texturePath: o.texturePath,
          width: o.width,
          height: o.height,
          position: o.position,
          parentNodeId: o.parentNodeId,
        }),
    },
    animatedsprite2d: {
      label: 'AnimatedSprite2D',
      factory: o =>
        new CreateAnimatedSprite2DCommand({
          nodeName: o.name,
          position: o.position,
          parentNodeId: o.parentNodeId,
        }),
    },
    spineskeleton2d: {
      label: 'SpineSkeleton2D',
      factory: o =>
        new CreateSpineSkeleton2DCommand({
          nodeName: o.name,
          position: o.position,
          parentNodeId: o.parentNodeId,
        }),
    },
    colorrect2d: {
      label: 'ColorRect2D',
      factory: o =>
        new CreateColorRect2DCommand({
          nodeName: o.name,
          position: o.position,
          parentNodeId: o.parentNodeId,
        }),
    },
    label2d: {
      label: 'Label2D',
      factory: o =>
        new CreateLabel2DCommand({
          labelName: o.name,
          text: o.text,
          position: o.position,
          parentNodeId: o.parentNodeId,
        }),
    },
    button2d: {
      label: 'Button2D',
      factory: o =>
        new CreateButton2DCommand({
          buttonName: o.name,
          width: o.width,
          height: o.height,
          position: o.position,
          parentNodeId: o.parentNodeId,
        }),
    },
    group2d: {
      label: 'Group2D',
      factory: o =>
        new CreateGroup2DCommand({
          groupName: o.name,
          width: o.width,
          height: o.height,
          position: o.position,
          parentNodeId: o.parentNodeId,
        }),
    },
    bar2d: {
      label: 'Bar2D',
      factory: o =>
        new CreateBar2DCommand({
          barName: o.name,
          width: o.width,
          height: o.height,
          position: o.position,
          parentNodeId: o.parentNodeId,
        }),
    },
    camera2d: {
      label: 'Camera2D',
      factory: o =>
        new CreateCamera2DCommand({
          cameraName: o.name,
          position: o.position,
          parentNodeId: o.parentNodeId,
        }),
    },
    node3d: {
      label: 'Node3D',
      factory: o => new CreateNode3DCommand({ nodeName: o.name }),
    },
    meshinstance3d: {
      label: 'MeshInstance3D',
      factory: o => new CreateMeshInstanceCommand({ meshName: o.name, src: o.src }),
    },
    sprite3d: {
      label: 'Sprite3D',
      factory: o =>
        new CreateSprite3DCommand({
          spriteName: o.name,
          texturePath: o.texturePath,
          width: o.width,
          height: o.height,
        }),
    },
    camera3d: {
      label: 'Camera3D',
      factory: o => new CreateCamera3DCommand({ cameraName: o.name }),
    },
    checkbox2d: {
      label: 'Checkbox2D',
      factory: o =>
        new CreateCheckbox2DCommand({
          checkboxName: o.name,
          position: o.position,
          parentNodeId: o.parentNodeId,
        }),
    },
    // A box is the 3D placeholder — the counterpart of ColorRect2D, and until now the one shape a
    // prototype could not get without authoring YAML or importing a .glb.
    geometrymesh: {
      label: 'GeometryMesh',
      factory: o => new CreateBoxCommand({ boxName: o.name }),
    },
    // Lights. Without these a 3D scene built through the tools is black, and the only way out was
    // hand-written YAML under a guessed type name — the failure the node-type aliases now absorb.
    ambientlightnode: {
      label: 'AmbientLightNode',
      factory: o => new CreateAmbientLightCommand({ lightName: o.name }),
    },
    directionallightnode: {
      label: 'DirectionalLightNode',
      factory: o => new CreateDirectionalLightCommand({ lightName: o.name, position: o.position3 }),
    },
    hemispherelightnode: {
      label: 'HemisphereLightNode',
      factory: o => new CreateHemisphereLightCommand({ lightName: o.name }),
    },
    pointlightnode: {
      label: 'PointLightNode',
      factory: o => new CreatePointLightCommand({ lightName: o.name, position: o.position3 }),
    },
    spotlightnode: {
      label: 'SpotLightNode',
      factory: o => new CreateSpotLightCommand({ lightName: o.name, position: o.position3 }),
    },
  };

/**
 * Spellings that mean an entry above. Same problem as the runtime's node-type aliases: `node.type`
 * reports `DirectionalLight`, the Create menu says "Directional Light", and the on-disk type has a
 * `Node` suffix — all three have to land on the same factory.
 */
const REGISTRY_ALIASES: Readonly<Record<string, string>> = {
  ambientlight: 'ambientlightnode',
  ambientlight3d: 'ambientlightnode',
  directionallight: 'directionallightnode',
  directionallight3d: 'directionallightnode',
  hemispherelight: 'hemispherelightnode',
  hemispherelight3d: 'hemispherelightnode',
  pointlight: 'pointlightnode',
  pointlight3d: 'pointlightnode',
  spotlight: 'spotlightnode',
  spotlight3d: 'spotlightnode',
  box: 'geometrymesh',
  // The Create menu calls this one `meshinstance`; the agent-facing label carries the 3D suffix.
  meshinstance: 'meshinstance3d',
  boxmesh: 'geometrymesh',
  cube: 'geometrymesh',
};

const normalize = (nodeType: string): string => nodeType.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Node type names this factory can create, in canonical form, for tool descriptions/errors. */
export const CREATABLE_NODE_TYPES: readonly string[] = Object.values(REGISTRY).map(e => e.label);

/**
 * Build the Create command for `nodeType` (case/separator-insensitive), or null when the type is
 * not in the registry. The caller dispatches the returned command through the mutation gateway.
 */
export const buildCreateNodeCommand = (
  nodeType: string,
  options: CreateNodeOptions
): CreateCommand | null => {
  const key = normalize(nodeType);
  const entry = REGISTRY[key] ?? REGISTRY[REGISTRY_ALIASES[key] ?? ''];
  return entry ? entry.factory(options) : null;
};
