# Plan: Hybrid ECS Infrastructure for `pix3-runtime`

## Summary
`pix3-runtime` stays scene-graph-first, but gains an explicit ECS bridge for high-volume dynamic simulation. The scene tree remains responsible for visibility, transforms, serialization, parenting, and editor/debug affordances; ECS remains project-owned and drives bulk data into engine primitives through stable runtime APIs.

The base design adds three pillars:

1. `InstancedMesh3D` as a `Node3D` wrapper over `THREE.InstancedMesh`, optimized for direct bulk writes from ECS-owned typed arrays.
2. `ECSService` as a runtime lifecycle coordinator that runs ECS systems in `update` and `fixedUpdate` phases alongside the existing `SceneRunner` loop.
3. Raycast hit contracts that preserve the node hit, but also surface `instanceId` when the underlying hit came from an instanced mesh.

This keeps game-specific ECS choices outside the engine while giving projects a fast, predictable bridge into rendering and input/debug tooling.

## File Structure
Add the following files under `packages/pix3-runtime/src`:

- `nodes/3D/InstancedMesh3D.ts`
- `core/ecs.ts`
- `core/ECSService.ts`
- `core/raycast.ts`

Extend existing files:

- `core/SceneRunner.ts`
- `core/SceneLoader.ts`
- `core/SceneSaver.ts`
- `core/SceneService.ts`
- `core/InputService.ts` or keep input raw and expose raycast through `SceneService`
- `index.ts`

Recommended responsibility split:

- `InstancedMesh3D.ts`: node class, GPU buffer upload API, instance bookkeeping, dirty flags.
- `ecs.ts`: public ECS-facing contracts only.
- `ECSService.ts`: world registration, tick scheduling, fixed-step loop, scene lifecycle reset/dispose.
- `raycast.ts`: reusable hit/result types used by runtime and editor/debug integrations.

## Public API Draft

### ECS lifecycle contracts
```ts
export type ECSPhase = 'update' | 'fixedUpdate';

export interface ECSUpdateContext {
  readonly dt: number;
  readonly time: number;
  readonly frame: number;
  readonly fixedTimeStep: number;
  readonly alpha: number;
  readonly scene: SceneService;
  readonly input: InputService;
}

export interface ECSSystem {
  readonly id?: string;
  readonly phase: ECSPhase;
  update(context: ECSUpdateContext): void;
}

export interface ECSWorldAdapter<TWorld = unknown> {
  readonly world: TWorld;
  initialize?(context: ECSUpdateContext): void;
  dispose?(): void;
}

export interface ECSServiceOptions {
  fixedTimeStep?: number;      // default 1 / 60
  maxFixedStepsPerFrame?: number; // default 4
}

export interface ECSRegistration<TWorld = unknown> {
  world: ECSWorldAdapter<TWorld>;
  systems: readonly ECSSystem[];
}
```

### ECS runtime service
```ts
export class ECSService {
  constructor(options?: ECSServiceOptions);

  registerWorld<TWorld>(registration: ECSRegistration<TWorld>): () => void;
  clear(): void;
  dispose(): void;

  beginScene(scene: SceneService, input: InputService): void;
  endScene(): void;

  update(dt: number): void;
  fixedUpdate(dt: number): void;
}
```

### Instancing contracts
```ts
export interface InstancedMesh3DProps extends Omit<Node3DProps, 'type'> {
  maxInstances: number;
  geometry?: BufferGeometry;
  material?: Material | Material[];
  castShadow?: boolean;
  receiveShadow?: boolean;
  enablePerInstanceColor?: boolean;
  frustumCulled?: boolean; // default false for moving crowds unless caller opts in
}

export interface InstanceTransformArrayView {
  readonly count: number;
  readonly positions?: Float32Array;   // xyz stride = 3
  readonly rotations?: Float32Array;   // quaternion xyzw stride = 4
  readonly scales?: Float32Array;      // xyz stride = 3
}

export interface InstanceColorArrayView {
  readonly count: number;
  readonly colors: Float32Array;       // rgb stride = 3, linear floats 0..1
}

export interface InstanceMatrixArrayView {
  readonly count: number;
  readonly matrices: Float32Array;     // mat4 stride = 16
}

export interface InstancedWriteOptions {
  markTransformDirty?: boolean; // default true
  markColorDirty?: boolean;     // default true
  computeBoundingSphere?: boolean; // default false
  visibleCount?: number;        // overrides mesh.count
}

export interface InstancedMeshRaycastHit {
  node: InstancedMesh3D;
  object: InstancedMesh;
  instanceId: number;
  distance: number;
  point: Vector3;
}

export class InstancedMesh3D extends Node3D {
  readonly mesh: InstancedMesh;
  readonly maxInstances: number;

  get visibleInstanceCount(): number;
  set visibleInstanceCount(value: number);

  setGeometry(geometry: BufferGeometry): void;
  setMaterial(material: Material | Material[]): void;

  writeMatrices(data: InstanceMatrixArrayView, options?: InstancedWriteOptions): void;
  writeTransforms(data: InstanceTransformArrayView, options?: InstancedWriteOptions): void;
  writeColors(data: InstanceColorArrayView, options?: InstancedWriteOptions): void;

  markTransformsDirty(): void;
  markColorsDirty(): void;
  flush(): void;
  clearInstances(): void;

  getInstanceMatrixBuffer(): Float32Array;
  getInstanceColorBuffer(): Float32Array | null;
}
```

