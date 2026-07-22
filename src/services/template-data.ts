import startupScene from '../templates/startup-scene.pix3scene?raw';
import testModelGlb from '../templates/Duck.glb?url';
import pix3LogoUrl from '../templates/pix3-logo.png?url';

export type SceneTemplateId = 'startup-scene' | 'default';
export type BinaryTemplateId = 'Duck.glb' | 'pix3-logo.png';

export interface SceneTemplateDescriptor {
  readonly id: SceneTemplateId;
  readonly contents: string;
  readonly title: string;
  readonly description?: string;
}

export interface BinaryTemplateDescriptor {
  readonly id: BinaryTemplateId;
  readonly url: string;
}

export const sceneTemplates: SceneTemplateDescriptor[] = [
  {
    id: 'startup-scene',
    contents: startupScene,
    title: 'Startup Scene',
    description: 'Default Pix3 scene with environment root, basic lighting, camera, and UI sprite.',
  },
  {
    id: 'default',
    contents: startupScene,
    title: 'Default Scene',
    description: 'Fallback template used when a requested template is missing.',
  },
];

export const binaryTemplates: BinaryTemplateDescriptor[] = [
  {
    id: 'Duck.glb',
    url: testModelGlb,
  },
  {
    id: 'pix3-logo.png',
    url: pix3LogoUrl,
  },
];
