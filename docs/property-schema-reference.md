# Property Schema Reference

Godot-inspired system that lets node and `Script` classes declare their editable
properties once; the Inspector, animation timeline, clip evaluator, prefab diffing
and `UpdateObjectPropertyOperation` all render/drive from that single declaration.

**Read only the section you need:**

- Adding a property to a node/script → **Recipes** (below).
- The `PropertyDefinition` / `PropertyUIHints` shape → **Structure**.
- Why per-instance props (e.g. shader effects) show up automatically → **The funnel rule**.
- Editing goes through the mutation gateway (`UpdateObjectPropertyOperation`) — see `AGENTS.md`.

**Source of truth (code):**
`packages/pix3-runtime/src/fw/property-schema.ts` (types + `defineProperty`, `defineGroup`,
`mergeSchemas`) and `packages/pix3-runtime/src/fw/property-schema-utils.ts`
(`getNodePropertySchema`, `getPropertiesByGroup`, `getPropertyDisplayValue`,
`validatePropertyValue`, `setNodePropertyValue`). When this doc and the code disagree, the code wins.

---

## Recipes

### Add properties to a node (or `Script`) class

Implement `static getPropertySchema()` and spread the parent schema so inherited
properties/groups carry through:

```typescript
static getPropertySchema(): PropertySchema {
  const base = Node2D.getPropertySchema(); // or NodeBase / Node3D / your parent
  return {
    nodeType: 'CustomNode',
    extends: 'Node2D',
    properties: [
      ...base.properties,
      {
        name: 'speed',
        type: 'number',
        ui: { label: 'Speed', group: 'Behavior', min: 0, max: 10, step: 0.1, precision: 1 },
        getValue: (node) => (node as CustomNode).speed,
        setValue: (node, value) => { (node as CustomNode).speed = Number(value); },
      },
    ],
    groups: { ...base.groups, Behavior: { label: 'Behavior', expanded: false } },
  };
}
```

### Common property shapes

```typescript
// 2D position component
{ name: 'position.x', type: 'number', ui: { label: 'X', group: 'Transform', step: 0.01, precision: 2 },
  getValue: (n) => (n as Node2D).position.x,
  setValue: (n, v) => { (n as Node2D).position.x = Number(v); } }

// Rotation stored in radians, edited in degrees
{ name: 'rotation.z', type: 'number', ui: { label: 'Rotation', group: 'Transform', unit: '°', step: 0.1, precision: 1 },
  getValue: (n) => (n as Node2D).rotation.z * (180 / Math.PI),
  setValue: (n, v) => { (n as Node2D).rotation.z = Number(v) * (Math.PI / 180); } }

// Boolean → checkbox
{ name: 'visible', type: 'boolean', ui: { label: 'Visible', group: 'Display' },
  getValue: (n) => (n as NodeBase).visible,
  setValue: (n, v) => { (n as NodeBase).visible = Boolean(v); } }

// String → text input
{ name: 'texturePath', type: 'string', ui: { label: 'Texture', group: 'Rendering' },
  getValue: (n) => (n as Sprite2D).texturePath ?? '',
  setValue: (n, v) => { (n as Sprite2D).texturePath = String(v) || null; } }
```

`defineProperty(...)` / `defineGroup(...)` in `property-schema.ts` are typed builders for the
same objects; `mergeSchemas(base, extended)` is the helper the spread above does by hand.

---

## Structure

`PropertyType` union: `'string' | 'number' | 'boolean' | 'vector2' | 'vector3' | 'euler' | 'color' | 'enum' | 'object'` (authoritative list in `property-schema.ts`).

```typescript
interface PropertyDefinition {
  name: string;                     // property key, dotted for components (e.g. "position.x")
  type: PropertyType;
  ui?: PropertyUIHints;
  validation?: PropertyValidation;  // { validate(value): boolean | string; transform?(value): value }
  defaultValue?: unknown;
  getValue: (node) => unknown;      // read from the live node instance
  setValue: (node, value) => void;  // write to the live node instance
}

interface PropertyUIHints {
  label?: string; description?: string; group?: string;
  min?: number; max?: number; step?: number; precision?: number;
  unit?: string;                    // "°", "px", "ms", …
  options?: string[] | Record<string, unknown>; // enum
  slider?: boolean; hidden?: boolean; readOnly?: boolean;
  colorFormat?: 'hex' | 'rgb' | 'rgba';
}

interface PropertySchema {
  nodeType: string;
  extends?: string;
  properties: PropertyDefinition[];
  groups?: Record<string, { label: string; expanded?: boolean }>;
}
```

Inspector behaviour: groups render Base-first then the rest; `number` → number input +
unit, `boolean` → checkbox, `string` → text input, others fall back to text. User input →
`UpdateObjectPropertyOperation` → `OperationService` (undoable); on validation error the UI
reverts to the node's current value.

---

## The funnel rule (the one fragile spot)

Any code that needs a node's **full** schema MUST call
`getNodePropertySchema(node)` — **never** `node.constructor.getPropertySchema()` directly.

`getNodePropertySchema` returns the static class schema **merged** with any per-instance
contribution from `InstancePropertySchemaProvider.getInstancePropertySchema()` (e.g. properties
of attached shader effects). Because every consumer — inspector, animation timeline, clip
evaluator, `UpdateObjectPropertyOperation`, `SceneRunner`'s live-property sink, prefab diffing —
funnels through it, instance props become editable, keyframe-animatable, undoable, and
prefab-diffable with zero per-call-site work. Calling the static method directly silently
drops those instance contributions.
