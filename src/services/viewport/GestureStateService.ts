import { injectable } from '@/fw/di';

/**
 * "Is a pointer gesture editing the document right now?" — a transform-gizmo drag, a 2D
 * move/resize/rotate handle drag. Live gestures mutate nodes directly and commit ONE operation at
 * pointer-up; until then the document is mid-edit. Autosave waits for the gesture to end, and the
 * protected-set recorder only ever sees the committed operation (plan §4.3: "Незавершённый жест в
 * `P` не попадает").
 *
 * Deliberately tiny and dependency-free: the viewport registers a probe, consumers ask. Keeps
 * three.js and the viewport out of the import graph of autosave.
 */
@injectable()
export class GestureStateService {
  private readonly probes = new Set<() => boolean>();

  /** Register a probe; returns its unregister function. */
  registerProbe(probe: () => boolean): () => void {
    this.probes.add(probe);
    return () => this.probes.delete(probe);
  }

  isGestureActive(): boolean {
    for (const probe of this.probes) {
      try {
        if (probe()) return true;
      } catch {
        // A disposed viewport answers "no gesture".
      }
    }
    return false;
  }

  dispose(): void {
    this.probes.clear();
  }
}
