// Core
export * from './core/ResourceManager';
export * from './core/AssetLoader';
export * from './core/AudioService';
export * from './core/ScriptRegistry';
export * from './core/ScriptComponent';
export * from './core/ProjectManifest';
export * from './core/SceneLoader';
export * from './core/SceneSaver';
export * from './core/SceneManager';
export * from './core/SceneRunner';
export * from './core/RuntimeRenderer';
export * from './core/PostProcessingPipeline';
export * from './core/InputService';
export * from './core/SceneService';
export * from './core/TextureResource';
export * from './core/AnimationResource';
export * from './core/ecs';
export * from './core/ECSService';
export * from './core/GameTime';
export * from './core/JuiceApi';
export * from './core/AudioApi';
export * from './core/CutsceneApi';
export * from './core/raycast';
export * from './core/render-order-2d';
export * from './core/configure-2d-texture';
export * from './core/project-texture-filtering';
export * from './core/texture-region';
export * from './core/label-text-layout';
export * from './core/tiled-sprite-geometry';
export * from './core/game-debug';
export * from './core/world-to-canvas';
export * from './core/PlayableSdk';

// Nodes
export * from './nodes/NodeBase';
export * from './nodes/Node2D';
export * from './nodes/Node3D';
export * from './nodes/AudioPlayer';
export * from './nodes/PostProcess';

// 2D Nodes
export * from './nodes/2D/Sprite2D';
export * from './nodes/2D/AnimatedSprite2D';
export * from './nodes/2D/ColorRect2D';
export * from './nodes/2D/TiledSprite2D';
export * from './nodes/2D/Group2D';
export * from './nodes/2D/Camera2D';
export * from './nodes/2D/CanvasLayer2D';
export * from './nodes/2D/UI/UIControl2D';
export * from './nodes/2D/UI/Joystick2D';
export * from './nodes/2D/UI/Button2D';
export * from './nodes/2D/UI/Label2D';
export * from './nodes/2D/UI/ScrollContainer2D';
export * from './nodes/2D/UI/Slider2D';
export * from './nodes/2D/UI/Bar2D';
export * from './nodes/2D/UI/Checkbox2D';
export * from './nodes/2D/UI/InventorySlot2D';

// 3D Nodes
export * from './nodes/3D/Camera3D';
export * from './nodes/3D/VirtualCamera3D';
export * from './nodes/3D/DirectionalLightNode';
export * from './nodes/3D/GeometryMesh';
export * from './nodes/3D/InstancedMesh3D';
export * from './nodes/3D/MeshInstance';
export * from './nodes/3D/Sprite3D';
export * from './nodes/3D/AnimatedSprite3D';
export * from './nodes/3D/Particles3D';
export * from './nodes/3D/PointLightNode';
export * from './nodes/3D/SpotLightNode';
export * from './nodes/3D/AmbientLightNode';
export * from './nodes/3D/HemisphereLightNode';

// Behaviors
export * from './behaviors/register-behaviors';
export * from './behaviors/RotateBehavior';
export * from './behaviors/SimpleMoveBehavior';
export * from './behaviors/SineBehavior';
export * from './behaviors/RadialProgressBehavior';
export * from './behaviors/PinToNodeBehavior';
export * from './behaviors/FadeBehavior';
export * from './behaviors/PlaySoundBehavior';
export * from './behaviors/ShakeBehavior';
export * from './behaviors/PunchScaleBehavior';
export * from './behaviors/PopInBehavior';
export * from './behaviors/CameraBrainBehavior';
export * from './behaviors/Hitbox2DBehavior';
export * from './core/Collision2DService';

// Keyframe animation
export * from './animation/easing';
export * from './animation/keyframe-types';
export * from './animation/clip-evaluator';
export * from './animation/AnimationPlayerBehavior';

// Shader effects (registry-backed material effects for GeometryMesh)
export * from './shader-effects';

// Framework
export * from './fw/property-schema';
export * from './fw/property-schema-utils';

// Decorators
export { property, state } from 'lit/decorators.js';
