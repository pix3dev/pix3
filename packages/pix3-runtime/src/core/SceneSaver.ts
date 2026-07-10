import { stringify } from 'yaml';
import { MathUtils, PerspectiveCamera, OrthographicCamera } from 'three';

import { NodeBase } from '../nodes/NodeBase';
import { Node3D } from '../nodes/Node3D';
import { Node2D } from '../nodes/Node2D';
import { Group2D } from '../nodes/2D/Group2D';
import { Camera2D } from '../nodes/2D/Camera2D';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import { TiledSprite2D } from '../nodes/2D/TiledSprite2D';
import { AnimatedSprite2D } from '../nodes/2D/AnimatedSprite2D';
import { ColorRect2D } from '../nodes/2D/ColorRect2D';
import { Joystick2D } from '../nodes/2D/UI/Joystick2D';
import { UIControl2D } from '../nodes/2D/UI/UIControl2D';
import { Button2D } from '../nodes/2D/UI/Button2D';
import { Slider2D } from '../nodes/2D/UI/Slider2D';
import { Bar2D } from '../nodes/2D/UI/Bar2D';
import { Checkbox2D } from '../nodes/2D/UI/Checkbox2D';
import { InventorySlot2D } from '../nodes/2D/UI/InventorySlot2D';
import { Label2D } from '../nodes/2D/UI/Label2D';
import { ScrollContainer2D } from '../nodes/2D/UI/ScrollContainer2D';
import { DirectionalLightNode } from '../nodes/3D/DirectionalLightNode';
import { PointLightNode } from '../nodes/3D/PointLightNode';
import { SpotLightNode } from '../nodes/3D/SpotLightNode';
import { AmbientLightNode } from '../nodes/3D/AmbientLightNode';
import { HemisphereLightNode } from '../nodes/3D/HemisphereLightNode';
import { GeometryMesh } from '../nodes/3D/GeometryMesh';
import { Camera3D } from '../nodes/3D/Camera3D';
import { VirtualCamera3D } from '../nodes/3D/VirtualCamera3D';
import { PostProcess } from '../nodes/PostProcess';
import { InstancedMesh3D } from '../nodes/3D/InstancedMesh3D';
import { MeshInstance } from '../nodes/3D/MeshInstance';
import { Sprite3D } from '../nodes/3D/Sprite3D';
import { Particles3D } from '../nodes/3D/Particles3D';
import type { SceneGraph } from './SceneManager';
import type { SceneNodeDefinition, InstanceOverrides } from './SceneLoader';
import { getNodePropertySchema } from '../fw/property-schema-utils';

interface SceneDocument {
  version: string;
  description?: string;
  metadata?: Record<string, unknown>;
  root: SceneNodeDefinition[];
}

interface PrefabMarkerMetadata {
  localId: string;
  effectiveLocalId: string;
  instanceRootId: string;
  sourcePath: string;
  basePropertiesByLocalId?: Record<string, Record<string, unknown>>;
}

export class SceneSaver {
  constructor() {}

