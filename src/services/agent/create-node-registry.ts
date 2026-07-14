import { Vector2 } from 'three';
import type { CommandBase } from '@/core/command';
import type { CreateNodeCommandPayload } from '@/features/scene/CreateNodeBaseCommand';
import { CreateSprite2DCommand } from '@/features/scene/CreateSprite2DCommand';
import { CreateTiledSprite2DCommand } from '@/features/scene/CreateTiledSprite2DCommand';
import { CreateAnimatedSprite2DCommand } from '@/features/scene/CreateAnimatedSprite2DCommand';
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

/**
 * Normalized, type-agnostic creation options accepted by {@link buildCreateNodeCommand}. Each
 * factory forwards the fields its node type understands (the rest are set afterwards through the
 * generic property path). Position is 2D; 3D nodes are created at the origin and positioned via a
 * follow-up property edit.
 */
export interface CreateNodeOptions {
  name?: string;
  parentNodeId?: string | null;
  position?: Vector2;
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
  const entry = REGISTRY[normalize(nodeType)];
  return entry ? entry.factory(options) : null;
};
