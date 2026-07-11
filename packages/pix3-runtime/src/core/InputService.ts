
import { Vector2 } from 'three';

export interface InputPointerFrameEvent {
    type: 'down' | 'move' | 'up';
    pointerId: number;
    x: number;
    y: number;
}

export interface InputKeyFrameEvent {
    type: 'down' | 'up';
    code: string;
    key: string;
    repeat: boolean;
}

/**
 * InputService - Central hub for handling user input.
 * Manages virtual axes, buttons, and raw pointer events.
 */
export class InputService {
    private axes = new Map<string, number>();
    private buttons = new Map<string, boolean>();

    public readonly pointerPosition = new Vector2();
    public isPointerDown = false;
    public activePointerId: number | null = null;
    public wheelDelta = new Vector2();
    public pointerEvents: readonly InputPointerFrameEvent[] = [];
    public keyEvents: readonly InputKeyFrameEvent[] = [];

    public width = 0;
    public height = 0;

    private hoveredUIElements = new Set<string>();
    private readonly pendingWheelDelta = new Vector2();
    private pendingPointerEvents: InputPointerFrameEvent[] = [];
    private pendingKeyEvents: InputKeyFrameEvent[] = [];

    private element: HTMLElement | null = null;
    private previousTouchAction: string | null = null;

    /**
     * Depth-counted input lock. While > 0 the DOM handlers early-return so the
     * whole polled-input surface (`getAxis`/`getButton`/`pointerEvents`/
     * `pointerPosition`, and every UI control that polls it) goes quiet without
     * any per-consumer change. Used by the Cutscene Director to freeze gameplay
     * input during a cinematic. Nested locks stack; only the 0→1 transition
     * clears transient state.
     */
    private lockDepth = 0;

    /**
     * Resets frame-based input state. Should be called at the start of each frame.
     */
    beginFrame(): void {
        this.hoveredUIElements.clear();
        this.wheelDelta.copy(this.pendingWheelDelta);
        this.pendingWheelDelta.set(0, 0);
        this.pointerEvents = this.pendingPointerEvents;
        this.pendingPointerEvents = [];
        this.keyEvents = this.pendingKeyEvents;
        this.pendingKeyEvents = [];
    }

    /**
     * Registers that a UI element is currently being hovered by the pointer.
     */
    registerHover(id: string): void {
        this.hoveredUIElements.add(id);
    }

    /**
     * Returns true if any UI element is currently hovered.
     */
    get isHoveringUI(): boolean {
        return this.hoveredUIElements.size > 0;
    }

    /**
     * Acquire the input lock (depth-counted). On the 0→1 transition, force-release
     * all transient input state so nothing stays "held" behind the lock: release
     * the captured pointer, clear `isPointerDown`/`activePointerId`, drop the
     * `Action_Primary` button and every held `Key_*` button, and empty the pending
     * pointer/key/wheel queues. Clearing the held keys is what makes gameplay
     * actually go quiet (a movement key held at lock time would otherwise keep
     * polling `true`), and it prevents a key *released* during the lock — whose
     * keyup the guards swallow — from sticking `true` after {@link unlock}. Keys
     * physically still held re-assert via OS key-repeat after unlock.
     */
    lock(): void {
        this.lockDepth += 1;
        if (this.lockDepth !== 1) {
            return;
        }
        if (this.activePointerId !== null) {
            this.element?.releasePointerCapture?.(this.activePointerId);
        }
        this.isPointerDown = false;
        this.activePointerId = null;
        this.setButton('Action_Primary', false);
        this.clearHeldKeyButtons();
        this.pendingPointerEvents = [];
        this.pendingKeyEvents = [];
        this.pendingWheelDelta.set(0, 0);
        this.wheelDelta.set(0, 0);
    }

    /**
     * Release every keyboard-derived button (`Key_*`, set by {@link onKeyDown}).
     * Custom, script-set virtual buttons are left untouched — the lock only
     * silences raw DOM input.
     */
    private clearHeldKeyButtons(): void {
        for (const name of this.buttons.keys()) {
            if (name.startsWith('Key_')) {
                this.buttons.set(name, false);
            }
        }
    }

