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

/** Marks an instance as already processed, so a subclass constructor's call is a cheap no-op. */
const INSTALLED = Symbol('pix3.reactiveSchemaProperties');
/** Names whose `setValue` is currently on the stack, per instance — the re-entrancy guard. */
const IN_FLIGHT = Symbol('pix3.reactiveSchemaPropertiesInFlight');

interface Installable {
  [INSTALLED]?: Set<string>;
  [IN_FLIGHT]?: Set<string>;
}

/**
 * Whether this property can be made reactive on `target`: it must currently be a plain own data
 * property (writable, no getter). An accessor means the class already handles refreshing, an
 * absent property means the class does not store it as a field, and a non-writable one is not ours
 * to redefine.
 */
const isPlainDataField = (target: object, name: string): boolean => {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  return descriptor !== undefined && descriptor.writable === true && !('get' in descriptor);
};

/**
 * Convert one schema property on one instance into an accessor that refreshes on write.
 * Exported for tests; nodes call {@link installReactiveSchemaProperties}.
 */
export function makeSchemaPropertyReactive(
  node: object,
  definition: PropertyDefinition
): 'installed' | 'skipped-accessor' | 'skipped-missing' {
  const { name, setValue } = definition;
  const descriptor = Object.getOwnPropertyDescriptor(node, name);
  if (descriptor === undefined) {
    return 'skipped-missing';
  }
  if (!isPlainDataField(node, name)) {
    return 'skipped-accessor';
  }

  let stored = descriptor.value as unknown;
  /** True when the current setValue call assigned the field it owns (the re-entrant branch ran). */
  let reentrantWrite = false;
  const host = node as Installable;

  Object.defineProperty(node, name, {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: () => stored,
    set(value: unknown) {
      const inFlight = (host[IN_FLIGHT] ??= new Set<string>());
      if (inFlight.has(name)) {
        // We are inside this property's own setValue — it is assigning the field it owns. Store the
        // value and let the outer call finish the refresh, or we would recurse forever.
        stored = value;
        reentrantWrite = true;
        return;
      }
      inFlight.add(name);
      reentrantWrite = false;
      try {
        setValue(node, value);
        // The authoritative value is whatever setValue left behind — not the argument. When it
        // assigned the field it owns (Bar2D clamps, then assigns), that re-entrant write already IS
        // that value; `getValue` must not overwrite it, because some getters dress the field up for
        // the Inspector (Button2D's texture refs report `{url: ''}` for a null field, and storing
        // that back would turn a cleared ref truthy — which SceneSaver serializes). Only when
        // setValue never touched the field (it coerced into another store, or ignored a read-only
        // write) is `getValue` the best available answer.
        //
        // And only for a PRIMITIVE field. When the field holds an object, `setValue` very often
        // mutates it in place instead of assigning (`this.tileScale.set(x, y)`,
        // `this.groups.add(g)`) while `getValue` hands back a snapshot — a plain `{x, y}` for a
        // Vector2, an array for a Set. Storing that snapshot would swap a live object the class
        // keeps using for a dead copy, and the next `.set()`/`.add()` would throw. An untouched
        // object field is already correct, because the mutation landed inside it.
        if (!reentrantWrite && (stored === null || typeof stored !== 'object')) {
          stored = definition.getValue(node);
        }
      } finally {
        inFlight.delete(name);
      }
    },
  });
  return 'installed';
}

/**
 * Building a schema allocates a definition object with two closures per property, so the result is
 * cached per provider function. Keyed by the provider itself rather than by the node's constructor:
 * a subclass inherits its base's `getPropertySchema` reference, and each class in the chain installs
 * from whichever provider its own constructor passes.
 */
const schemaCache = new WeakMap<() => PropertySchema, PropertySchema>();

const resolveSchema = (
  schemaOrProvider: PropertySchema | (() => PropertySchema)
): PropertySchema => {
  if (typeof schemaOrProvider !== 'function') {
    return schemaOrProvider;
  }
  const cached = schemaCache.get(schemaOrProvider);
  if (cached) {
    return cached;
  }
  const built = schemaOrProvider();
  schemaCache.set(schemaOrProvider, built);
  return built;
};

/**
 * Install reactive accessors for every schema property that this instance stores as a plain field.
 * Call as the LAST statement of a concrete node's constructor, once the node is fully built: writes
 * fire the schema's refresh work, which usually needs the node's meshes and size to exist.
 *
 * Pass the static method itself (`installReactiveSchemaProperties(this, Bar2D.getPropertySchema)`)
 * so the schema is built once per class rather than once per node.
 *
 * Idempotent per property, so a subclass calling it after its base class is harmless.
 *
 * @returns the property names that became reactive on this call (for tests and diagnostics).
 */
export function installReactiveSchemaProperties(
  node: object,
  schemaOrProvider: PropertySchema | (() => PropertySchema)
): string[] {
  const schema = resolveSchema(schemaOrProvider);
  const host = node as Installable;
  const installed = (host[INSTALLED] ??= new Set<string>());
  const added: string[] = [];
  for (const definition of schema.properties) {
    if (installed.has(definition.name)) {
      continue;
    }
    if (makeSchemaPropertyReactive(node, definition) === 'installed') {
      installed.add(definition.name);
      added.push(definition.name);
    }
  }
  return added;
}

/** Property names made reactive on this instance — for tests that guard against drift. */
export function reactiveSchemaPropertyNames(node: object): ReadonlySet<string> {
  return (node as Installable)[INSTALLED] ?? new Set<string>();
}

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
export function assignWithoutSchemaRefresh(node: object, name: string, value: unknown): void {
  const host = node as Installable;
  const inFlight = (host[IN_FLIGHT] ??= new Set<string>());
  const alreadyInFlight = inFlight.has(name);
  inFlight.add(name);
  try {
    (node as Record<string, unknown>)[name] = value;
  } finally {
    if (!alreadyInFlight) {
      inFlight.delete(name);
    }
  }
}
