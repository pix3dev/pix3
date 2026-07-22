import { injectable, inject } from '@/fw/di';
import { FileSystemAPIService } from '@/services/project/FileSystemAPIService';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';

export interface ScriptCreationParams {
  scriptName: string;
  defaultName?: string;
}

export interface ScriptCreationInstance {
  id: string;
  params: ScriptCreationParams;
  resolve: (scriptName: string | null) => void;
  reject: (error: Error) => void;
}

@injectable()
export class ScriptCreatorService {
  @inject(FileSystemAPIService)
  private readonly fs!: FileSystemAPIService;

  @inject(ProjectScriptLoaderService)
  private readonly scriptLoader!: ProjectScriptLoaderService;

  private creators = new Map<string, ScriptCreationInstance>();
  private nextId = 0;
  private listeners = new Set<(creators: ScriptCreationInstance[]) => void>();

  /**
   * Show the script creator dialog and return a promise that resolves to the created script name or null if cancelled.
   */
  public async showCreator(params: ScriptCreationParams): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const id = `creator-${this.nextId++}`;
      const instance: ScriptCreationInstance = {
        id,
        params,
        resolve: (scriptName: string | null) => {
          this.creators.delete(id);
          this.notifyListeners();
          resolve(scriptName);
        },
        reject: (error: Error) => {
          this.creators.delete(id);
          this.notifyListeners();
          reject(error);
        },
      };

      this.creators.set(id, instance);
      this.notifyListeners();
    });
  }

  /**
   * Get all active creators for rendering
   */
  public getCreators(): ScriptCreationInstance[] {
    return Array.from(this.creators.values());
  }

  /**
   * Subscribe to creator changes
   */
  public subscribe(listener: (creators: ScriptCreationInstance[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Confirm script creation
   */
  public async confirm(creatorId: string, scriptName: string): Promise<void> {
    const instance = this.creators.get(creatorId);
    if (!instance) return;

    try {
      // Create the script file
      const className = `${scriptName}`;
      const fileName = `${className}.ts`;
      const filePath = `scripts/${fileName}`;

      // Check if file already exists
      try {
        const entries = await this.fs.listDirectory('scripts');
        const fileExists = entries.some(e => e.kind === 'file' && e.name === fileName);

        if (fileExists) {
          throw new Error(`File "${fileName}" already exists in scripts/ directory`);
        }
      } catch (error) {
        // Directory might not exist yet, that's ok
        if (!(error as Error).message.includes('File')) {
          console.log('[ScriptCreator] Scripts directory does not exist yet');
        } else {
          throw error;
        }
      }

      // Generate script template
      const template = this.generateScriptTemplate(scriptName);

      // Ensure scripts directory exists
      try {
        await this.fs.createDirectory('scripts');
      } catch {
        // Directory might already exist, that's ok
        console.log('[ScriptCreator] Scripts directory already exists or created');
      }

      // Write the script file
      await this.fs.writeTextFile(filePath, template);

      // Trigger script compilation only if auto-compilation is enabled
      if (this.scriptLoader.enableAutoCompilation) {
        await this.scriptLoader.syncAndBuild();
      }

      // Emit event for asset browser to select the new file
      window.dispatchEvent(
        new CustomEvent('script-file-created', {
          detail: { filePath },
          bubbles: true,
        })
      );

      // Resolve with the created script name
      instance.resolve(className);
    } catch (error) {
      console.error('[ScriptCreator] Failed to create script:', error);
      instance.reject(error as Error);
    }
  }

  /**
   * Cancel script creation
   */
  public cancel(creatorId: string): void {
    const instance = this.creators.get(creatorId);
    if (instance) {
      instance.resolve(null);
    }
  }

  /**
   * Generate a script template
   */
  private generateScriptTemplate(scriptName: string): string {
    return `/**
 * ${scriptName} - Auto-generated script component
 *
 * Custom script component for node logic
 */

import { Script, type PropertySchema } from '@pix3/runtime';

export class ${scriptName} extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    // Initialize default config
    this.config = {
      // Add your config here
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: '${scriptName}',
      properties: [
        // Add property definitions here
        // Example:
        // {
        //   name: 'speed',
        //   type: 'number',
        //   ui: {
        //     label: 'Speed',
        //     description: 'Movement speed',
        //     group: 'Component',
        //     min: 0,
        //     max: 10,
        //     step: 0.1,
        //   },
        //   getValue: (script: unknown) => (script as ${scriptName}).config.speed,
        //   setValue: (script: unknown, value: unknown) => {
        //     (script as ${scriptName}).config.speed = Number(value);
        //   },
        // },
      ],
      groups: {
        Component: {
          label: 'Component Parameters',
          description: 'Configuration for ${scriptName.toLowerCase()} component',
          expanded: true,
        },
      },
    };
  }

  onAttach(): void {
    console.log(\`[${scriptName}] Attached to node "\${this.node?.name}" (\${this.node?.nodeId})\`);
    // Initialize script when attached to a node
  }

  onStart(): void {
    console.log(\`[${scriptName}] Starting on node "\${this.node?.name}"\`);
    // Called on the first frame after attachment
  }

  onUpdate(dt: number): void {
    // Called every frame with delta time in seconds
    // Implement your update logic here
  }

  onDetach(): void {
    console.log(\`[${scriptName}] Detached from node "\${this.node?.name}"\`);
    // Clean up resources when detached
  }
}
`;
  }

  private notifyListeners(): void {
    const creators = this.getCreators();
    for (const listener of this.listeners) {
      listener(creators);
    }
  }

  public dispose(): void {
    this.creators.clear();
    this.listeners.clear();
  }
}