### Raycast contracts
```ts
export interface SceneRaycastHit {
  node: NodeBase;
  distance: number;
  point: Vector3;
  object: Object3D;
  instanceId?: number;
}

export interface SceneRaycaster {
  raycastViewport(normalizedX: number, normalizedY: number): SceneRaycastHit | null;
}
```

### Scene service additions
```ts
export interface SceneServiceDelegate {
  // existing methods...
  raycastViewport(normalizedX: number, normalizedY: number): SceneRaycastHit | null;
  getECSService(): ECSService | null;
}

export class SceneService {
  raycastViewport(normalizedX: number, normalizedY: number): SceneRaycastHit | null;
  getECSService(): ECSService | null;
}
```

## Implementation Tasks

### Task 1. Add reusable raycast result types
Create `core/raycast.ts` with engine-level hit contracts, not editor-only types.

Pay attention to:
- `instanceId` must be optional for backward compatibility.
- Keep result immutable-by-convention; construct fresh result objects only at API boundaries.
- Avoid leaking raw `THREE.Intersection` outside the engine API.

### Task 2. Implement `InstancedMesh3D`
Create a new `Node3D` subclass that owns exactly one `THREE.InstancedMesh` child or directly wraps one internally.

Implementation decisions:
- `InstancedMesh3D` should expose `mesh: InstancedMesh` for advanced users.
- Constructor requires `maxInstances`.
- Internally allocate reusable CPU-side buffers:
  - `Float32Array(maxInstances * 16)` for matrices.
  - optional `Float32Array(maxInstances * 3)` for colors.
- Default `mesh.count = 0`; ECS sets visible count explicitly.
- Default `frustumCulled = false` unless caller opts in, because instanced crowds often move every frame and broad culling becomes incorrect unless bounds are maintained.
- Store dirty flags:
  - `transformsDirty`
  - `colorsDirty`
  - `boundsDirty`
- `flush()` uploads only dirty ranges/attributes and clears flags.

Pay attention to:
- No per-frame temporary `Matrix4`, `Vector3`, `Quaternion`, `Color` allocation inside bulk loops.
- Reuse module-level scratch objects only when unavoidable.
- Clamp `count` to `maxInstances`; throw in dev-facing API when input exceeds capacity.
- When `enablePerInstanceColor` is false, `writeColors` should either throw or no-op with warning; choose throw for deterministic misuse detection.
- Keep `mesh.instanceMatrix.needsUpdate` and `mesh.instanceColor.needsUpdate` writes centralized in `flush()`.

### Task 3. Define the bulk write format
Support two write paths:

1. `writeMatrices()`
- Fastest path for ECS frameworks already producing packed `mat4`.
- Copy packed matrices into the internal matrix buffer.
- Use direct `Float32Array.set()` when source shape matches destination.

2. `writeTransforms()`
- Ergonomic path for SoA ECS data:
  - `positions`: `xyz`
  - `rotations`: quaternion `xyzw`
  - `scales`: `xyz`
- Compose matrices into the internal buffer using reused scratch `Vector3`, `Quaternion`, `Vector3`, `Matrix4`.

Decisions:
- Use quaternion rotation input, not Euler, for the ECS API.
- Allow missing `rotations` and `scales`; default to identity rotation and unit scale.
- `visibleCount` updates `mesh.count` without reallocating buffers.

