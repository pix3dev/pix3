import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Color, Mesh, MeshBasicMaterial, Texture } from 'three';

import { Button2D, type Button2DProps } from './Button2D';
import { reactiveSchemaPropertyNames } from '../../../fw/reactive-schema-properties';
import { AudioService } from '../../../core/AudioService';
import { AssetLoader } from '../../../core/AssetLoader';
import { InputService } from '../../../core/InputService';
import { ResourceManager } from '../../../core/ResourceManager';
import { SceneLoader } from '../../../core/SceneLoader';
import { SceneSaver } from '../../../core/SceneSaver';
import { ScriptRegistry } from '../../../core/ScriptRegistry';

function createLoader(preloadTextures: string[] = []): SceneLoader {
  const assetLoader = new AssetLoader(new ResourceManager('/'), new AudioService());
  // Seed the texture cache so loadTexture() short-circuits before any network
  // fetch — res:// URLs 404 under happy-dom and would leak unhandled rejections.
  const cache = (assetLoader as unknown as { textureCache: Map<string, Texture> }).textureCache;
  for (const url of preloadTextures) {
    cache.set(url, new Texture());
  }
  return new SceneLoader(assetLoader, new ScriptRegistry(), new ResourceManager('/'));
}

function getButtonMaterial(button: Button2D): MeshBasicMaterial {
  return (button as unknown as { buttonMaterial: MeshBasicMaterial }).buttonMaterial;
}

function createButton(overrides: Partial<Button2DProps> = {}): {
  button: Button2D;
  input: InputService;
} {
  const button = new Button2D({ id: 'btn', name: 'Button', width: 80, height: 40, ...overrides });
  const input = new InputService();
  input.width = 200;
  input.height = 200;
  button.input = input;
  return { button, input };
}

// With input 200x200 and no scene, the logical camera size equals the input
// resolution, so screen (100,100) maps to world (0,0) — the button centre.
function hexOf(style: string): number {
  return new Color(style).getHex();
}

