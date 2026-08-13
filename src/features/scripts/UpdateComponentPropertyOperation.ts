import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import type { PropertyDefinition } from '@/fw';
import { coerceToPropertyType, SceneManager, ScriptRegistry } from '@pix3/runtime';

export interface UpdateComponentPropertyParams {
  nodeId: string;
  componentId: string;
  propertyName: string;
  value: unknown;
  previousValue?: unknown;
}

export class UpdateComponentPropertyOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scripts.update-component-property',
    title: 'Update Component Property',
    description: 'Update a script component property on a node',
    affectsNodeStructure: false,
    tags: ['scripts', 'component', 'property'],
  };

  private readonly params: UpdateComponentPropertyParams;

  constructor(params: UpdateComponentPropertyParams) {
    this.params = params;
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { container, state } = context;

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const scriptRegistry = container.getService<ScriptRegistry>(
      container.getOrCreateToken(ScriptRegistry)
    );

    const scene = sceneManager.getActiveSceneGraph();
    if (!scene) {
      return { didMutate: false };
    }

    const node = scene.nodeMap.get(this.params.nodeId);
    if (!node || !node.components || !Array.isArray(node.components)) {
      return { didMutate: false };
    }

    const component = node.components.find(c => c.id === this.params.componentId);
    if (!component) {
      return { didMutate: false };
    }

    const schema = scriptRegistry.getComponentPropertySchema(component.type);
    if (!schema) {
      return { didMutate: false };
    }

    const propDef = schema.properties.find(p => p.name === this.params.propertyName);
    if (!propDef) {
      return { didMutate: false };
    }

    // Coerce BEFORE validating: a caller that types the value loosely (the agent's
    // `set_component_property` passes model JSON straight through) otherwise stores `"1.5"` in a
    // number property. It survives arithmetic by coercion until it doesn't (`"1.5" + 1` is
    // `"1.51"`), and it lands in the saved `.pix3scene` as a quoted string next to real numbers —
    // which cost one measured Flow increment its entire iteration budget chasing the quotes.
    const nextValue = coerceToPropertyType(propDef.type, this.params.value);

    if (!this.validatePropertyUpdate(propDef, nextValue)) {
      return { didMutate: false };
    }

    const currentValue = propDef.getValue(component);
    const hasPreviousValueOverride = Object.prototype.hasOwnProperty.call(
      this.params,
      'previousValue'
    );
    const previousValue = hasPreviousValueOverride ? this.params.previousValue : currentValue;
    const currentValueJson = JSON.stringify(currentValue);
    const previousValueJson = JSON.stringify(previousValue);
    const nextValueJson = JSON.stringify(nextValue);

    if (currentValueJson === nextValueJson && previousValueJson === nextValueJson) {
      return { didMutate: false };
    }

    if (currentValueJson !== nextValueJson) {
      propDef.setValue(component, nextValue);
      component.config[this.params.propertyName] = nextValue;
    }

    const activeSceneId = state.scenes.activeSceneId;
    this.markSceneDirty(state, activeSceneId);

    return {
      didMutate: true,
      commit: {
        label: `Update ${component.type}.${propDef.ui?.label ?? propDef.name}`,
        beforeSnapshot: context.snapshot,
        undo: async () => {
          propDef.setValue(component, previousValue);
          component.config[this.params.propertyName] = previousValue;
          this.markSceneDirty(state, activeSceneId);
        },
        redo: async () => {
          propDef.setValue(component, nextValue);
          component.config[this.params.propertyName] = nextValue;
          this.markSceneDirty(state, activeSceneId);
        },
      },
    };
  }

  private markSceneDirty(state: OperationContext['state'], activeSceneId: string | null): void {
    if (!activeSceneId) {
      return;
    }

    const descriptor = state.scenes.descriptors[activeSceneId];
    if (descriptor) {
      descriptor.isDirty = true;
    }

    state.scenes.lastLoadedAt = Date.now();
  }

  private validatePropertyUpdate(propDef: PropertyDefinition, value: unknown): boolean {
    if (value === null || value === undefined) {
      return false;
    }

    if (!propDef.validation?.validate) {
      return true;
    }

    const result = propDef.validation.validate(value);
    return result === true;
  }
}