    /**
     * Release one level of the input lock (floored at 0). Input flows again once
     * the depth returns to 0.
     */
    unlock(): void {
        if (this.lockDepth > 0) {
            this.lockDepth -= 1;
        }
    }

    /** True while the input lock is held (depth > 0). */
    get isLocked(): boolean {
        return this.lockDepth > 0;
    }

    /**
     * Set a virtual axis value (e.g. from a specialized controller or script).
     * @param name Name of the axis (e.g. "Horizontal", "Vertical")
     * @param value Value typically between -1 and 1
     */
    setAxis(name: string, value: number): void {
        this.axes.set(name, value);
    }

    /**
     * Get a virtual axis value.
     * @param name Name of the axis
     * @returns The current value of the axis, or 0 if not set
     */
    getAxis(name: string): number {
        return this.axes.get(name) || 0;
    }

    /**
     * Set a virtual button state.
     * @param name Name of the button (e.g. "Jump", "Fire")
     * @param pressed Whether the button is pressed
     */
    setButton(name: string, pressed: boolean): void {
        this.buttons.set(name, pressed);
    }

    /**
     * Get a virtual button state.
     * @param name Name of the button
     * @returns True if the button is currently pressed
     */
    getButton(name: string): boolean {
        return this.buttons.get(name) || false;
    }

    /**
     * Attach global event listeners to a DOM element.
     * Monitors pointer events to update raw pointer state and trigger global actions.
     * @param element The DOM element (usually canvas) to listen to
     */
    attach(element: HTMLElement): void {
        this.detach(); // detach previous if any
        this.element = element;
        this.previousTouchAction = element.style.touchAction;
        element.style.touchAction = 'none';

        // Initialize dimensions
        const dimensions = this.getInputDimensions();
        this.width = dimensions.width;
        this.height = dimensions.height;
        console.log(`[InputService] Attached to element. Dimensions: ${this.width}x${this.height}`);

        element.addEventListener('pointerdown', this.onPointerDown);
        element.addEventListener('pointermove', this.onPointerMove);
        element.addEventListener('pointerup', this.onPointerUp);
        element.addEventListener('pointercancel', this.onPointerUp);
        element.addEventListener('pointerleave', this.onPointerUp);
        element.addEventListener('wheel', this.onWheel, { passive: false });

        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);

