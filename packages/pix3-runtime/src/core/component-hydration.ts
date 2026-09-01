import type { PropertyDefinition } from '../fw/property-schema';
import type { NodeBase } from '../nodes/NodeBase';
import type { ScriptComponent } from './ScriptComponent';
import type { ScriptRegistry } from './ScriptRegistry';

/** One `components:` entry of a `.pix3scene` node. */
export interface ComponentDefinition {
  id?: string;
  type: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/**
 * Resolve a component's editable properties from its registered schema, guarding against
 * malformed schemas. A component whose static `getPropertySchema()` returns an object without a
 * `properties` array (a common mistake in user-authored scripts — e.g. forgetting
 * `properties: []`) must not abort the entire scene load. Returns `null` when there is no usable
 * schema, warning and naming the offending component type in that case.
 */
export function getComponentSchemaProperties(
  scriptRegistry: ScriptRegistry,
  componentType: string
): PropertyDefinition[] | null {
  const schema = scriptRegistry.getComponentPropertySchema(componentType);
  if (!schema) {
    return null;
  }

  if (!Array.isArray(schema.properties)) {
    console.warn(
      `[SceneLoader] Component "${componentType}" has a malformed property schema: ` +
        `getPropertySchema() must return an object with a "properties" array. ` +
        `Skipping config application for this component.`
    );
    return null;
  }

  // Each entry must expose a callable setValue(node, value) closure — that is what config
  // application uses. Hand- or AI-authored project scripts sometimes return bare
  // `{ name, type, defaultValue }` entries (no closures); a single malformed entry must not
  // abort the whole scene load, so skip it with a warning and keep the well-formed properties.
  const rawProperties = schema.properties as ReadonlyArray<
    { name?: unknown; getValue?: unknown; setValue?: unknown } | null | undefined
  >;
  const usable: PropertyDefinition[] = [];
  for (const prop of rawProperties) {
    if (prop && typeof prop.setValue === 'function' && typeof prop.name === 'string') {
      usable.push(prop as unknown as PropertyDefinition);
      continue;
    }
    const label = prop && typeof prop.name === 'string' ? `"${prop.name}"` : '(unnamed)';
    console.warn(
      `[SceneLoader] Component "${componentType}" has a malformed property definition ${label}: ` +
        `each property must expose a setValue(node, value) function. Skipping this property.`
    );
  }

  return usable;
}

/**
 * Instantiate one authored component definition. Returns `null` when the type is not registered.
 */
function instantiateComponent(
  scriptRegistry: ScriptRegistry,
  definition: ComponentDefinition,
  ownerNodeId: string
): ScriptComponent | null {
  const componentId = definition.id || `${ownerNodeId}-${definition.type}-${Date.now()}`;
  const component = scriptRegistry.createComponent(definition.type, componentId);
  if (!component) {
    return null;
  }

  component.enabled = definition.enabled ?? true;

  const configData = definition.config ?? {};
  // MERGE over the class defaults, never replace them. A scene stores only the values that were
  // authored/edited, so a wholesale replace silently wiped every default the script's constructor
  // set — a field added to a script after the scene was written came back `undefined` (and numeric
  // defaults collapsed to 0/1), with no error anywhere. Measured twice in one session: a grid size
  // of 100 became 1 and a prefab path became "".
  component.config = { ...component.config, ...configData };

  const properties = getComponentSchemaProperties(scriptRegistry, definition.type);
  if (properties) {
    for (const prop of properties) {
      if (configData[prop.name] !== undefined) {
        prop.setValue(component, configData[prop.name]);
      }
    }
  }

  return component;
}

/**
 * Attach authored component definitions to a freshly built node.
 *
 * A definition whose script type is not registered **yet** is parked in {@link
 * NodeBase.pendingComponents} rather than thrown away. Dropping it used to be silent data loss:
 * the editor compiles project scripts asynchronously (esbuild-wasm, debounced), so a scene that
 * opens first — every recipe project does — loaded with `user:GameRules` unresolved, and the very
 * next scene save wrote the file back **without** it. Measured in 3 of 4 Flow eval runs: the
 * components vanished from `game-root`/`hud` right after the first `create_node`, and the agent
 * spent turns re-attaching them by hand.
 */
export function attachComponentDefinitions(
  node: NodeBase,
  definitions: readonly ComponentDefinition[] | undefined,
  scriptRegistry: ScriptRegistry
): void {
  if (!definitions) {
    return;
  }
  for (const definition of definitions) {
    const component = instantiateComponent(scriptRegistry, definition, node.nodeId);
    if (component) {
      node.addComponent(component);
      continue;
    }
    node.pendingComponents.push({ ...definition, config: { ...(definition.config ?? {}) } });
    console.warn(
      `[SceneLoader] Component type "${definition.type}" is not registered yet — kept as pending ` +
        `on node "${node.nodeId}". It will attach once the type registers, and is preserved on save.`
    );
  }
}

/**
 * Second chance for {@link NodeBase.pendingComponents}: walk a subtree and attach every parked
 * definition whose type has since been registered. Called by the editor after project scripts
 * compile, which is exactly when `user:*` types appear.
 *
 * @returns how many components were attached.
 */
export function resolvePendingComponents(
  roots: Iterable<NodeBase>,
  scriptRegistry: ScriptRegistry
): number {
  let attached = 0;
  const stack: NodeBase[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    for (const child of node.children) {
      stack.push(child);
    }
    if (node.pendingComponents.length === 0) {
      continue;
    }
    const stillPending: ComponentDefinition[] = [];
    for (const definition of node.pendingComponents) {
      const component = instantiateComponent(scriptRegistry, definition, node.nodeId);
      if (component) {
        node.addComponent(component);
        attached += 1;
      } else {
        stillPending.push(definition);
      }
    }
    node.pendingComponents.length = 0;
    node.pendingComponents.push(...stillPending);
  }
  return attached;
}

/** Authored definitions for everything on a node: live components first, then still-pending ones. */
export function collectComponentDefinitions(node: NodeBase): ComponentDefinition[] {
  const definitions: ComponentDefinition[] = node.components.map(component => ({
    id: component.id,
    type: component.type,
    enabled: component.enabled,
    config: component.config && Object.keys(component.config).length > 0 ? component.config : {},
  }));
  for (const pending of node.pendingComponents) {
    definitions.push({ ...pending, config: { ...(pending.config ?? {}) } });
  }
  return definitions;
}