Pay attention to:
- Document stride contracts clearly.
- Never resize buffers after construction; capacity changes require creating a new node.
- Optionally expose `getInstanceMatrixBuffer()` for zero-copy producer workflows.

### Task 4. Integrate `InstancedMesh3D` into scene loading/saving
Extend `SceneLoader` and `SceneSaver` so the node is serializable like other runtime nodes.

Scene properties to persist:
- `maxInstances`
- `castShadow`
- `receiveShadow`
- `enablePerInstanceColor`
- optional resource references for geometry/material only if the runtime already has a neutral way to express them
- do not serialize per-frame ECS instance payloads

Decision:
- For v1, persist only node-level config, not runtime instance arrays.
- If there is no stable generic asset contract for arbitrary geometry/material yet, use a minimal constructor path with engine-created placeholder geometry/material and allow scripts to swap them at runtime.

Pay attention to:
- `maxInstances` must be positive integer validation.
- Property schema should expose only stable, editor-safe config.

### Task 5. Add `ECSService`
Introduce a dedicated service instead of hiding ECS orchestration inside a node. `SceneRunner` owns one `ECSService` instance and resets it per running scene.

Lifecycle model:
- `beginScene()` when runtime scene starts.
- `update(dt)` once per animation frame before node tree `tick(dt)`.
- `fixedUpdate(fixedTimeStep)` zero or more times per frame before the variable `update`, using an accumulator.
- `endScene()` and `dispose()` on stop.

Scheduling decision:
- Order per frame:
  1. `input.beginFrame()`
  2. accumulate fixed step time
  3. run `fixedUpdate` systems
  4. run variable `update` systems
  5. tick scene-tree nodes/scripts
  6. flush pending instanced nodes
  7. render
- This order lets ECS write transforms first, then regular scripts consume updated scene state if needed, then rendering sees flushed GPU data.

Pay attention to:
- Clamp the fixed-step catch-up loop with `maxFixedStepsPerFrame`.
- Preserve deterministic `fixedUpdate` timestep.
- Keep frame/time counters in `ECSUpdateContext`.
- `registerWorld()` returns unsubscribe to support hot-reload or scene-local setup.

### Task 6. Expose ECS to game code through `SceneService`
Projects need a runtime-owned access point without depending directly on `SceneRunner`.

Add:
- `SceneService.getECSService()`
- optional helper `SceneService.raycastViewport()`

Decision:
- Keep world creation in user game scripts, not in scene YAML.
- A project bootstrap script or autoload script can call:
  - `const ecs = this.scene?.getECSService()`
  - `ecs?.registerWorld({ world, systems })`

Pay attention to:
- `SceneService` should never own ECS logic itself; only broker access.
- Null-safe access when scene not running.

### Task 7. Make `SceneRunner` fixed-step aware
Extend the existing loop with:
- `fixedTimeAccumulator`
- `elapsedTime`
- `frameNumber`

Add `flushInstancedNodes()` after updates:
- traverse runtime graph
- find all `InstancedMesh3D`
- call `flush()` only on dirty nodes

Decision:
- Do not auto-flush during each `write*()` call; leave it batched until end of frame.
- Keep fixed-step state inside `SceneRunner`; `ECSService` remains scheduling-aware but stateless regarding RAF.

Pay attention to:
- Avoid recursive allocations during traversal; iterative stack is fine.
- On `stop()`, clear accumulator and ECS registrations for clean next-run semantics.

### Task 8. Extend runtime raycasting to preserve `instanceId`
Where runtime/editor raycasting currently converts intersections to `NodeBase`, upgrade the logic to return `SceneRaycastHit`.

Rules:
- If `intersection.instanceId` is a number and the hit object belongs to `InstancedMesh3D`, populate it.
- `node` should still be the owning `InstancedMesh3D` node.
- Existing consumers that only need `node` can keep working by reading `hit.node`.

Decision:
- `SceneService.raycastViewport()` becomes the engine-stable API.
- Editor-side selection can continue selecting the node, while debug UI/inspector can optionally show `instanceId`.

Pay attention to:
- The actual `THREE.Intersection.object` may be the internal `InstancedMesh`, not the outer node; walk parents until a `NodeBase` is found.
- Preserve 2D/3D raycast priority rules already in the engine.
- Do not break non-instanced hits.

### Task 9. Add property schema for `InstancedMesh3D`
Expose only stable node-level settings in inspector/runtime metadata:
- `maxInstances` as read-only after creation
- `castShadow`
- `receiveShadow`
- `enablePerInstanceColor`
- maybe `visibleInstanceCount` as runtime/debug info, hidden from serialized authoring if needed

