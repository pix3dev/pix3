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
export class ScriptRegistry {
  // Unified component registry
  private components = new Map<string, ComponentTypeInfo>();

  constructor() {
    // Register built-in components here
    // For now, registry starts empty - components will be registered
    // by feature modules or plugins
  }

  /**
   * Register a component type (new unified API)
   */
  registerComponent(info: ComponentTypeInfo): void {
    if (this.components.has(info.id)) {
      console.warn(`[ScriptRegistry] Component "${info.id}" is already registered. Overwriting.`);
    }
    this.components.set(info.id, info);
  }

  /**
   * Unregister a component type
   */
  unregisterComponent(id: string): boolean {
    return this.components.delete(id);
  }

  /**
   * Get a component type by ID
   */
  getComponentType(id: string): ComponentTypeInfo | undefined {
    return this.components.get(id);
  }

  /**
   * Get all registered component types
   */
  getAllComponentTypes(): ComponentTypeInfo[] {
    return Array.from(this.components.values());
  }

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
  createComponent(
    typeId: string,
    instanceId: string,
    options: { expectRegistered?: boolean } = {}
  ): ScriptComponent | null {
    const componentInfo = this.components.get(typeId);
    if (!componentInfo) {
      if (options.expectRegistered !== false) {
        console.error(`[ScriptRegistry] Component type "${typeId}" not found in registry.`);
      }
      return null;
    }

    try {
      return new componentInfo.componentClass(instanceId, typeId);
    } catch (error) {
      console.error(`[ScriptRegistry] Failed to instantiate component "${typeId}":`, error);
      return null;
    }
  }

  /**
   * Get property schema for a component type
   */
  getComponentPropertySchema(typeId: string): PropertySchema | null {
    const componentInfo = this.components.get(typeId);
    if (!componentInfo) {
      return null;
    }

    return componentInfo.componentClass.getPropertySchema();
  }

  /**
   * Search components by keyword
   */
  searchComponents(query: string): ComponentTypeInfo[] {
    const lowercaseQuery = query.toLowerCase();
    return this.getAllComponentTypes().filter(
      component =>
        component.displayName.toLowerCase().includes(lowercaseQuery) ||
        component.description.toLowerCase().includes(lowercaseQuery) ||
        component.keywords.some(keyword => keyword.toLowerCase().includes(lowercaseQuery))
    );
  }

  /**
   * Dispose the registry
   */
  dispose(): void {
    this.components.clear();
  }
}
