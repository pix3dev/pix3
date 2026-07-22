import { describe, it, expect, beforeEach } from 'vitest';
import { ScriptCreatorService } from '@/services/scripting/ScriptCreatorService';

describe('ScriptCreatorService', () => {
  let service: ScriptCreatorService;

  beforeEach(() => {
    service = new ScriptCreatorService();
  });

  describe('generateScriptTemplate', () => {
    it('should generate template with correct class name', () => {
      const gen = service as unknown as { generateScriptTemplate(name: string): string };
      const template = gen.generateScriptTemplate('PlayerMovement');

      expect(template).toContain('export class PlayerMovement extends Script');
      expect(template).toContain("nodeType: 'PlayerMovement'");
      expect(template).toContain("import { Script, type PropertySchema } from '@pix3/runtime'");
    });

    it('should include lifecycle methods', () => {
      const gen = service as unknown as { generateScriptTemplate(name: string): string };
      const template = gen.generateScriptTemplate('Test');

      expect(template).toContain('onAttach()');
      expect(template).toContain('onStart()');
      expect(template).toContain('onUpdate(dt: number)');
      expect(template).toContain('onDetach()');
    });

    it('should include property schema boilerplate', () => {
      const gen = service as unknown as { generateScriptTemplate(name: string): string };
      const template = gen.generateScriptTemplate('Test');

      expect(template).toContain('static getPropertySchema(): PropertySchema');
      expect(template).toContain('properties: [');
      expect(template).toContain('// Add property definitions here');
    });

    it('should include constructor with parameters initialization', () => {
      const gen = service as unknown as { generateScriptTemplate(name: string): string };
      const template = gen.generateScriptTemplate('Test');

      expect(template).toContain('constructor(id: string, type: string)');
      expect(template).toContain('super(id, type)');
      expect(template).toContain('this.config = {');
    });

    it('should include helpful comments and examples', () => {
      const gen = service as unknown as { generateScriptTemplate(name: string): string };
      const template = gen.generateScriptTemplate('MyScript');

      expect(template).toContain('Auto-generated script');
      expect(template).toContain('// Implement your update logic here');
    });

    it('should use correct import paths', () => {
      const gen = service as unknown as { generateScriptTemplate(name: string): string };
      const template = gen.generateScriptTemplate('Test');

      expect(template).toContain("import { Script, type PropertySchema } from '@pix3/runtime'");
      expect(template).toContain('static getPropertySchema(): PropertySchema');
    });
  });

  describe('service lifecycle', () => {
    it('should track active creators', () => {
      expect(service.getCreators()).toHaveLength(0);

      void service.showCreator({
        scriptName: 'TestScript',
      });

      expect(service.getCreators()).toHaveLength(1);
      expect(service.getCreators()[0].params.scriptName).toBe('TestScript');
    });

    it('should remove creator after cancellation', () => {
      void service.showCreator({
        scriptName: 'TestScript',
      });

      const creatorId = service.getCreators()[0].id;
      service.cancel(creatorId);

      expect(service.getCreators()).toHaveLength(0);
    });
  });
});
