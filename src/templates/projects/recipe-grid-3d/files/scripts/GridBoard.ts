/**
 * GridBoard — the block you carve.
 *
 * Builds a solid `sizeX × sizeY × sizeZ` grid of cubes under `boardAnchor` at start, then turns a
 * tap into the removal of one cube. Some cubes are secretly CORE: hitting one costs a life instead
 * of scoring. Clear every non-core cube to finish the board.
 *
 * It emits the semantic signals the rules script listens for, on `game-root`:
 *   `cell-cleared`  (remaining)
 *   `core-hit`      (remaining)
 *   `board-cleared` ()
 *
 * **Picking is a 3D raycast, not a 2D hit test.** 2D nodes are hit-tested against `Hitbox2D`
 * groups; a mesh in a perspective frustum has no such thing, so the contact comes from
 * `scene.raycastViewport(nx, ny)` with the pointer converted to normalized device coordinates. That
 * conversion is the part everyone gets wrong — Y is flipped, and the divisor is the INPUT surface
 * (`input.width/height`), not the window.
 *
 * **Mobile budget.** Every cube is a `GeometryMesh` with `material.type: 'lambert'`: this recipe
 * ships hundreds of them, and PBR on a phone at this count is the difference between a smooth board
 * and a slideshow. A 4×4×4 board is 64 draw calls — if you grow it past ~8³, move to an
 * `InstancedMesh3D` before you move to prettier materials.
 */
import { GeometryMesh, Script, type NodeBase, type PropertySchema } from '@pix3/runtime';

/** Cube metadata, kept in a map rather than on the node so nothing depends on node naming. */
interface Cell {
  node: GeometryMesh;
  isCore: boolean;
}