Pay attention to:
- `maxInstances` should be effectively immutable because reallocating GPU buffers changes object identity and capacity assumptions.
- Keep schema aligned with `SceneSaver`.

### Task 10. Export and document the runtime API
Update `index.ts` exports:
- `InstancedMesh3D`
- `ECSService`
- all ECS contracts
- raycast types

Update `packages/pix3-runtime/README.md` minimally:
- one section for hybrid ECS usage
- one section for instanced rendering
- no game-specific examples

## Test Plan

### Runtime unit tests
- `InstancedMesh3D` initializes with `maxInstances`, zero visible count, and correct buffer sizes.
- `writeMatrices()` copies bulk data without reallocating buffers.
- `writeTransforms()` composes correct matrices from SoA inputs.
- `flush()` toggles `instanceMatrix.needsUpdate` and `instanceColor.needsUpdate` only when dirty.
- `visibleInstanceCount` clamps or rejects invalid values.
- `writeColors()` fails predictably when per-instance color support is disabled.
- `clearInstances()` resets visible count without releasing buffers.

### ECS lifecycle tests
- `ECSService.update()` runs only `update` systems.
- `ECSService.fixedUpdate()` runs only `fixedUpdate` systems.
- `SceneRunner` executes multiple fixed ticks on large `dt` but respects `maxFixedStepsPerFrame`.
- `beginScene()`/`endScene()` fully reset frame counters and registrations.
- unregister callback from `registerWorld()` removes systems cleanly.

### Raycast tests
- normal mesh hit returns `SceneRaycastHit` without `instanceId`.
- `InstancedMesh3D` hit returns owning node plus exact `instanceId`.
- parent walk from internal `THREE.InstancedMesh` resolves to `InstancedMesh3D`.
- legacy selection path can still derive the node from a hit.

### Integration tests
- a scene containing `InstancedMesh3D` loads from YAML and starts with no runtime payload.
- ECS system writes transforms for N instances, `flush()` uploads once, renderer sees `mesh.count === N`.
- scene stop/start does not leak ECS registrations or stale instance buffers.

## Usage Example
```ts
import {
  Script,
  InstancedMesh3D,
  ECSService,
  type ECSSystem,
} from '@pix3/runtime';
import { BoxGeometry, MeshStandardMaterial } from 'three';

class CrowdBootstrap extends Script {
  private positions = new Float32Array(10_000 * 3);
  private rotations = new Float32Array(10_000 * 4);
  private scales = new Float32Array(10_000 * 3);
  private colors = new Float32Array(10_000 * 3);

  override onStart(): void {
    const instanced = new InstancedMesh3D({
      id: 'crowd',
      name: 'Crowd',
      maxInstances: 10_000,
      enablePerInstanceColor: true,
      geometry: new BoxGeometry(1, 1, 1),
      material: new MeshStandardMaterial(),
    });

    this.node?.adoptChild(instanced);

    const ecs = this.scene?.getECSService();
    if (!ecs) return;

    const movementSystem: ECSSystem = {
      phase: 'fixedUpdate',
      update: ({ dt }) => {
        // game-owned ECS writes into typed arrays here
        // positions[i * 3 + 0] = ...
        // rotations[i * 4 + 0] = ...
        // scales[i * 3 + 0] = ...
      },
    };

    const renderSyncSystem: ECSSystem = {
      phase: 'update',
      update: () => {
        instanced.writeTransforms({
          count: 10_000,
          positions: this.positions,
          rotations: this.rotations,
          scales: this.scales,
        }, {
          visibleCount: 10_000,
        });

        instanced.writeColors({
          count: 10_000,
          colors: this.colors,
        });
      },
    };

    ecs.registerWorld({
      world: { world: {/* project ECS world */} },
      systems: [movementSystem, renderSyncSystem],
    });
  }
}
```

## Assumptions
- `pix3-runtime` is responsible only for ECS orchestration hooks and rendering bridges, not for providing an ECS storage/query implementation.
- `InstancedMesh3D` v1 targets transform and color streaming only; per-instance custom attributes can be a later extension.
- Quaternion rotation is the ECS-facing transform format for bulk APIs.
- Runtime raycasting should return richer hit data, while existing higher-level selection can remain node-based.
- `maxInstances` is immutable after construction.
- Bulk data upload is end-of-frame batched through `flush()`, not immediate on every write.
