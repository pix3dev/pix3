import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
} from 'three';

/**
 * Hardcoded procedural test models for Model Lab's Phase-1 scaffold. These stand in for the
 * LLM-generated factories the pipeline will emit later, and exist to prove the whole non-LLM
 * chain end-to-end: build a `THREE.Group` from primitives + standard materials + a canvas
 * texture → preview it → export to GLB → save into the project → load via a `MeshInstance`.
 *
 * Each factory returns a self-contained `Group` with a modest `userData.sculptRuntime` block so
 * the GLB `extras` round-trip is exercised too. Everything here uses only GLB-safe constructs
 * (MeshStandardMaterial, canvas textures) — the same contract generated code must follow.
 */
export interface TestModelDefinition {
  id: string;
  label: string;
  build: () => Group;
}

export const TEST_MODELS: readonly TestModelDefinition[] = [
  { id: 'chest', label: 'Loot Chest', build: buildChest },
  { id: 'cog', label: 'Brass Cog', build: buildCog },
  { id: 'droid', label: 'Capsule Droid', build: buildDroid },
];

export function buildTestModel(id: string): Group {
  const definition = TEST_MODELS.find(model => model.id === id) ?? TEST_MODELS[0];
  const group = definition.build();
  group.name = definition.label;
  group.userData.sculptRuntime = {
    generator: 'model-lab-test',
    modelId: definition.id,
    sockets: {},
  };
  return group;
}

function buildChest(): Group {
  const group = new Group();

  const woodTexture = makeNoiseTexture('#6a4423', '#42280f');
  const woodMaterial = new MeshStandardMaterial({ map: woodTexture, roughness: 0.8, metalness: 0 });
  const goldMaterial = new MeshStandardMaterial({
    color: 0xf6c453,
    roughness: 0.3,
    metalness: 0.9,
  });

  const base = new Mesh(new BoxGeometry(1.6, 0.9, 1), woodMaterial);
  base.position.y = 0.45;
  group.add(base);

  const lid = new Mesh(new BoxGeometry(1.62, 0.5, 1.02), woodMaterial);
  lid.position.y = 1.05;
  group.add(lid);

  // Gold trim bands.
  for (const z of [-0.42, 0.42]) {
    const band = new Mesh(new BoxGeometry(1.68, 1.5, 0.08), goldMaterial);
    band.position.set(0, 0.75, z);
    group.add(band);
  }

  const lock = new Mesh(new BoxGeometry(0.24, 0.3, 0.1), goldMaterial);
  lock.position.set(0, 0.8, 0.52);
  group.add(lock);

  return group;
}

function buildCog(): Group {
  const group = new Group();
  const brass = new MeshStandardMaterial({ color: 0xc08a3e, roughness: 0.35, metalness: 0.85 });

  const hub = new Mesh(new CylinderGeometry(0.35, 0.35, 0.4, 24), brass);
  hub.rotation.x = Math.PI / 2;
  group.add(hub);

  const ring = new Mesh(new TorusGeometry(0.7, 0.16, 12, 32), brass);
  group.add(ring);

  // Instanced teeth around the ring.
  const toothCount = 12;
  const toothGeometry = new BoxGeometry(0.18, 0.28, 0.34);
  for (let i = 0; i < toothCount; i++) {
    const angle = (i / toothCount) * Math.PI * 2;
    const tooth = new Mesh(toothGeometry, brass);
    tooth.position.set(Math.cos(angle) * 0.86, Math.sin(angle) * 0.86, 0);
    tooth.rotation.z = angle;
    group.add(tooth);
  }

  return group;
}

function buildDroid(): Group {
  const group = new Group();
  const shell = new MeshStandardMaterial({ color: 0xdfe6ec, roughness: 0.4, metalness: 0.2 });
  const accent = new MeshStandardMaterial({
    color: 0x33c2ff,
    roughness: 0.2,
    metalness: 0.1,
    emissive: 0x0a4a66,
    emissiveIntensity: 0.6,
  });

  const body = new Mesh(new CylinderGeometry(0.45, 0.55, 1.1, 24), shell);
  body.position.y = 0.75;
  group.add(body);

  const head = new Mesh(new SphereGeometry(0.5, 24, 16), shell);
  head.position.y = 1.5;
  group.add(head);

  const eye = new Mesh(new SphereGeometry(0.16, 16, 12), accent);
  eye.position.set(0, 1.55, 0.42);
  group.add(eye);

  for (const x of [-0.55, 0.55]) {
    const arm = new Mesh(new CylinderGeometry(0.08, 0.08, 0.7, 12), shell);
    arm.position.set(x, 0.85, 0);
    arm.rotation.z = x < 0 ? 0.4 : -0.4;
    group.add(arm);
  }

  return group;
}

/** A small procedural noise texture (canvas) — proves embedded textures survive GLB export. */
function makeNoiseTexture(base: string, speck: string): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = speck;
    // Deterministic speckle pattern (no Math.random so exports are reproducible).
    for (let i = 0; i < 900; i++) {
      const x = (i * 53) % size;
      const y = (i * 97) % size;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