describe('Button2D skin state', () => {
  it('swaps flat state colors when no sprites are set', () => {
    const { button, input } = createButton({
      backgroundColor: '#101010',
      hoverColor: '#202020',
      pressedColor: '#303030',
    });
    const material = getButtonMaterial(button);

    expect(material.map).toBeNull();
    expect(material.color.getHex()).toBe(hexOf('#101010'));

    input.pointerPosition.set(100, 100);
    button.tick(1 / 60);
    expect(material.color.getHex()).toBe(hexOf('#202020'));

    input.isPointerDown = true;
    button.tick(1 / 60);
    expect(material.color.getHex()).toBe(hexOf('#303030'));

    input.isPointerDown = false;
    button.tick(1 / 60);
    expect(material.color.getHex()).toBe(hexOf('#202020'));

    input.pointerPosition.set(10, 10);
    button.tick(1 / 60);
    expect(material.color.getHex()).toBe(hexOf('#101010'));
  });

  it('shows the normal sprite and falls back to it for states without their own sprite', () => {
    const { button, input } = createButton();
    const material = getButtonMaterial(button);
    const normalTexture = new Texture();

    button.setStateTexture('normal', normalTexture);
    expect(material.map).toBe(normalTexture);
    expect(material.color.getHex()).toBe(hexOf('#ffffff'));

    // Hover with no hover sprite keeps the normal sprite.
    input.pointerPosition.set(100, 100);
    button.tick(1 / 60);
    expect(material.map).toBe(normalTexture);

    // A dedicated hover sprite wins while hovering.
    const hoverTexture = new Texture();
    button.setStateTexture('hover', hoverTexture);
    expect(material.map).toBe(hoverTexture);

    // Press with no pressed sprite falls back to the normal sprite.
    input.isPointerDown = true;
    button.tick(1 / 60);
    expect(material.map).toBe(normalTexture);

    // A dedicated pressed sprite wins while pressed.
    const pressedTexture = new Texture();
    button.setStateTexture('pressed', pressedTexture);
    expect(material.map).toBe(pressedTexture);
  });

  it('shows the disabled sprite while disabled and restores the normal sprite on re-enable', () => {
    const { button } = createButton();
    const material = getButtonMaterial(button);
    const normalTexture = new Texture();
    const disabledTexture = new Texture();
    button.setStateTexture('normal', normalTexture);
    button.setStateTexture('disabled', disabledTexture);

    expect(material.map).toBe(normalTexture);

    button.enabled = false;
    expect(material.map).toBe(disabledTexture);

    button.enabled = true;
    expect(material.map).toBe(normalTexture);
  });

  it('keeps the flat background color when disabled with no sprites', () => {
    const { button } = createButton({ backgroundColor: '#123456' });
    const material = getButtonMaterial(button);

    button.enabled = false;
    expect(material.map).toBeNull();
    expect(material.color.getHex()).toBe(hexOf('#123456'));
  });

  it('releases the virtual button when disabled mid-press', () => {
    const { button, input } = createButton({ buttonAction: 'Fire' });

    input.pointerPosition.set(100, 100);
    input.isPointerDown = true;
    button.tick(1 / 60);
    expect(input.getButton('Fire')).toBe(true);

    button.enabled = false;
    expect(input.getButton('Fire')).toBe(false);
  });

  it('clears a state sprite through the property schema back to the fallback', () => {
    const { button } = createButton();
    const material = getButtonMaterial(button);
    const normalTexture = new Texture();
    const hoverTexture = new Texture();
    button.setStateTexture('normal', normalTexture);
    button.setStateTexture('hover', hoverTexture);

    const schema = Button2D.getPropertySchema();
    const hoverProp = schema.properties.find(p => p.name === 'textureHover');
    expect(hoverProp).toBeDefined();

    hoverProp?.setValue(button, { type: 'texture', url: 'res://ui/hover.png' });
    expect(button.textureHover?.url).toBe('res://ui/hover.png');

    hoverProp?.setValue(button, { type: 'texture', url: '' });
    expect(button.textureHover).toBeNull();
    // Not hovering → resolves to the normal sprite.
    expect(material.map).toBe(normalTexture);
  });

  it('serializes and restores state sprite refs through the scene format', async () => {
    const button = new Button2D({
      id: 'save-btn',
      name: 'Save Button',
      width: 90,
      height: 30,
      textureNormal: { type: 'texture', url: 'res://ui/btn_normal.png' },
      texturePressed: 'res://ui/btn_pressed.png',
    });

    const saver = new SceneSaver();
    const yaml = saver.serializeScene({
      version: '1.0.0',
      metadata: {},
      rootNodes: [button],
      nodeMap: new Map([[button.nodeId, button]]),
    });

    expect(yaml).toContain('type: Button2D');
    expect(yaml).toContain('res://ui/btn_normal.png');
    expect(yaml).toContain('res://ui/btn_pressed.png');
    expect(yaml).not.toContain('textureHover');
    expect(yaml).not.toContain('textureDisabled');

    const graph = await createLoader([
      'res://ui/btn_normal.png',
      'res://ui/btn_pressed.png',
    ]).parseScene(yaml, { filePath: 'res://scenes/ui.pix3scene' });
    const loaded = graph.rootNodes[0] as Button2D;

    expect(loaded).toBeInstanceOf(Button2D);
    expect(loaded.textureNormal?.url).toBe('res://ui/btn_normal.png');
    expect(loaded.texturePressed?.url).toBe('res://ui/btn_pressed.png');
    expect(loaded.textureHover).toBeNull();
    expect(loaded.textureDisabled).toBeNull();
  });
});

