import { describe, expect, it, vi } from 'vitest';

import { ECSService } from './ECSService';
import { InputService } from './InputService';
import { SceneService } from './SceneService';

describe('ECSService', () => {
  it('runs only matching systems for each phase', () => {
    const service = new ECSService();
    const updateSystem = vi.fn();
    const fixedSystem = vi.fn();

    service.beginScene(new SceneService(), new InputService());
    service.registerWorld({
      world: { world: {} },
      systems: [
        { phase: 'update', update: updateSystem },
        { phase: 'fixedUpdate', update: fixedSystem },
      ],
    });

    service.setFrameMetrics(1.5, 7);
    service.setInterpolationAlpha(0.25);
    service.fixedUpdate(service.fixedTimeStep);
    service.update(1 / 30);

    expect(fixedSystem).toHaveBeenCalledTimes(1);
    expect(updateSystem).toHaveBeenCalledTimes(1);
    expect(fixedSystem.mock.calls[0]?.[0]).toMatchObject({
      dt: service.fixedTimeStep,
      frame: 7,
      alpha: 0.25,
    });
    expect(updateSystem.mock.calls[0]?.[0]).toMatchObject({
      dt: 1 / 30,
      time: 1.5,
      frame: 7,
      alpha: 0.25,
    });
  });

  it('initializes worlds immediately when a scene is active and unregisters cleanly', () => {
    const service = new ECSService();
    const initialize = vi.fn();
    const dispose = vi.fn();
    const update = vi.fn();

    service.beginScene(new SceneService(), new InputService());
    const unregister = service.registerWorld({
      world: {
        world: {},
        initialize,
        dispose,
      },
      systems: [{ phase: 'update', update }],
    });

    expect(initialize).toHaveBeenCalledTimes(1);

    unregister();
    service.update(1 / 60);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });
});
