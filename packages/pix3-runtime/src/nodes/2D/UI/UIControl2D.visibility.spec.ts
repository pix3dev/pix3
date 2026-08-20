import { describe, expect, it } from 'vitest';

import { Button2D } from './Button2D';
import { Group2D } from '../Group2D';
import { InputService } from '../../../core/InputService';

/**
 * Hiding a panel must make the controls inside it inert — on BOTH channels.
 *
 * This is a regression suite for a shipped bug, so it asserts the mechanism rather than the
 * symptom. Nothing upstream filters hidden nodes out of input: `NodeBase.tick` recurses into
 * invisible children on purpose (a hidden spawner or timer has to keep running) and three.js only
 * skips a hidden subtree when it *renders*. So a control that gates on `enabled` alone stays fully
 * live under a hidden overlay — which is how a swipe across a hidden end screen, parked over the
 * middle of the playfield, opened its menu button in the middle of a run.
 *
 * The hover assertions matter as much as the click ones: a hidden control that registers hover
 * makes `isPointerOverUI` claim the finger is over UI nobody can see, and every game that checks it
 * before acting on a tap then ignores a tap on empty screen.
 */

// Input 200x200 with no scene → the logical camera equals the input size, so screen (100,100) is
// world (0,0), where these nodes sit.
function createInput(): InputService {
  const input = new InputService();
  input.width = 200;
  input.height = 200;
  return input;
}

interface Rig {
  button: Button2D;
  panel: Group2D;
  input: InputService;
  seen: string[];
}

/** A button inside a panel, both at the origin, with every funnel signal recorded. */
function createRig(): Rig {
  const panel = new Group2D({ id: 'panel', name: 'Panel', width: 200, height: 200 });
  const button = new Button2D({ id: 'btn', name: 'Button', width: 80, height: 40 });
  panel.add(button);
  const input = createInput();
  button.input = input;
  const seen: string[] = [];
  const listener = {};
  for (const name of ['pointerdown', 'pressed', 'pointerup', 'released', 'click']) {
    button.connect(name, listener, () => seen.push(name));
  }
  return { button, panel, input, seen };
}

/** One press-and-release over the control's centre, the way a finger delivers it. */
function tapCentre(rig: Rig): void {
  rig.input.pointerPosition.set(100, 100);
  rig.button.tick(1 / 60);
  rig.input.isPointerDown = true;
  rig.button.tick(1 / 60);
  rig.input.isPointerDown = false;
  rig.button.tick(1 / 60);
}

describe('UIControl2D visibility gate', () => {
  it('clicks normally while the panel is visible', () => {
    const rig = createRig();

    tapCentre(rig);

    expect(rig.seen).toEqual(['pointerdown', 'pressed', 'pointerup', 'released', 'click']);
    expect(rig.button.isVisibleInTree()).toBe(true);
  });

  it('takes no input when the control itself is hidden', () => {
    const rig = createRig();
    rig.button.visible = false;

    tapCentre(rig);

    expect(rig.seen).toEqual([]);
    expect(rig.input.isHoveringUI).toBe(false);
  });

  it('takes no input when an ANCESTOR is hidden — the shipped bug', () => {
    const rig = createRig();
    // The control's own flag stays true: this is exactly the case a per-node `visible` check misses.
    rig.panel.visible = false;
    expect(rig.button.visible).toBe(true);
    expect(rig.button.isVisibleInTree()).toBe(false);

    tapCentre(rig);

    expect(rig.seen).toEqual([]);
    expect(rig.input.isHoveringUI).toBe(false);
  });

  it('comes back to life when the panel is shown again', () => {
    const rig = createRig();
    rig.panel.visible = false;
    tapCentre(rig);
    expect(rig.seen).toEqual([]);

    rig.panel.visible = true;
    tapCentre(rig);

    expect(rig.seen).toEqual(['pointerdown', 'pressed', 'pointerup', 'released', 'click']);
  });

  it('cancels a held press when the panel is hidden mid-gesture, and never clicks', () => {
    const rig = createRig();
    rig.input.pointerPosition.set(100, 100);
    rig.input.isPointerDown = true;
    rig.button.tick(1 / 60);
    expect(rig.seen).toEqual(['pointerdown', 'pressed']);

    rig.panel.visible = false;
    rig.button.tick(1 / 60);
    // The press is dropped through the cancel path, which emits nothing — the same silence a
    // control that gets disabled mid-press produces. What matters is the absence of `click`: the
    // player never saw the control they are supposedly finishing a gesture on.
    expect(rig.seen).toEqual(['pointerdown', 'pressed']);

    rig.input.isPointerDown = false;
    rig.button.tick(1 / 60);
    expect(rig.seen).not.toContain('click');
    expect(rig.seen).not.toContain('pointerup');
  });

  it('refuses a semantic invocation on a hidden control instead of reporting success', () => {
    const rig = createRig();
    rig.panel.visible = false;

    // The semantic channel bypasses exactly one premise — that a finger can reach the control on
    // screen. Whether it is on screen at all is a different claim, and it must fail honestly.
    expect(rig.button.invokeInteraction('click')).toBe(false);
    expect(rig.button.invokeInteraction('press')).toBe(false);
    expect(rig.button.invokeInteraction('hover')).toBe(false);
    expect(rig.seen).toEqual([]);

    rig.panel.visible = true;
    expect(rig.button.invokeInteraction('click')).toBe(true);
    expect(rig.seen).toContain('click');
  });
});