export class GridBoard extends Script {
  private cells = new Map<string, Cell>();
  private remaining = 0;
  private cleared = false;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      // Node the cubes are parented to (kept separate from game-root so clearing is one subtree).
      boardAnchor: 'board-anchor',
      sizeX: 4,
      sizeY: 4,
      sizeZ: 4,
      cellSize: 0.9,
      // Centre-to-centre spacing; > cellSize leaves visible seams between cubes.
      spacing: 1,
      // How many cubes are core (a life each). Never more than a third of the board.
      coreCount: 6,
      cellColor: '#3ee6c1',
      coreColor: '#ff6b6b',
      // Reveal core cubes in their own colour instead of hiding them (debug / tutorial).
      revealCores: false,
      clearSound: '',
      coreSound: '',
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, min: number, max: number, step: number) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Board', min, max, step, slider: true },
      getValue: (s: unknown) => (s as GridBoard).config[name],
      setValue: (s: unknown, v: unknown) => {
        const n = Number(v);
        (s as GridBoard).config[name] = Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
      },
    });
    const str = (name: string, label: string, group: string, editor?: 'audio-resource') => ({
      name,
      type: 'string' as const,
      ui: { label, group, ...(editor ? { editor } : {}) },
      getValue: (s: unknown) => (s as GridBoard).config[name],
      setValue: (s: unknown, v: unknown) => {
        (s as GridBoard).config[name] = typeof v === 'string' ? v : '';
      },
    });
    const color = (name: string, label: string) => ({
      name,
      type: 'color' as const,
      ui: { label, group: 'Look' },
      getValue: (s: unknown) => (s as GridBoard).config[name],
      setValue: (s: unknown, v: unknown) => {
        (s as GridBoard).config[name] = typeof v === 'string' ? v : '#ffffff';
      },
    });

    return {
      nodeType: 'GridBoard',
      properties: [
        str('boardAnchor', 'Board Anchor', 'Board'),
        num('sizeX', 'Size X', 1, 10, 1),
        num('sizeY', 'Size Y', 1, 10, 1),
        num('sizeZ', 'Size Z', 1, 10, 1),
        num('cellSize', 'Cell Size', 0.1, 3, 0.05),
        num('spacing', 'Spacing', 0.1, 4, 0.05),
        num('coreCount', 'Core Cubes', 0, 40, 1),
        color('cellColor', 'Cell Colour'),
        color('coreColor', 'Core Colour'),
        {
          name: 'revealCores',
          type: 'boolean' as const,
          ui: { label: 'Reveal Cores', group: 'Look' },
          getValue: (s: unknown) => (s as GridBoard).config.revealCores,
          setValue: (s: unknown, v: unknown) => {
            (s as GridBoard).config.revealCores = Boolean(v);
          },
        },
        str('clearSound', 'Clear Sound', 'Feedback', 'audio-resource'),
        str('coreSound', 'Core Sound', 'Feedback', 'audio-resource'),
      ],
      groups: {
        Board: { label: 'Board', expanded: true },
        Look: { label: 'Look', expanded: true },
        Feedback: { label: 'Feedback', expanded: false },
      },
    };
  }

  onStart(): void {
    this.build();
  }

  /**
   * One removal per finger that landed this frame.
   *
   * Taps over the HUD are ignored the same way every recipe does it, so a thumb parked on a button
   * cannot carve the board underneath it.
   */
  onUpdate(): void {
    const input = this.input;
    if (this.cleared || !input || !this.scene) {
      return;
    }
    for (const event of input.pointerEvents) {
      if (event.type !== 'down') {
        continue;
      }
      const overUI =
        input.pointerDownCount > 0 ? input.isPointerOverUI(event.pointerId) : input.isHoveringUI;
      if (overUI) {
        continue;
      }
      this.resolveTap(event.x, event.y);
    }
  }

  /** Live board state, for the rules script and for tests. */
  getRemaining(): number {
    return this.remaining;
  }

  private build(): void {
    const anchor = this.findAnchor();
    if (!anchor) {
      console.warn('[GridBoard] No board anchor node — nothing was built.');
      return;
    }
    const sizeX = this.intConfig('sizeX', 1, 10);
    const sizeY = this.intConfig('sizeY', 1, 10);
    const sizeZ = this.intConfig('sizeZ', 1, 10);
    const cellSize = Math.max(0.1, Number(this.config.cellSize) || 0.9);
    const spacing = Math.max(cellSize, Number(this.config.spacing) || 1);
    const total = sizeX * sizeY * sizeZ;
    // A board that is mostly core is not a puzzle, it is a minefield.
    const coreCount = Math.min(this.intConfig('coreCount', 0, 40), Math.floor(total / 3));
    const coreKeys = this.pickCoreKeys(sizeX, sizeY, sizeZ, coreCount);
    const reveal = Boolean(this.config.revealCores);
    const cellColor = String(this.config.cellColor ?? '#3ee6c1');
    const coreColor = String(this.config.coreColor ?? '#ff6b6b');

    // Centre the board on the anchor so the camera framing survives a size change.
    const offset = (n: number) => ((n - 1) * spacing) / 2;

    for (let x = 0; x < sizeX; x++) {
      for (let y = 0; y < sizeY; y++) {
        for (let z = 0; z < sizeZ; z++) {
          const key = `${x},${y},${z}`;
          const isCore = coreKeys.has(key);
          const cube = new GeometryMesh({
            id: `cell-${key}`,
            name: `Cell ${key}`,
            geometry: 'box',
            size: [cellSize, cellSize, cellSize],
            material: {
              type: 'lambert',
              color: isCore && reveal ? coreColor : cellColor,
            },
          });
          cube.position.set(
            x * spacing - offset(sizeX),
            y * spacing - offset(sizeY),
            z * spacing - offset(sizeZ)
          );
          anchor.add(cube);
          this.cells.set(key, { node: cube, isCore });
        }
      }
    }
    this.remaining = total - coreCount;
    this.node?.emit('board-built', this.remaining, coreCount);
  }

  /**
   * Resolve one contact against the board.
   *
   * The hit object is a three.js `Mesh` inside the cube node, so walk up to the `GeometryMesh` the
   * cell map is keyed by — the raycaster reports what it struck, not what owns it.
   */
  private resolveTap(screenX: number, screenY: number): void {
    const scene = this.scene;
    const input = this.input;
    if (!scene || !input) {
      return;
    }
    const width = input.width;
    const height = input.height;
    if (!(width > 0) || !(height > 0)) {
      return;
    }
    const hit = scene.raycastViewport((screenX / width) * 2 - 1, 1 - (screenY / height) * 2);
    if (!hit) {
      return;
    }
    const entry = this.findCell(hit.node);
    if (!entry) {
      return;
    }
    this.removeCell(entry[0], entry[1]);
  }

  private removeCell(key: string, cell: Cell): void {
    this.cells.delete(key);
    const owner = this.node;
    if (cell.isCore) {
      this.scene?.juice.flash({ color: '#ff4d6d', intensity: 0.45, durationSec: 0.22 });
      this.playSound(String(this.config.coreSound ?? ''));
      cell.node.queueFree();
      owner?.emit('core-hit', this.remaining);
      return;
    }
    this.remaining = Math.max(0, this.remaining - 1);
    this.scene?.juice.punchScale(cell.node, { amount: 0.35, duration: 0.16 });
    this.playSound(String(this.config.clearSound ?? ''));
    cell.node.queueFree();
    owner?.emit('cell-cleared', this.remaining);
    if (this.remaining === 0 && !this.cleared) {
      this.cleared = true;
      owner?.emit('board-cleared');
    }
  }

  /** Walk from the raycast hit up to the cube node this board owns. */
  private findCell(hitNode: NodeBase): [string, Cell] | null {
    let current: NodeBase | null = hitNode;
    while (current) {
      for (const [key, cell] of this.cells) {
        if (cell.node === current) {
          return [key, cell];
        }
      }
      current = (current.parent as NodeBase | null) ?? null;
    }
    return null;
  }

  private findAnchor(): NodeBase | null {
    const name = String(this.config.boardAnchor ?? '').trim();
    if (!name) {
      return this.node ?? null;
    }
    // `findNode` is the Script helper (scene-global by name/id), the same one Spawner uses.
    return this.findNode(name) ?? this.node ?? null;
  }

  /**
   * Choose which cubes are core.
   *
   * Cores are drawn from the INTERIOR when the board has one: a core on the surface can be tapped
   * before the player has learned anything, which reads as an unfair loss rather than a puzzle.
   * Small boards have no interior, so they fall back to the whole set.
   */
  private pickCoreKeys(sizeX: number, sizeY: number, sizeZ: number, count: number): Set<string> {
    const interior: string[] = [];
    const all: string[] = [];
    for (let x = 0; x < sizeX; x++) {
      for (let y = 0; y < sizeY; y++) {
        for (let z = 0; z < sizeZ; z++) {
          const key = `${x},${y},${z}`;
          all.push(key);
          const inner =
            x > 0 && x < sizeX - 1 && y > 0 && y < sizeY - 1 && z > 0 && z < sizeZ - 1;
          if (inner) {
            interior.push(key);
          }
        }
      }
    }
    const pool = interior.length >= count ? interior : all;
    const chosen = new Set<string>();
    while (chosen.size < count && chosen.size < pool.length) {
      chosen.add(pool[Math.floor(Math.random() * pool.length)]);
    }
    return chosen;
  }

  private intConfig(name: string, min: number, max: number): number {
    const value = Math.round(Number(this.config[name]));
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  }

  private playSound(path: string): void {
    if (!path) {
      return;
    }
    void this.scene?.audio.play(path, { bus: 'sfx', pitchVariation: 0.08 });
  }
}
