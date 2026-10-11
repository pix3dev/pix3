/**
 * ScriptRegistry - Registry for script components
 *
 * Maintains a unified registry of script components.
 */
import type { PropertySchema } from '../fw/property-schema';
import type { ScriptComponent } from './ScriptComponent';
/**
 * Type for classes that have a static getPropertySchema method
 */
export interface PropertySchemaProvider {
    getPropertySchema(): PropertySchema;
}
/**
 * Component type definition for the unified registry
 */
export interface ComponentTypeInfo {
    /** Unique identifier/type name */
    id: string;
    /** Display name for UI */
    displayName: string;
    /** Description of what this component does */
    description: string;
    /** Category for grouping in UI */
    category: string;
    /** Constructor for the component class */
    componentClass: (new (id: string, type: string) => ScriptComponent) & PropertySchemaProvider;
    /** Keywords for search */
    keywords: string[];
}
/**
 * Registry service for script components
 */
export declare class ScriptRegistry {
    private components;
    constructor();
    /**
     * Register a component type (new unified API)
     */
    registerComponent(info: ComponentTypeInfo): void;
    /**
     * Unregister a component type
     */
    unregisterComponent(id: string): boolean;
    /**
     * Get a component type by ID
     */
    getComponentType(id: string): ComponentTypeInfo | undefined;
    /**
     * Get all registered component types
     */
    getAllComponentTypes(): ComponentTypeInfo[];
    /**
     * Create a component instance from a type ID.
     *
     * An unknown type returns `null`. Whether that is an *error* depends entirely on the caller, so
     * this does not decide: pass `expectRegistered: false` when a miss is an ordinary, handled
     * outcome and you will report it yourself.
     *
     * That distinction is not cosmetic. Scene loading hits this for every `user:*` component before
     * project scripts finish compiling — the components are parked and attached on registration, so
     * nothing is wrong — and it used to log `console.error` each time. Opening any project therefore
     * produced a dozen console errors that meant nothing, and those land in the editor's `read_errors`
     * channel, which is the tool an agent uses to decide whether something is broken. Benign noise in
     * the error channel trains the reader to ignore the error channel, which is how a real failure
     * gets skipped.
     */
    createComponent(typeId: string, instanceId: string, options?: {
        expectRegistered?: boolean;
    }): ScriptComponent | null;
    /**
     * Get property schema for a component type
     */
    getComponentPropertySchema(typeId: string): PropertySchema | null;
    /**
     * Search components by keyword
     */
    searchComponents(query: string): ComponentTypeInfo[];
    /**
     * Dispose the registry
     */
    dispose(): void;
}
