import { NodeBase } from '@pix3/runtime';
import { Node2D } from '@pix3/runtime';
import { Node3D } from '@pix3/runtime';
import { Sprite2D } from '@pix3/runtime';
import { TiledSprite2D } from '@pix3/runtime';
import { Group2D } from '@pix3/runtime';
import { CanvasLayer2D } from '@pix3/runtime';
import { Camera2D } from '@pix3/runtime';
import { Joystick2D } from '@pix3/runtime';
import { Button2D } from '@pix3/runtime';
import { Label2D } from '@pix3/runtime';
import { Slider2D } from '@pix3/runtime';
import { Bar2D } from '@pix3/runtime';
import { Checkbox2D } from '@pix3/runtime';
import { InventorySlot2D } from '@pix3/runtime';
import { Camera3D } from '@pix3/runtime';
import { DirectionalLightNode } from '@pix3/runtime';
import { PointLightNode } from '@pix3/runtime';
import { SpotLightNode } from '@pix3/runtime';
import { AmbientLightNode } from '@pix3/runtime';
import { HemisphereLightNode } from '@pix3/runtime';
import { MeshInstance } from '@pix3/runtime';
import { GeometryMesh } from '@pix3/runtime';
import { Sprite3D } from '@pix3/runtime';
import { Particles3D } from '@pix3/runtime';
import { AudioPlayer } from '@pix3/runtime';

// Color constants for node types
const NODE_2D_COLOR = '#96cbf6ff';
const NODE_3D_COLOR = '#fe9ebeff';

/**
 * Determines the visual representation (color and icon) for a scene node in the UI.
 * This keeps UI concerns separate from the core node data model.
 * @param node The scene node.
 * @returns An object with the color and icon name for the node.
 */
export function getNodeVisuals(node: NodeBase): { color: string; icon: string } {
  if (node instanceof TiledSprite2D) {
    return { color: NODE_2D_COLOR, icon: 'grid' };
  }
  if (node instanceof Sprite2D) {
    return { color: NODE_2D_COLOR, icon: 'image' };
  }
  if (node instanceof Joystick2D) {
    return { color: NODE_2D_COLOR, icon: 'gamepad' };
  }
  if (node instanceof Button2D) {
    return { color: NODE_2D_COLOR, icon: 'ui-button' };
  }
  if (node instanceof Label2D) {
    return { color: NODE_2D_COLOR, icon: 'text' };
  }
  if (node instanceof Slider2D) {
    return { color: NODE_2D_COLOR, icon: 'ui-slider' };
  }
  if (node instanceof Bar2D) {
    return { color: NODE_2D_COLOR, icon: 'ui-bar' };
  }
  if (node instanceof Checkbox2D) {
    return { color: NODE_2D_COLOR, icon: 'ui-checkbox' };
  }
  if (node instanceof InventorySlot2D) {
    return { color: NODE_2D_COLOR, icon: 'ui-inventory-slot' };
  }
  if (node instanceof Camera2D) {
    return { color: NODE_2D_COLOR, icon: 'camera' };
  }
  if (node instanceof CanvasLayer2D) {
    return { color: NODE_2D_COLOR, icon: 'layers' };
  }
  if (node instanceof Group2D) {
    return { color: NODE_2D_COLOR, icon: 'layout' };
  }
  if (node instanceof Node2D) {
    return { color: NODE_2D_COLOR, icon: 'square' };
  }
  if (node instanceof DirectionalLightNode) {
    return { color: NODE_3D_COLOR, icon: 'sun' };
  }
  if (
    node instanceof PointLightNode ||
    node instanceof SpotLightNode ||
    node instanceof AmbientLightNode ||
    node instanceof HemisphereLightNode
  ) {
    return { color: NODE_3D_COLOR, icon: 'sun' };
  }
  if (node instanceof MeshInstance) {
    return { color: NODE_3D_COLOR, icon: 'package' };
  }
  if (node instanceof Sprite3D) {
    return { color: NODE_3D_COLOR, icon: 'image' };
  }
  if (node instanceof Particles3D) {
    return { color: NODE_3D_COLOR, icon: 'sparkles' };
  }
  if (node instanceof AudioPlayer) {
    return { color: '#7fd1b9ff', icon: 'volume-2' };
  }
  if (node instanceof GeometryMesh) {
    return { color: NODE_3D_COLOR, icon: 'box' };
  }
  if (node instanceof Camera3D) {
    return { color: NODE_3D_COLOR, icon: 'camera' };
  }
  if (node instanceof Node3D) {
    return { color: NODE_3D_COLOR, icon: 'box' };
  }

  // Default for NodeBase or other types
  return { color: '#fff', icon: 'box' };
}
