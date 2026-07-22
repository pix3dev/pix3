import { injectable } from '@/fw/di';

import type {
  BinaryTemplateDescriptor,
  SceneTemplateDescriptor,
} from '@/services/project/template-data';
import { binaryTemplates, sceneTemplates } from '@/services/project/template-data';

@injectable()
export class TemplateService {
  private readonly sceneTemplateMap = new Map<string, SceneTemplateDescriptor>();
  private readonly binaryTemplateMap = new Map<string, BinaryTemplateDescriptor>();

  constructor() {
    for (const descriptor of sceneTemplates) {
      this.sceneTemplateMap.set(descriptor.id, descriptor);
    }
    for (const descriptor of binaryTemplates) {
      this.binaryTemplateMap.set(descriptor.id, descriptor);
    }
  }

  getSceneTemplate(id: string): string {
    const descriptor = this.sceneTemplateMap.get(id) ?? this.sceneTemplateMap.get('default');
    if (!descriptor) {
      throw new Error(`No scene template registered for id "${id}".`);
    }
    return descriptor.contents;
  }

  getBinaryTemplateUrl(id: string): string {
    const descriptor = this.binaryTemplateMap.get(id);
    if (!descriptor) {
      throw new Error(`No binary template registered for id "${id}".`);
    }
    return descriptor.url;
  }

  resolveSceneTemplateFromUri(uri: string): string {
    const templateId = this.extractTemplateId(uri);
    return this.getSceneTemplate(templateId);
  }

  resolveBinaryTemplateUrl(uri: string): string {
    const templateId = this.extractTemplateId(uri);
    return this.getBinaryTemplateUrl(templateId);
  }

  private extractTemplateId(uri: string): string {
    const match = /^templ:\/\/(.+)$/i.exec(uri.trim());
    if (!match) {
      throw new Error(`Unsupported template URI: ${uri}`);
    }
    return match[1] || 'default';
  }

  public dispose(): void {
    this.sceneTemplateMap.clear();
    this.binaryTemplateMap.clear();
  }
}

export const DEFAULT_TEMPLATE_SCENE_ID = 'startup-scene';
