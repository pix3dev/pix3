/**
 * Makes a node's plain data fields behave like the Inspector does when a game script assigns them.
 *
 * ## The bug this exists to prevent
 *
 * A node property normally lives in two places: a public field, and a `PropertyDefinition` in the
 * class's `getPropertySchema()`. The schema's `setValue` is what the Inspector calls, and it usually
 * does more than assign — it clamps, rebuilds geometry, repaints a canvas texture, pushes a colour
 * into a material. The field is just a field. So the two paths diverge:
 *
 * ```ts
 * bar.setValue(30);  // Inspector path: clamps, then updateBarVisuals() — the bar moves
 * bar.value = 30;    // script path: field changes, NOTHING is redrawn
 * ```
 *
 * The script spelling is the natural one, it type-checks, and the getter afterwards returns 30 — so
 * even state-based verification confirms success while the screen shows the old value. Measured
 * across the runtime: 31 such properties on 16 node types. One of them (`UIControl2D.label`) cost
 * two agent turns and was only caught by a human looking at the screen.
 *
 * ## What this does
 *
 * Called once at the end of a concrete node's constructor, it replaces each schema-backed own data
 * property with an accessor pair: reads return the stored value, writes route through the schema's
 * `setValue` so the assignment does exactly what the Inspector would.
 *
 * Two details make that safe:
 *
 * - **Re-entrancy.** Most `setValue` closures assign the public property themselves (directly, or
 *   via a method like `Bar2D.setValue`). Routing writes into `setValue` would recurse forever, so
 *   while a property's `setValue` is running, writes to that same property store the value and
 *   return. The outer call still performs the refresh.
 * - **Per-instance, not per-prototype.** Accessors on the prototype would be shadowed by the very
 *   field declarations they replace under `useDefineForClassFields: true` (which is what
 *   `packages/pix3-runtime/tsconfig.json` sets), and this package's sources are compiled by
 *   consumers under configs we do not control. Defining on the instance works under both class-field
 *   semantics.
 *
 * Properties whose members are ALREADY accessors are left alone — the class has done this work
 * itself (`Node2D.opacity`, `UIControl2D.label`, `Camera3D.fov`, …).
 */
import type { PropertyDefinition, PropertySchema } from './property-schema';
/**
 * Convert one schema property on one instance into an accessor that refreshes on write.
 * Exported for tests; nodes call {@link installReactiveSchemaProperties}.
 */
export declare function makeSchemaPropertyReactive(node: object, definition: PropertyDefinition): 'installed' | 'skipped-accessor' | 'skipped-missing';
/**
 * Install reactive accessors for every schema property that this instance stores as a plain field.
 * Call as the LAST statement of a concrete node's constructor, once the node is fully built: writes
 * fire the schema's refresh work, which usually needs the node's meshes and size to exist.
 *
 * Pass the static method itself (`installReactiveSchemaProperties(this, Bar2D.getPropertySchema)`)
 * so the schema is built once per class rather than once per node.
 *
 * Idempotent per property, so a subclass calling it after its base class is harmless — and more
 * than harmless: if the subclass re-declared one of the base's schema properties as a field, its
 * declaration shadowed the base's accessor (define semantics), and this call puts it back.
 *
 * @returns the property names that became reactive on this call (for tests and diagnostics).
 */
export declare function installReactiveSchemaProperties(node: object, schemaOrProvider: PropertySchema | (() => PropertySchema)): string[];
/** Property names made reactive on this instance — for tests that guard against drift. */
export declare function reactiveSchemaPropertyNames(node: object): ReadonlySet<string>;
/**
 * Record a property's value without running its schema `setValue`.
 *
 * For a class method that already performs the refresh itself and then stores the value — the
 * `doTheWork(); this.prop = value;` shape — a plain assignment would run the schema refresh a second
 * time. Usually that is just a duplicated redraw, but it is not always harmless:
 * `SpineSkeleton2D.play(name, { mix })` called `view.play` with the caller's options and then set
 * `this.animation`, whose refresh re-played the track with the AUTHORED options and threw the
 * caller's away. Such methods assign through this instead.
 *
 * On a property that was never made reactive this is an ordinary assignment.
 */
export declare function assignWithoutSchemaRefresh(node: object, name: string, value: unknown): void;
