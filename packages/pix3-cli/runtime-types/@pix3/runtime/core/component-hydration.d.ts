import type { PropertyDefinition } from '../fw/property-schema';
import type { NodeBase } from '../nodes/NodeBase';
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
export declare function getComponentSchemaProperties(scriptRegistry: ScriptRegistry, componentType: string): PropertyDefinition[] | null;
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
export declare function attachComponentDefinitions(node: NodeBase, definitions: readonly ComponentDefinition[] | undefined, scriptRegistry: ScriptRegistry): void;
/**
 * Second chance for {@link NodeBase.pendingComponents}: walk a subtree and attach every parked
 * definition whose type has since been registered. Called by the editor after project scripts
 * compile, which is exactly when `user:*` types appear.
 *
 * @returns how many components were attached.
 */
export declare function resolvePendingComponents(roots: Iterable<NodeBase>, scriptRegistry: ScriptRegistry): number;
/** Authored definitions for everything on a node: live components first, then still-pending ones. */
export declare function collectComponentDefinitions(node: NodeBase): ComponentDefinition[];