        // Prevent context menu on right click for better game experience
        element.addEventListener('contextmenu', this.onContextMenu);
    }

    /**
     * Remove global event listeners.
     */
    detach(): void {
        if (!this.element) return;

        this.element.removeEventListener('pointerdown', this.onPointerDown);
        this.element.removeEventListener('pointermove', this.onPointerMove);
        this.element.removeEventListener('pointerup', this.onPointerUp);
        this.element.removeEventListener('pointercancel', this.onPointerUp);
        this.element.removeEventListener('pointerleave', this.onPointerUp);
        this.element.removeEventListener('wheel', this.onWheel);
        this.element.removeEventListener('contextmenu', this.onContextMenu);

        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);

        if (this.previousTouchAction !== null) {
            this.element.style.touchAction = this.previousTouchAction;
            this.previousTouchAction = null;
        }

        this.element = null;
        this.isPointerDown = false;
        this.activePointerId = null;
        this.wheelDelta.set(0, 0);
        this.pendingWheelDelta.set(0, 0);
        this.pointerEvents = [];
        this.pendingPointerEvents = [];
        this.keyEvents = [];
        this.pendingKeyEvents = [];
        this.setButton('Action_Primary', false);
        // Never leak a lock into the next scene — the InputService instance is
        // reused across play/stop cycles (a stopped cutscene must not keep the
        // next run muted).
        this.lockDepth = 0;
    }

    private onPointerDown = (event: PointerEvent): void => {
        if (this.lockDepth > 0) {
            return;
        }
        if (this.activePointerId !== null) {
            return;
        }

        this.activePointerId = event.pointerId;
        this.isPointerDown = true;
        const position = this.updatePointerPosition(event);
        this.pendingPointerEvents.push({ type: 'down', pointerId: event.pointerId, x: position.x, y: position.y });
        this.element?.setPointerCapture?.(event.pointerId);

        // Global "Tap to Action" - Map primary pointer down to "Action_Primary"
        this.setButton('Action_Primary', true);
    };

    private onPointerMove = (event: PointerEvent): void => {
        if (this.lockDepth > 0) {
            return;
        }
        if (this.activePointerId !== null && this.activePointerId !== event.pointerId) {
            return;
        }

        const position = this.updatePointerPosition(event);
        if (this.activePointerId === event.pointerId) {
            this.pendingPointerEvents.push({ type: 'move', pointerId: event.pointerId, x: position.x, y: position.y });
        }
    };

    private onPointerUp = (event: PointerEvent): void => {
        if (this.lockDepth > 0) {
            return;
        }
        if (this.activePointerId !== event.pointerId) {
            return;
        }

        this.isPointerDown = false;
        this.activePointerId = null;
        const position = this.updatePointerPosition(event);
        this.pendingPointerEvents.push({ type: 'up', pointerId: event.pointerId, x: position.x, y: position.y });
        this.element?.releasePointerCapture?.(event.pointerId);

        // Release "Action_Primary"
        this.setButton('Action_Primary', false);
    };

    private onContextMenu = (event: Event): void => {
        event.preventDefault();
    };

    private onWheel = (event: WheelEvent): void => {
        // Still swallow the gesture while locked (the page must not scroll behind
        // a cutscene), but accumulate nothing.
        event.preventDefault();
        if (this.lockDepth > 0) {
            return;
        }
        this.pendingWheelDelta.x += event.deltaX;
        this.pendingWheelDelta.y += event.deltaY;
    };

    private onKeyDown = (event: KeyboardEvent): void => {
        if (this.lockDepth > 0) {
            return;
        }
        this.setButton(`Key_${event.code}`, true);
        this.setButton(`Key_${event.key.toUpperCase()}`, true);
        this.pendingKeyEvents.push({ type: 'down', code: event.code, key: event.key, repeat: event.repeat });
    };

    private onKeyUp = (event: KeyboardEvent): void => {
        if (this.lockDepth > 0) {
            return;
        }
        this.setButton(`Key_${event.code}`, false);
        this.setButton(`Key_${event.key.toUpperCase()}`, false);
        this.pendingKeyEvents.push({ type: 'up', code: event.code, key: event.key, repeat: event.repeat });
    };

    private updatePointerPosition(event: PointerEvent): { x: number; y: number } {
        if (!this.element) {
            return { x: this.pointerPosition.x, y: this.pointerPosition.y };
        }

        // Calculate position relative to the element
        const rect = this.element.getBoundingClientRect();
        const dimensions = this.getInputDimensions();
        this.width = dimensions.width;
        this.height = dimensions.height;

        const safeRectWidth = rect.width > 0 ? rect.width : 1;
        const safeRectHeight = rect.height > 0 ? rect.height : 1;
        const scaleX = this.width / safeRectWidth;
        const scaleY = this.height / safeRectHeight;

        const x = (event.clientX - rect.left) * scaleX;
        const y = (event.clientY - rect.top) * scaleY;

        this.pointerPosition.set(x, y);
        return { x, y };
    }

    private getInputDimensions(): { width: number; height: number } {
        if (!this.element) {
            return { width: 0, height: 0 };
        }

        if (this.element instanceof HTMLCanvasElement) {
            const canvasWidth = this.element.width;
            const canvasHeight = this.element.height;
            if (canvasWidth > 0 && canvasHeight > 0) {
                return { width: canvasWidth, height: canvasHeight };
            }
        }

        const rect = this.element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
    }
}