describe('Button2D script assignments (reactive schema properties)', () => {
  const buttonMeshOf = (button: Button2D): Mesh =>
    (button as unknown as { buttonMesh: Mesh }).buttonMesh;

  it('rescales the drawn mesh when a script assigns width/height', () => {
    // The nastiest desync: isPointInBounds reads the fields, so a plain field write used to move
    // the hit area while the picture kept its old size.
    const { button } = createButton({ width: 80, height: 40 });
    const mesh = buttonMeshOf(button);
    expect(mesh.scale.x).toBe(80);

    button.width = 200;
    button.height = 60;

    expect(mesh.scale.x).toBe(200);
    expect(mesh.scale.y).toBe(60);
  });

  it('recolours the skin when a script assigns backgroundColor', () => {
    const { button } = createButton({ backgroundColor: '#101010' });
    const material = getButtonMaterial(button);

    button.backgroundColor = '#abcdef';

    expect(material.color.getHex()).toBe(hexOf('#abcdef'));
  });

  it('drops the stale loaded state texture when a script assigns a new ref', () => {
    const { button } = createButton();
    const material = getButtonMaterial(button);
    const normalTexture = new Texture();
    button.setStateTexture('normal', normalTexture);
    expect(material.map).toBe(normalTexture);

    // The old Texture no longer matches the ref; it must leave the screen immediately rather
    // than keep rendering until the next scene load.
    button.textureNormal = { type: 'texture', url: 'res://ui/other.png' };

    expect(button.textureNormal?.url).toBe('res://ui/other.png');
    expect(material.map).toBeNull();
  });

  it('keeps a cleared state texture ref readable as null', () => {
    // Guards the field/getValue split: the schema getValue substitutes `{url: ''}` for the
    // Inspector, but the field must stay null after a clear or SceneSaver (which checks the
    // field's truthiness) would serialize an empty ref.
    const { button } = createButton();
    button.textureNormal = { type: 'texture', url: 'res://ui/some.png' };
    expect(button.textureNormal?.url).toBe('res://ui/some.png');

    button.textureNormal = null;

    expect(button.textureNormal).toBeNull();
  });

  it('installs reactive accessors for every own schema field', () => {
    const { button } = createButton();
    const names = reactiveSchemaPropertyNames(button);
    for (const expected of [
      'width',
      'height',
      'backgroundColor',
      'hoverColor',
      'pressedColor',
      'buttonAction',
      'textureNormal',
      'textureHover',
      'texturePressed',
      'textureDisabled',
    ]) {
      expect(names.has(expected), `${expected} should be reactive`).toBe(true);
    }
    // The *Key props read/write stateTextureKeys entries, not own fields — nothing to install.
    expect(names.has('textureNormalKey')).toBe(false);
    // enabled/label are accessors on UIControl2D and must be left alone.
    expect(names.has('enabled')).toBe(false);
    expect(names.has('label')).toBe(false);
  });
});

describe('UIControl2D label reactivity', () => {
  /** The mesh only exists once a label has been rendered, so its presence IS the visual proof. */
  const labelMeshOf = (button: Button2D): unknown =>
    (button as unknown as { labelMesh: unknown }).labelMesh;

  // happy-dom has no 2D context, so label rendering throws unless stubbed — which is exactly why
  // this path had no coverage and the bug below shipped.
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

  beforeAll(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function stub(kind: string) {
      if (kind !== '2d') {
        return null;
      }
      return {
        setTransform: () => {},
        scale: () => {},
        fillRect: () => {},
        fillText: () => {},
        measureText: () => ({ width: 10 }),
        fillStyle: '',
        font: '',
        textAlign: 'center',
        textBaseline: 'middle',
      } as unknown as CanvasRenderingContext2D;
    } as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it('renders a label assigned from a script onto a control authored with none', () => {
    // The tic-tac-toe bug: cells ship with `label: ''`, a script assigns 'X', getDisplayText()
    // reported 'X' (so `game_observe.text` did too) and the canvas stayed empty because nothing
    // called updateLabel(). A plain assignment must now be enough.
    const { button } = createButton({ label: '' });
    expect(labelMeshOf(button)).toBeNull();

    button.label = 'X';

    expect(button.getDisplayText()).toBe('X');
    expect(labelMeshOf(button)).not.toBeNull();
  });

  it('rebuilds the texture when the label text changes', () => {
    const { button } = createButton({ label: 'X' });
    const first = (button as unknown as { labelTexture: unknown }).labelTexture;
    expect(first).not.toBeNull();

    button.label = 'O';

    expect((button as unknown as { labelTexture: unknown }).labelTexture).not.toBe(first);
  });

  it('does not rebuild anything when the same value is assigned again', () => {
    const { button } = createButton({ label: 'X', labelColor: '#ff0000' });
    const texture = (button as unknown as { labelTexture: unknown }).labelTexture;

    // A script assigning an unchanged label every frame must not churn canvas textures.
    button.label = 'X';
    button.labelColor = '#ff0000';

    expect((button as unknown as { labelTexture: unknown }).labelTexture).toBe(texture);
  });

  it('re-renders on labelColor / labelFontSize / labelAlign changes too', () => {
    const { button } = createButton({ label: 'X' });
    for (const mutate of [
      () => (button.labelColor = '#00ff00'),
      () => (button.labelFontSize = 48),
      () => (button.labelAlign = 'left'),
    ]) {
      const before = (button as unknown as { labelTexture: unknown }).labelTexture;
      mutate();
      expect((button as unknown as { labelTexture: unknown }).labelTexture).not.toBe(before);
    }
  });

  it('drops the mesh when the label is cleared', () => {
    const { button } = createButton({ label: 'X' });
    expect(labelMeshOf(button)).not.toBeNull();

    button.label = '';

    expect(labelMeshOf(button)).toBeNull();
  });
});