  /**
   * Serialize a scene graph back to YAML format for saving.
   */
  serializeScene(graph: SceneGraph): string {
    const rootDefinitions: SceneNodeDefinition[] = graph.rootNodes.map(node =>
      this.serializeNode(node)
    );

    const document: SceneDocument = {
      version: graph.version ?? '1.0.0',
      description: graph.description,
      metadata: graph.metadata,
      root: rootDefinitions,
    };

    // Custom YAML stringification to keep vectors as inline arrays
    let yaml = stringify(document, { indent: 2 });

    // Replace expanded position arrays with inline format
    yaml = yaml.replace(
      /position:\s*\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)/g,
      'position: [$1, $2, $3]'
    );
    yaml = yaml.replace(
      /position:\s*\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)(?!\s*-)/g,
      'position: [$1, $2]'
    );

    // Replace expanded rotationEuler arrays with inline format
    yaml = yaml.replace(
      /rotationEuler:\s*\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)/g,
      'rotationEuler: [$1, $2, $3]'
    );

    // Replace expanded scale arrays with inline format
    yaml = yaml.replace(
      /scale:\s*\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)/g,
      'scale: [$1, $2, $3]'
    );
    yaml = yaml.replace(/scale:\s*\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)(?!\s*-)/g, 'scale: [$1, $2]');

    // Replace expanded rotation arrays with inline format (2D)
    yaml = yaml.replace(
      /rotation:\s*\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)\n\s*- (\w+)/g,
      'rotation: [$1, $2, $3, $4]'
    );
    yaml = yaml.replace(
      /rotation:\s*\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)(?!\s*-)/g,
      'rotation: [$1, $2]'
    );

    // Replace expanded size arrays with inline format
    yaml = yaml.replace(
      /size:\s*\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)/g,
      'size: [$1, $2, $3]'
    );
    yaml = yaml.replace(/size:\s*\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)(?!\s*-)/g, 'size: [$1, $2]');

    // Replace expanded pivot arrays with inline format
    yaml = yaml.replace(/pivot:\s*\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)/g, 'pivot: [$1, $2]');

    // Replace expanded particle vectors with inline format
    yaml = yaml.replace(
      /emitterBoxSize:\s*\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)/g,
      'emitterBoxSize: [$1, $2, $3]'
    );
    yaml = yaml.replace(
      /gravity:\s*\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)\n\s*- ([\d.-]+)/g,
      'gravity: [$1, $2, $3]'
    );

    return yaml;
  }

  private serializeNode(node: NodeBase): SceneNodeDefinition {
    if (node.instancePath) {
      return this.serializeInstanceNode(node);
    }

    // First, get the properties (this might modify the type for DirectionalLightNode)
    const properties = this.serializeNodeProperties(node);

    const definition: SceneNodeDefinition = {
      id: node.nodeId,
      type: node.type !== 'Group' ? node.type : undefined,
      name: node.name,
      groups: node.groups.size > 0 ? Array.from(node.groups.values()) : undefined,
      properties: properties,
      metadata: this.serializeMetadata(node.metadata),
    };

    // Ensure correct type for light nodes
    if (node instanceof DirectionalLightNode) {
      definition.type = 'DirectionalLightNode';
    } else if (node instanceof PointLightNode) {
      definition.type = 'PointLightNode';
    } else if (node instanceof SpotLightNode) {
      definition.type = 'SpotLightNode';
    } else if (node instanceof AmbientLightNode) {
      definition.type = 'AmbientLightNode';
    } else if (node instanceof HemisphereLightNode) {
      definition.type = 'HemisphereLightNode';
    }

    // Serialize components
    if (node.components.length > 0) {
      definition.components = node.components.map(c => ({
        id: c.id,
        type: c.type,
        enabled: c.enabled,
        config: c.config && Object.keys(c.config).length > 0 ? c.config : undefined,
      }));
    }

    // Recursively serialize children
    if (node.children && node.children.length > 0) {
      definition.children = node.children
        .filter((child): child is NodeBase => child instanceof NodeBase)
        .map(child => this.serializeNode(child));
    }

    // Remove undefined properties to keep YAML clean
    Object.keys(definition).forEach(key => {
      if (definition[key as keyof SceneNodeDefinition] === undefined) {
        delete definition[key as keyof SceneNodeDefinition];
      }
    });

    return definition;
  }

  private serializeInstanceNode(node: NodeBase): SceneNodeDefinition {
    const definition: SceneNodeDefinition = {
      id: node.nodeId,
      type: node.type !== 'Group' ? node.type : undefined,
      name: node.name,
      instance: node.instancePath ?? undefined,
      groups: node.groups.size > 0 ? Array.from(node.groups.values()) : undefined,
      metadata: this.serializeMetadata(node.metadata),
    };

    const marker = this.getPrefabMarker(node);
    const baseMap = marker?.basePropertiesByLocalId ?? {};
    const currentMap = this.captureInstanceComparableMap(node);
    const normalizedRootKey = marker ? marker.effectiveLocalId : this.normalizeLocalId(node.nodeId);
    const currentRoot = currentMap[normalizedRootKey] ?? {};
    const baseRoot = baseMap[normalizedRootKey] ?? {};
    const rootDiff = this.diffRecord(baseRoot, currentRoot);

    if (Object.keys(rootDiff).length > 0) {
      definition.properties = rootDiff;
    }

    const byLocalId: Record<string, { properties?: Record<string, unknown> }> = {};
    for (const [effectiveLocalId, currentValues] of Object.entries(currentMap)) {
      if (effectiveLocalId === normalizedRootKey) {
        continue;
      }

      const baseValues = baseMap[effectiveLocalId] ?? {};
      const diff = this.diffRecord(baseValues, currentValues);
      if (Object.keys(diff).length === 0) {
        continue;
      }

      const outputKey = effectiveLocalId.startsWith(`${normalizedRootKey}/`)
        ? effectiveLocalId.slice(normalizedRootKey.length + 1)
        : effectiveLocalId;
      byLocalId[outputKey] = { properties: diff };
    }

    if (Object.keys(byLocalId).length > 0) {
      const overrides: InstanceOverrides = { byLocalId };
      definition.overrides = overrides;
    }

    Object.keys(definition).forEach(key => {
      if (definition[key as keyof SceneNodeDefinition] === undefined) {
        delete definition[key as keyof SceneNodeDefinition];
      }
    });

    return definition;
  }

  private serializeMetadata(
    metadata: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    const entries = Object.entries(metadata).filter(([key]) => key !== '__pix3Prefab');
    if (entries.length === 0) {
      return undefined;
    }
    return Object.fromEntries(entries);
  }

  private serializeNodeProperties(node: NodeBase): Record<string, unknown> {
    const props: Record<string, unknown> = { ...node.properties };

    // Remove flat transform properties - we'll use the transform wrapper instead
    delete props.position;
    delete props.rotation;
    delete props.scale;
    delete props.rotationEuler;
    delete props.rotationOrder;
    delete props.transform;

    // Serialize 3D transforms if this is a Node3D
    if (node instanceof Node3D) {
      // Convert rotation from radians back to degrees for YAML
      const rotation = node.rotation;
      const transform: Record<string, unknown> = {
        position: [node.position.x, node.position.y, node.position.z],
        rotationEuler: [
          MathUtils.radToDeg(rotation.x),
          MathUtils.radToDeg(rotation.y),
          MathUtils.radToDeg(rotation.z),
        ],
        scale: [node.scale.x, node.scale.y, node.scale.z],
      };

      // Add transform metadata if rotation order is not default
      if (rotation.order && rotation.order !== 'XYZ') {
        transform.rotationOrder = rotation.order;
      }

      props.transform = transform;

      // Persist authored local opacity when non-default.
      if (node.opacity !== 1) {
        props.opacity = node.opacity;
      } else {
        delete props.opacity;
      }
    } else if (node instanceof ScrollContainer2D) {
      props.width = node.width;
      props.height = node.height;

      const transform: Record<string, unknown> = {
        position: [node.position.x, node.position.y],
        scale: [node.scale.x, node.scale.y],
        rotation: MathUtils.radToDeg(node.rotation.z),
      };
      props.transform = transform;

      const layout = node.serializeLayout();
      if (layout) {
        props.layout = layout;
      } else {
        delete props.layout;
      }
    } else if (node instanceof Group2D) {
      // Serialize Group2D with size properties
      props.width = node.width;
      props.height = node.height;

      // Add 2D transform
      const transform: Record<string, unknown> = {
        position: [node.position.x, node.position.y],
        scale: [node.scale.x, node.scale.y],
        rotation: MathUtils.radToDeg(node.rotation.z),
      };
      props.transform = transform;

      const layout = node.serializeLayout();
      if (layout) {
        props.layout = layout;
      } else {
        delete props.layout;
      }
    } else if (node instanceof Node2D) {
      // Generic Node2D transform
      const transform: Record<string, unknown> = {
        position: [node.position.x, node.position.y],
        scale: [node.scale.x, node.scale.y],
        rotation: MathUtils.radToDeg(node.rotation.z),
      };

      props.transform = transform;

      const layout = node.serializeLayout();
      if (layout) {
        props.layout = layout;
      } else {
        delete props.layout;
      }

      // Persist authored local opacity when non-default.
      if (node.opacity !== 1) {
        props.opacity = node.opacity;
      } else {
        delete props.opacity;
      }
    }

    // Serialize specific node type properties
    if (node instanceof ColorRect2D) {
      // ColorRect2D exposes width/height/color as instance fields; its property
      // setters (Inspector edits) mutate those fields and the material directly
      // and never touch node.properties, so we must read the live fields here.
      // Without this branch, serialize→re-parse (used when entering play mode)
      // would emit the stale load-time color/size from the properties bag.
      props.width = node.width;
      props.height = node.height;
      props.color = node.color;
    } else if (node instanceof ScrollContainer2D) {
      props.scrollY = node.scrollY;
      props.dragScrollEnabled = node.dragScrollEnabled;
      props.wheelScrollEnabled = node.wheelScrollEnabled;
      props.inertiaEnabled = node.inertiaEnabled;
      props.showScrollbar = node.showScrollbar;
      props.wheelSensitivity = node.wheelSensitivity;
      props.dragThreshold = node.dragThreshold;
      props.inertiaDamping = node.inertiaDamping;
      props.scrollbarWidth = node.scrollbarWidth;
      props.scrollbarMinHeight = node.scrollbarMinHeight;
      props.scrollbarInset = node.scrollbarInset;
      props.scrollbarColor = node.scrollbarColor;
      props.scrollbarTrackColor = node.scrollbarTrackColor;
      if (node.scrollbarThumbTexture) {
        props.scrollbarThumbTexture = { ...node.scrollbarThumbTexture };
      } else {
        delete props.scrollbarThumbTexture;
      }
      if (node.scrollbarTrackTexture) {
        props.scrollbarTrackTexture = { ...node.scrollbarTrackTexture };
      } else {
        delete props.scrollbarTrackTexture;
      }
    } else if (node instanceof Sprite2D) {
      if (node.texture) {
        props.texture = { ...node.texture };
      }
      // Save width/height in pixels
      props.width = node.width;
      props.height = node.height;
      if (node.aspectRatioLocked) {
        props.aspectRatioLocked = true;
      }
      if (node.anchor.x !== 0.5 || node.anchor.y !== 0.5) {
        props.anchor = [
          Math.round(node.anchor.x * 1000) / 1000,
          Math.round(node.anchor.y * 1000) / 1000,
        ];
      }
    } else if (node instanceof TiledSprite2D) {
      if (node.texture) {
        props.texture = { ...node.texture };
      }
      props.patchMode = node.patchMode;
      props.width = node.width;
      props.height = node.height;
      props.sliceBorderLeft = node.sliceBorder.left;
      props.sliceBorderRight = node.sliceBorder.right;
      props.sliceBorderTop = node.sliceBorder.top;
      props.sliceBorderBottom = node.sliceBorder.bottom;
      props.drawCenter = node.drawCenter;
      props.axisStretchHorizontal = node.axisStretchHorizontal;
      props.axisStretchVertical = node.axisStretchVertical;
      props.tileScale = [node.tileScale.x, node.tileScale.y];
      props.tileOffset = [node.tileOffset.x, node.tileOffset.y];
      if (node.anchor.x !== 0.5 || node.anchor.y !== 0.5) {
        props.anchor = [
          Math.round(node.anchor.x * 1000) / 1000,
          Math.round(node.anchor.y * 1000) / 1000,
        ];
      }
    } else if (node instanceof AnimatedSprite2D) {
      delete props.frames;
      delete props.fps;
      delete props.playing;
      delete props.loop;

      if (node.animationResourcePath) {
        props.animationResourcePath = node.animationResourcePath;
      } else {
        delete props.animationResourcePath;
      }

      if (node.currentClip) {
        props.currentClip = node.currentClip;
      } else {
        delete props.currentClip;
      }

      props.isPlaying = node.isPlaying;
      props.currentFrame = node.currentFrame;
      props.width = node.width;
      props.height = node.height;
      props.color = node.color;
    } else if (node instanceof Joystick2D) {
      if (node.radius !== 50) props.radius = node.radius;
      if (node.handleRadius !== 20) props.handleRadius = node.handleRadius;
      if (node.axisHorizontal !== 'Horizontal') props.axisHorizontal = node.axisHorizontal;
      if (node.axisVertical !== 'Vertical') props.axisVertical = node.axisVertical;
      if (node.baseColor !== '#ffffff') props.baseColor = node.baseColor;
      if (node.handleColor !== '#cccccc') props.handleColor = node.handleColor;
      if (node.floating !== false) props.floating = node.floating;
    } else if (node instanceof Button2D) {
      this.serializeCommonUIControlProps(node, props);
      props.width = node.width;
      props.height = node.height;
      props.backgroundColor = node.backgroundColor;
      props.hoverColor = node.hoverColor;
      props.pressedColor = node.pressedColor;
      props.buttonAction = node.buttonAction;
      if (node.textureNormal) {
        props.textureNormal = { ...node.textureNormal };
      } else {
        delete props.textureNormal;
      }
      if (node.textureHover) {
        props.textureHover = { ...node.textureHover };
      } else {
        delete props.textureHover;
      }
      if (node.texturePressed) {
        props.texturePressed = { ...node.texturePressed };
      } else {
        delete props.texturePressed;
      }
      if (node.textureDisabled) {
        props.textureDisabled = { ...node.textureDisabled };
      } else {
        delete props.textureDisabled;
      }
    } else if (node instanceof Label2D) {
      this.serializeCommonUIControlProps(node, props);
    } else if (node instanceof Slider2D) {
      this.serializeCommonUIControlProps(node, props);
      props.width = node.width;
      props.height = node.height;
      props.handleSize = node.handleSize;
      props.trackBackgroundColor = node.trackBackgroundColor;
      props.trackFilledColor = node.trackFilledColor;
      props.handleColor = node.handleColor;
      props.minValue = node.minValue;
      props.maxValue = node.maxValue;
      props.value = node.value;
      props.axisName = node.axisName;
    } else if (node instanceof Bar2D) {
      this.serializeCommonUIControlProps(node, props);
      props.width = node.width;
      props.height = node.height;
      props.backBackgroundColor = node.backBackgroundColor;
      props.barColor = node.barColor;
      props.minValue = node.minValue;
      props.maxValue = node.maxValue;
      props.value = node.value;
      props.showBorder = node.showBorder;
      props.borderColor = node.borderColor;
      props.borderWidth = node.borderWidth;
    } else if (node instanceof Checkbox2D) {
      this.serializeCommonUIControlProps(node, props);
      props.size = node.size;
      props.checked = node.checked;
      props.uncheckedColor = node.uncheckedColor;
      props.checkedColor = node.checkedColor;
      props.checkmarkColor = node.checkmarkColor;
      props.checkmarkAction = node.checkmarkAction;
    } else if (node instanceof InventorySlot2D) {
      this.serializeCommonUIControlProps(node, props);
      props.width = node.width;
      props.height = node.height;
      props.backdropColor = node.backdropColor;
      props.borderColor = node.borderColor;
      props.borderWidth = node.borderWidth;
      props.quantity = node.quantity;
      props.showQuantity = node.showQuantity;
      props.quantityFontSize = node.quantityFontSize;
      props.selectionColor = node.selectionColor;
      props.selectedAction = node.selectedAction;
    } else if (node instanceof GeometryMesh) {
      // Read from the live material via serializeConfig (mirrors the light /
      // camera branches). The previous cast-to-public-property approach always
      // saw `undefined`, so inspector color/roughness/metalness edits were lost
      // on save and in the play-mode clone.
      Object.assign(props, node.serializeConfig());
    } else if (node instanceof InstancedMesh3D) {
      props.maxInstances = node.maxInstances;
      props.castShadow = node.mesh.castShadow;
      props.receiveShadow = node.mesh.receiveShadow;
      props.enablePerInstanceColor = node.enablePerInstanceColor;
      if (node.mesh.frustumCulled) {
        props.frustumCulled = true;
      } else {
        delete props.frustumCulled;
      }
      delete props.visibleInstanceCount;
    } else if (node instanceof DirectionalLightNode) {
      props.color = '#' + node.light.color.getHexString();
      props.intensity = node.light.intensity;
      props.castShadow = node.light.castShadow;
      props.shadowCameraSize = node.light.shadow.camera.right;
      props.shadowMapSize = node.light.shadow.mapSize.width;
    } else if (node instanceof PointLightNode) {
      props.color = '#' + node.light.color.getHexString();
      props.intensity = node.light.intensity;
      props.distance = node.light.distance;
      props.decay = node.light.decay;
      props.castShadow = node.light.castShadow;
    } else if (node instanceof SpotLightNode) {
      props.color = '#' + node.light.color.getHexString();
      props.intensity = node.light.intensity;
      props.distance = node.light.distance;
      props.angle = (node.light.angle * 180) / Math.PI;
      props.penumbra = node.light.penumbra;
      props.decay = node.light.decay;
      props.castShadow = node.light.castShadow;
    } else if (node instanceof AmbientLightNode) {
      props.color = '#' + node.light.color.getHexString();
      props.intensity = node.light.intensity;
    } else if (node instanceof HemisphereLightNode) {
      props.skyColor = '#' + node.light.color.getHexString();
      props.groundColor = '#' + node.light.groundColor.getHexString();
      props.intensity = node.light.intensity;
    } else if (node instanceof Camera3D) {
      if (node.camera instanceof PerspectiveCamera) {
        props.projection = 'perspective';
        props.fov = node.fov;
        props.near = node.near;
        props.far = node.far;
      } else if (node.camera instanceof OrthographicCamera) {
        props.projection = 'orthographic';
        props.orthographicSize = node.orthographicSize;
        props.near = node.near;
        props.far = node.far;
      }
    } else if (node instanceof VirtualCamera3D) {
      Object.assign(props, node.serializeConfig());
    } else if (node instanceof Camera2D) {
      Object.assign(props, node.serializeConfig());
    } else if (node instanceof PostProcess) {
      Object.assign(props, node.serializeConfig());
    } else if (node instanceof MeshInstance) {
      const inst = node as MeshInstance;
      if (inst.src) {
        props.src = inst.src as string;
      }
      if (inst.initialAnimation) {
        props.initialAnimation = inst.initialAnimation;
      }
      props.isPlaying = inst.isPlaying;
      props.isLoop = inst.isLoop;
      props.castShadow = inst.castShadow;
      props.receiveShadow = inst.receiveShadow;
    } else if (node instanceof Sprite3D) {
      if (node.texture) {
        props.texture = { ...node.texture };
      }
      props.width = node.width;
      props.height = node.height;
      props.color = node.color;
      props.billboard = node.billboard;
      props.billboardRoll = node.billboardRoll;
    } else if (node instanceof Particles3D) {
      if (node.texture) {
        props.texture = { ...node.texture };
      }
      props.emitterShape = node.emitterShape;
      props.emitterRadius = node.emitterRadius;
      props.emitterBoxSize = [node.emitterBoxSize.x, node.emitterBoxSize.y, node.emitterBoxSize.z];
      props.particleShape = node.particleShape;
      props.emissionRate = node.emissionRate;
      props.maxParticles = node.maxParticles;
      props.lifetime = node.lifetime;
      props.speed = node.speed;
      props.speedSpread = node.speedSpread;
      props.gravity = [node.gravity.x, node.gravity.y, node.gravity.z];
      props.particleSize = node.particleSize;
      props.sizeRandomness = node.sizeRandomness;
      props.startColor = node.startColor;
      props.endColor = node.endColor;
      props.startAlpha = node.startAlpha;
      props.endAlpha = node.endAlpha;
      props.billboard = node.billboard;
      props.disableRotation = node.disableRotation;
      props.playing = node.playing;
      props.loop = node.loop;
      props.prewarm = node.prewarm;
      props.preview = node.preview;
      props.simulationSpace = node.simulationSpace;
    }

    return props;
  }

  private captureInstanceComparableMap(root: NodeBase): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    const stack: NodeBase[] = [root];

    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }

      const marker = this.getPrefabMarker(node);
      if (marker) {
        result[marker.effectiveLocalId] = this.captureComparableProperties(node);
      }

      for (const child of node.children) {
        if (child instanceof NodeBase) {
          stack.push(child);
        }
      }
    }

    return result;
  }

  private captureComparableProperties(node: NodeBase): Record<string, unknown> {
    const schema = getNodePropertySchema(node);
    const values: Record<string, unknown> = {};

    for (const prop of schema.properties) {
      // Skip only STATICALLY read-only props (identity/derived, e.g. id/type).
      // A function `readOnly` marks a conditionally-editable real value (e.g.
      // horizontalAlign/verticalAlign gated on layoutEnabled); treating the
      // function as truthy here previously dropped such values from prefab
      // instance override diffs, silently losing anchor overrides on save.
      if (prop.ui?.hidden || prop.ui?.readOnly === true) {
        continue;
      }
      values[prop.name] = this.cloneValue(prop.getValue(node));
    }

    return values;
  }

  private diffRecord(
    baseValues: Record<string, unknown>,
    currentValues: Record<string, unknown>
  ): Record<string, unknown> {
    const diff: Record<string, unknown> = {};
    const keys = new Set<string>([...Object.keys(baseValues), ...Object.keys(currentValues)]);

    for (const key of keys) {
      const baseValue = baseValues[key];
      const currentValue = currentValues[key];
      if (!this.isEqualValue(baseValue, currentValue)) {
        diff[key] = this.cloneValue(currentValue);
      }
    }

    return diff;
  }

  private isEqualValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private getPrefabMarker(node: NodeBase): PrefabMarkerMetadata | null {
    const metadata = node.metadata as Record<string, unknown>;
    const candidate = metadata.__pix3Prefab;

    if (!candidate || typeof candidate !== 'object') {
      return null;
    }

    const marker = candidate as Partial<PrefabMarkerMetadata>;
    if (
      typeof marker.localId !== 'string' ||
      typeof marker.effectiveLocalId !== 'string' ||
      typeof marker.instanceRootId !== 'string' ||
      typeof marker.sourcePath !== 'string'
    ) {
      return null;
    }

    return marker as PrefabMarkerMetadata;
  }

  private normalizeLocalId(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  }

  private cloneValue<T>(value: T): T {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value !== 'object') {
      return value;
    }
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private serializeCommonUIControlProps(node: UIControl2D, props: Record<string, unknown>): void {
    if (node.enabled !== true) props.enabled = node.enabled;
    if (node.label !== '') props.label = node.label;
    if (node.labelFontFamily !== 'Arial') props.labelFontFamily = node.labelFontFamily;
    if (node.labelFontSize !== 16) props.labelFontSize = node.labelFontSize;
    if (node.labelColor !== '#ffffff') props.labelColor = node.labelColor;
    if (node.labelAlign !== 'center') props.labelAlign = node.labelAlign;
    if (node.texturePath) props.texturePath = node.texturePath;
  }
}
