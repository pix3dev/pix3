import { AsyncDirective } from 'lit/async-directive.js';
import { directive, PartType, type EventPart, type PartInfo } from 'lit/directive.js';

type DismissCallback = (event: MouseEvent) => void;

/** A backdrop click must start and finish on the backdrop, not in its dialog. */
class BackdropDismissDirective extends AsyncDirective {
  private part?: EventPart;
  private callback?: DismissCallback;
  private pointerId: number | null = null;
  private isBackdropGesture = false;

  private get element(): Element | undefined {
    return this.part?.element;
  }

  constructor(partInfo: PartInfo) {
    super(partInfo);
    if (partInfo.type !== PartType.EVENT || partInfo.name !== 'click') {
      throw new Error('dismissOnBackdropClick must be used in a @click binding');
    }
  }

  render(callback: DismissCallback): unknown {
    this.callback = callback;
    return this;
  }

  update(part: EventPart, [callback]: [DismissCallback]): unknown {
    if (this.part !== part) {
      this.disconnected();
      this.part = part;
      this.reconnected();
    }
    return this.render(callback);
  }

  private readonly onPointerDown = (event: Event): void => {
    const pointer = event as PointerEvent;
    this.pointerId = pointer.pointerId;
    this.isBackdropGesture = pointer.button === 0 && pointer.composedPath()[0] === this.element;
  };

  private readonly onPointerUp = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (pointer.pointerId === this.pointerId) {
      // Hit-test as well: touch pointers may be implicitly captured by the backdrop.
      const hit = this.element?.ownerDocument.elementFromPoint?.(pointer.clientX, pointer.clientY);
      this.isBackdropGesture &&=
        pointer.composedPath()[0] === this.element && (!hit || hit === this.element);
    }
  };

  private readonly onPointerCancel = (): void => {
    this.pointerId = null;
    this.isBackdropGesture = false;
  };

  handleEvent(event: MouseEvent): void {
    const allowed =
      event.composedPath()[0] === this.element &&
      (this.pointerId === null ? event.detail === 0 : this.isBackdropGesture);
    this.onPointerCancel();
    if (allowed) {
      this.callback?.call(this.part?.options?.host ?? this.element, event);
    }
  }

  protected disconnected(): void {
    this.element?.removeEventListener('pointerdown', this.onPointerDown, true);
    this.element?.removeEventListener('pointerup', this.onPointerUp, true);
    this.element?.removeEventListener('pointercancel', this.onPointerCancel, true);
    this.onPointerCancel();
  }

  protected reconnected(): void {
    this.element?.addEventListener('pointerdown', this.onPointerDown, true);
    this.element?.addEventListener('pointerup', this.onPointerUp, true);
    this.element?.addEventListener('pointercancel', this.onPointerCancel, true);
  }
}

export const dismissOnBackdropClick = directive(BackdropDismissDirective);
