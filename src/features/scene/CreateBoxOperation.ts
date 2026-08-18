import { CreateNodeOperationBase } from '@/core/CreateNodeOperationBase';
import { defaultMaterialTypeForProject } from '@/core/material-defaults';
import { GeometryMesh, type GeometryMaterialType, type SceneGraph } from '@pix3/runtime';

export interface CreateBoxOperationParams {
  boxName?: string;
  size?: [number, number, number];
  color?: string;
  /** Overrides the project's platform default (see {@link defaultMaterialTypeForProject}). */
  materialType?: GeometryMaterialType;
}

export class CreateBoxOperation extends CreateNodeOperationBase<CreateBoxOperationParams> {
  protected getMetadataId(): string {
    return 'scene.create-box';
  }

  protected getMetadataTitle(): string {
    return 'Create Box';
  }

  protected getMetadataDescription(): string {
    return 'Create a box geometry mesh in the scene';
  }

  protected getMetadataTags(): string[] {
    return ['scene', 'geometry', 'box', 'node'];
  }

  protected getNodeTypeName(): string {
    return 'Box';
  }

  protected createNode(params: CreateBoxOperationParams, nodeId: string) {
    const boxName = params.boxName || 'Box';
    const size = params.size ?? [1, 1, 1];
    const color = params.color ?? '#4e8df5';
    const node = new GeometryMesh({
      id: nodeId,
      name: boxName,
      geometry: 'box',
      size,
      material: { color, type: params.materialType ?? defaultMaterialTypeForProject() },
    });
    return node as SceneGraph['rootNodes'][0];
  }
}
