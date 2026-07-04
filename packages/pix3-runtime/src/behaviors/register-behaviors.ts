/**
 * Register built-in script components
 *
 * This module registers all built-in script components with the ScriptRegistry.
 * Import this module and pass the registry instance to register components.
 */

import { ScriptRegistry } from '../core/ScriptRegistry';
import { RotateBehavior } from './RotateBehavior';
import { SimpleMoveBehavior } from './SimpleMoveBehavior';
import { SineBehavior } from './SineBehavior';
import { PinToNodeBehavior } from './PinToNodeBehavior';
import { FollowBehavior } from './FollowBehavior';
import { FadeBehavior } from './FadeBehavior';
import { RadialProgressBehavior } from './RadialProgressBehavior';
import { PlaySoundBehavior } from './PlaySoundBehavior';
import { AnimationPlayerBehavior } from '../animation/AnimationPlayerBehavior';

/**
 * Register all built-in script components
 */
export function registerBuiltInScripts(registry: ScriptRegistry): void {
  // Register test/example components
  registry.registerComponent({
    id: 'core:Rotate',
    displayName: 'Rotate',
    description: 'Rotates a 3D node continuously',
    category: 'Transform',
    componentClass: RotateBehavior,
    keywords: ['rotate', 'animation'],
  });

  registry.registerComponent({
    id: 'core:SimpleMove',
    displayName: 'Simple Move',
    description: 'Moves a 3D node in a simple pattern (for testing)',
    category: 'Test',
    componentClass: SimpleMoveBehavior,
    keywords: ['move', 'test', 'animation'],
  });

  registry.registerComponent({
    id: 'core:Sine',
    displayName: 'Sine Oscillator',
    description: 'Oscillates a node along a selected axis',
    category: 'Animation',
    componentClass: SineBehavior,
    keywords: ['sine', 'oscillation', 'animation'],
  });

  registry.registerComponent({
    id: 'core:PinToNode',
    displayName: 'Pin to Node',
    description: 'Pins a 2D UI node to a 3D target node',
    category: 'UI',
    componentClass: PinToNodeBehavior,
    keywords: ['ui', 'tracking', 'pin'],
  });

  registry.registerComponent({
    id: 'core:Follow',
    displayName: 'Follow',
    description: 'Smoothly follows a target node position and/or rotation',
    category: 'Transform',
    componentClass: FollowBehavior,
    keywords: ['follow', 'camera', 'tracking', 'smooth'],
  });

  registry.registerComponent({
    id: 'core:Fade',
    displayName: 'Fade',
    description: 'Fades 2D node opacity in and out with optional auto-destroy',
    category: 'Animation',
    componentClass: FadeBehavior,
    keywords: ['fade', 'opacity', 'animation'],
  });

  registry.registerComponent({
    id: 'core:RadialProgress',
    displayName: 'Radial Progress',
    description: 'Masks a Sprite2D texture as a circular progress bar',
    category: 'UI',
    componentClass: RadialProgressBehavior,
    keywords: ['radial', 'progress', 'bar', 'circle', 'mask', 'ui'],
  });

  registry.registerComponent({
    id: 'core:AnimationPlayer',
    displayName: 'Animation Player',
    description: 'Plays keyframe animation clips on this node and its descendants',
    category: 'Animation',
    componentClass: AnimationPlayerBehavior,
    keywords: ['animation', 'keyframe', 'tween', 'timeline', 'player', 'clip'],
  });

  registry.registerComponent({
    id: 'core:PlaySound',
    displayName: 'Play Sound',
    description: 'Plays an audio track when a node signal is emitted',
    category: 'Audio',
    componentClass: PlaySoundBehavior,
    keywords: ['audio', 'sound', 'sfx', 'trigger', 'event'],
  });

  console.log('[ScriptRegistry] Registered built-in script components');
}
