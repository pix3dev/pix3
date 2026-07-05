import {
    Mesh,
    MeshBasicMaterial,
    Plane,
    PlaneGeometry,
    type Material,
    type Object3D,
    type Texture,
    Vector2,
    Vector3,
} from 'three';

import { Group2D, type Group2DProps } from '../Group2D';
import { Node2D } from '../../Node2D';
import { OVERLAY_2D_FLAG } from '../../../core/render-order-2d';
import { coerceTextureResource, type TextureResourceRef } from '../../../core/TextureResource';
import { configure2DTexture } from '../../../core/configure-2d-texture';
import type { PropertySchema } from '../../../fw/property-schema';

export interface ScrollContainer2DProps extends Group2DProps {
    scrollY?: number;
    dragScrollEnabled?: boolean;
    wheelScrollEnabled?: boolean;
    inertiaEnabled?: boolean;
    showScrollbar?: boolean;
    wheelSensitivity?: number;
    dragThreshold?: number;
    inertiaDamping?: number;
    scrollbarWidth?: number;
    scrollbarMinHeight?: number;
    scrollbarInset?: number;
    scrollbarColor?: string;
    scrollbarTrackColor?: string;
    scrollbarThumbTexture?: TextureResourceRef | string | null;
    scrollbarTrackTexture?: TextureResourceRef | string | null;
}

type PointerDragMode = 'content' | 'thumb' | null;

export class ScrollContainer2D extends Group2D {
    dragScrollEnabled: boolean;
    wheelScrollEnabled: boolean;
    inertiaEnabled: boolean;
    showScrollbar: boolean;
    wheelSensitivity: number;
    dragThreshold: number;
    inertiaDamping: number;
    scrollbarWidth: number;
    scrollbarMinHeight: number;
    scrollbarInset: number;
    scrollbarColor: string;
    scrollbarTrackColor: string;
    scrollbarThumbTexture: TextureResourceRef | null;
    scrollbarTrackTexture: TextureResourceRef | null;

    private _scrollY: number;
    private readonly tmpWorldPos = new Vector3();
    private readonly tmpWorldScale = new Vector3();
    private readonly pointerWorld = new Vector2();
    private readonly clippingPlanes = [
        new Plane(new Vector3(1, 0, 0), 0),
        new Plane(new Vector3(-1, 0, 0), 0),
        new Plane(new Vector3(0, 1, 0), 0),
        new Plane(new Vector3(0, -1, 0), 0),
    ];
    private readonly appliedClippingMaterials = new Set<Material>();
    private readonly childBasePositions = new Map<string, Vector3>();
    private dragMode: PointerDragMode = null;
    private pointerStartedInside = false;
    private pointerWasDown = false;
    private lastAppliedScrollY = 0;
    private lastPointerWorldY = 0;
    private pointerDownWorldY = 0;
    private pointerDownScrollY = 0;
    private scrollVelocity = 0;
    private thumbHeight = 0;
    private thumbCenterY = 0;
    private trackCenterX = 0;
    private trackGeometry: PlaneGeometry;
    private thumbGeometry: PlaneGeometry;
    private readonly trackMaterial: MeshBasicMaterial;
    private readonly thumbMaterial: MeshBasicMaterial;
    private readonly trackMesh: Mesh;
    private readonly thumbMesh: Mesh;

    constructor(props: ScrollContainer2DProps) {
        super(props, 'ScrollContainer2D');

        this.dragScrollEnabled = props.dragScrollEnabled ?? true;
        this.wheelScrollEnabled = props.wheelScrollEnabled ?? true;
        this.inertiaEnabled = props.inertiaEnabled ?? true;
        this.showScrollbar = props.showScrollbar ?? true;
        this.wheelSensitivity = props.wheelSensitivity ?? 1;
        this.dragThreshold = Math.max(0, props.dragThreshold ?? 6);
        this.inertiaDamping = Math.max(0.01, props.inertiaDamping ?? 14);
        this.scrollbarWidth = Math.max(2, props.scrollbarWidth ?? 8);
        this.scrollbarMinHeight = Math.max(8, props.scrollbarMinHeight ?? 24);
        this.scrollbarInset = Math.max(0, props.scrollbarInset ?? 8);
        this.scrollbarColor = props.scrollbarColor ?? '#f5f7ff';
        this.scrollbarTrackColor = props.scrollbarTrackColor ?? '#ffffff';
        this.scrollbarThumbTexture = coerceTextureResource(props.scrollbarThumbTexture ?? null);
        this.scrollbarTrackTexture = coerceTextureResource(props.scrollbarTrackTexture ?? null);
        this._scrollY = Math.max(0, props.scrollY ?? 0);

        this.trackGeometry = new PlaneGeometry(this.scrollbarWidth, Math.max(1, this.height));
        this.thumbGeometry = new PlaneGeometry(this.scrollbarWidth, Math.max(1, this.height));

        this.trackMaterial = new MeshBasicMaterial({
            color: this.scrollbarTrackColor,
            transparent: true,
            opacity: 0.18,
            depthTest: false,
        });
        this.thumbMaterial = new MeshBasicMaterial({
            color: this.scrollbarColor,
            transparent: true,
            opacity: 0.92,
            depthTest: false,
        });

        this.registerOpacityMaterial(this.trackMaterial, 0.18);
        this.registerOpacityMaterial(this.thumbMaterial, 0.92);

        // The scrollbar must float above the scrolled content (which is added as
        // child nodes), so mark it as an overlay for the 2D render-order pass.
        // The renderOrder values order the track below the thumb within the overlay.
        this.trackMesh = new Mesh(this.trackGeometry, this.trackMaterial);
        this.trackMesh.renderOrder = 1000;
        this.trackMesh.userData[OVERLAY_2D_FLAG] = true;
        this.trackMesh.position.z = 0.25;
        this.trackMesh.visible = false;
        this.trackMesh.name = `${this.name}-ScrollbarTrack`;
        this.add(this.trackMesh);

        this.thumbMesh = new Mesh(this.thumbGeometry, this.thumbMaterial);
        this.thumbMesh.renderOrder = 1001;
        this.thumbMesh.userData[OVERLAY_2D_FLAG] = true;
        this.thumbMesh.position.z = 0.3;
        this.thumbMesh.visible = false;
        this.thumbMesh.name = `${this.name}-ScrollbarThumb`;
        this.add(this.thumbMesh);
    }

    get scrollY(): number {
        return this._scrollY;
    }

    set scrollY(value: number) {
        const maxScrollY = this.hasScrollableChildren() ? this.getMaxScrollY() : Number.POSITIVE_INFINITY;
        const nextValue = ScrollContainer2D.clampScroll(value, maxScrollY);
        if (this._scrollY === nextValue) {
            return;
        }

        // Store only — the child offset is applied by tick(), i.e. exclusively
        // inside the game loop. Assignments outside it (inspector edits, prefab
        // instance overrides during load) must never mutate the authored child
        // transforms: those writes leaked into saved scenes / prefab override
        // diffs and compounded the offset on every load.
        this._scrollY = nextValue;
        this.properties.scrollY = nextValue;
        this.syncScrollbarVisuals();
    }

    /** Assign the loaded thumb Texture (called by SceneLoader after loading). */
    setScrollbarThumbTexture(texture: Texture | null): void {
        if (texture) {
            // sRGB + mipmaps disabled (see configure2DTexture for the why).
            configure2DTexture(texture);
        }
        this.thumbMaterial.map = texture;
        // The flat-color thumb rides at 0.92 base opacity; a texture wants to show
        // its own alpha, so force full opacity while textured and restore on clear.
        this.setOpacityMaterialBase(this.thumbMaterial, texture ? 1 : 0.92);
        this.thumbMaterial.needsUpdate = true;
    }

    /** Assign the loaded track Texture (called by SceneLoader after loading). */
    setScrollbarTrackTexture(texture: Texture | null): void {
        if (texture) {
            configure2DTexture(texture);
        }
        this.trackMaterial.map = texture;
        // The flat-color track sits at 0.18 base opacity, which would render a
        // texture nearly invisible; force full opacity while textured.
        this.setOpacityMaterialBase(this.trackMaterial, texture ? 1 : 0.18);
        this.trackMaterial.needsUpdate = true;
    }

    private setScrollbarThumbTextureRef(value: unknown): void {
        const ref = coerceTextureResource(value);
        const changed = this.scrollbarThumbTexture?.url !== ref?.url;
        this.scrollbarThumbTexture = ref;
        // The node has no asset loader; a new ref is loaded by SceneLoader on the
        // next scene load / play. Only clearing can be reflected immediately.
        if (changed && !ref) {
            this.setScrollbarThumbTexture(null);
        }
    }

    private setScrollbarTrackTextureRef(value: unknown): void {
        const ref = coerceTextureResource(value);
        const changed = this.scrollbarTrackTexture?.url !== ref?.url;
        this.scrollbarTrackTexture = ref;
        if (changed && !ref) {
            this.setScrollbarTrackTexture(null);
        }
    }

    hasActivePointerCapture(): boolean {
        return this.dragMode !== null;
    }

    isPointInViewportBounds(worldPoint: Vector2): boolean {
        this.getWorldPosition(this.tmpWorldPos);
        this.getWorldScale(this.tmpWorldScale);
        const halfWidth = (this.width * Math.abs(this.tmpWorldScale.x)) / 2;
        const halfHeight = (this.height * Math.abs(this.tmpWorldScale.y)) / 2;
        const dx = Math.abs(worldPoint.x - this.tmpWorldPos.x);
        const dy = Math.abs(worldPoint.y - this.tmpWorldPos.y);
        return dx <= halfWidth && dy <= halfHeight;
    }

    getContentNode(): Node2D | null {
        const scrollableChildren = this.getScrollableChildren();
        return scrollableChildren.length === 1 ? scrollableChildren[0] : null;
    }

    getContentHeight(): number {
        const contentBounds = this.getContentBounds();
        if (!contentBounds) {
            return 0;
        }

        return Math.max(0, contentBounds.maxY - contentBounds.minY);
    }

    getMaxScrollY(): number {
        const contentBounds = this.getContentBounds();
        if (!contentBounds) {
            return 0;
        }

        const viewportBottom = -this.height / 2;
        return Math.max(0, viewportBottom - contentBounds.minY);
    }

    override tick(dt: number): void {
        this.updatePointerAndScroll(dt);
        this.applyScrollOffset();
        this.applyClippingPlanes();
        this.syncScrollbarVisuals();
        super.tick(dt);
    }

    static getPropertySchema(): PropertySchema {
        const baseSchema = Group2D.getPropertySchema();
        return {
            nodeType: 'ScrollContainer2D',
            extends: 'Group2D',
            properties: [
                ...baseSchema.properties,
                {
                    name: 'scrollY',
                    type: 'number',
                    ui: { label: 'Scroll Y', group: 'Scroll', min: 0, step: 1, precision: 0 },
                    getValue: (node: unknown) => (node as ScrollContainer2D).scrollY,
                    setValue: (node: unknown, value: unknown) => {
                        (node as ScrollContainer2D).scrollY = Number(value);
                    },
                },
                {
                    name: 'dragScrollEnabled',
                    type: 'boolean',
                    ui: { label: 'Drag Scroll', group: 'Scroll' },
                    getValue: (node: unknown) => (node as ScrollContainer2D).dragScrollEnabled,
                    setValue: (node: unknown, value: unknown) => {
                        (node as ScrollContainer2D).dragScrollEnabled = Boolean(value);
                    },
                },
                {
                    name: 'wheelScrollEnabled',
                    type: 'boolean',
                    ui: { label: 'Wheel Scroll', group: 'Scroll' },
                    getValue: (node: unknown) => (node as ScrollContainer2D).wheelScrollEnabled,
                    setValue: (node: unknown, value: unknown) => {
                        (node as ScrollContainer2D).wheelScrollEnabled = Boolean(value);
                    },
                },
                {
                    name: 'inertiaEnabled',
                    type: 'boolean',
                    ui: { label: 'Inertia', group: 'Scroll' },
                    getValue: (node: unknown) => (node as ScrollContainer2D).inertiaEnabled,
                    setValue: (node: unknown, value: unknown) => {
                        (node as ScrollContainer2D).inertiaEnabled = Boolean(value);
                    },
                },
                {
                    name: 'showScrollbar',
                    type: 'boolean',
                    ui: { label: 'Show Scrollbar', group: 'Scrollbar' },
                    getValue: (node: unknown) => (node as ScrollContainer2D).showScrollbar,
                    setValue: (node: unknown, value: unknown) => {
                        (node as ScrollContainer2D).showScrollbar = Boolean(value);
                    },
                },
                {
                    name: 'wheelSensitivity',
                    type: 'number',
                    ui: { label: 'Wheel Sensitivity', group: 'Scroll', min: 0.1, step: 0.1, precision: 2 },
                    getValue: (node: unknown) => (node as ScrollContainer2D).wheelSensitivity,
                    setValue: (node: unknown, value: unknown) => {
                        (node as ScrollContainer2D).wheelSensitivity = Math.max(0.1, Number(value));
                    },
                },
                {
                    name: 'dragThreshold',
                    type: 'number',
                    ui: { label: 'Drag Threshold', group: 'Scroll', min: 0, step: 1, precision: 0 },
                    getValue: (node: unknown) => (node as ScrollContainer2D).dragThreshold,
                    setValue: (node: unknown, value: unknown) => {
                        (node as ScrollContainer2D).dragThreshold = Math.max(0, Number(value));
                    },
                },
                {
                    name: 'inertiaDamping',
                    type: 'number',
                    ui: { label: 'Inertia Damping', group: 'Scroll', min: 0.01, step: 0.1, precision: 2 },
                    getValue: (node: unknown) => (node as ScrollContainer2D).inertiaDamping,
                    setValue: (node: unknown, value: unknown) => {
                        (node as ScrollContainer2D).inertiaDamping = Math.max(0.01, Number(value));
                    },
                },
                {
                    name: 'scrollbarWidth',
                    type: 'number',
                    ui: { label: 'Width', group: 'Scrollbar', min: 2, step: 1, precision: 0 },
                    getValue: (node: unknown) => (node as ScrollContainer2D).scrollbarWidth,
                    setValue: (node: unknown, value: unknown) => {
                        (node as ScrollContainer2D).scrollbarWidth = Math.max(2, Number(value));
                    },
                },
                {
                    name: 'scrollbarMinHeight',
                    type: 'number',
                    ui: { label: 'Min Height', group: 'Scrollbar', min: 8, step: 1, precision: 0 },
                    getValue: (node: unknown) => (node as ScrollContainer2D).scrollbarMinHeight,
                    setValue: (node: unknown, value: unknown) => {
                        (node as ScrollContainer2D).scrollbarMinHeight = Math.max(8, Number(value));
                    },
                },
                {
                    name: 'scrollbarInset',
                    type: 'number',
                    ui: { label: 'Inset', group: 'Scrollbar', min: 0, step: 1, precision: 0 },
                    getValue: (node: unknown) => (node as ScrollContainer2D).scrollbarInset,
                    setValue: (node: unknown, value: unknown) => {
                        (node as ScrollContainer2D).scrollbarInset = Math.max(0, Number(value));
                    },
                },
                {
                    name: 'scrollbarColor',
                    type: 'color',
                    ui: { label: 'Thumb Color', group: 'Scrollbar' },
                    getValue: (node: unknown) => (node as ScrollContainer2D).scrollbarColor,
                    setValue: (node: unknown, value: unknown) => {
                        const target = node as ScrollContainer2D;
                        target.scrollbarColor = String(value);
                        target.thumbMaterial.color.setStyle(target.scrollbarColor);
                    },
                },
                {
                    name: 'scrollbarTrackColor',
                    type: 'color',
                    ui: { label: 'Track Color', group: 'Scrollbar' },
                    getValue: (node: unknown) => (node as ScrollContainer2D).scrollbarTrackColor,
                    setValue: (node: unknown, value: unknown) => {
                        const target = node as ScrollContainer2D;
                        target.scrollbarTrackColor = String(value);
                        target.trackMaterial.color.setStyle(target.scrollbarTrackColor);
                    },
                },
                {
                    name: 'scrollbarThumbTexture',
                    type: 'object',
                    ui: { label: 'Thumb Sprite', group: 'Scrollbar', editor: 'texture-resource', resourceType: 'texture' },
                    getValue: (node: unknown) =>
                        (node as ScrollContainer2D).scrollbarThumbTexture ?? { type: 'texture', url: '' },
                    setValue: (node: unknown, value: unknown) => {
                        (node as ScrollContainer2D).setScrollbarThumbTextureRef(value);
                    },
                },
                {
                    name: 'scrollbarTrackTexture',
                    type: 'object',
                    ui: { label: 'Track Sprite', group: 'Scrollbar', editor: 'texture-resource', resourceType: 'texture' },
                    getValue: (node: unknown) =>
                        (node as ScrollContainer2D).scrollbarTrackTexture ?? { type: 'texture', url: '' },
                    setValue: (node: unknown, value: unknown) => {
                        (node as ScrollContainer2D).setScrollbarTrackTextureRef(value);
                    },
                },
            ],
            groups: {
                ...baseSchema.groups,
                Scroll: { label: 'Scroll', expanded: true },
                Scrollbar: { label: 'Scrollbar', expanded: true },
            },
        };
    }

    dispose(): void {
        this.clearClippingPlanes();
        this.trackGeometry.dispose();
        this.thumbGeometry.dispose();
        this.trackMaterial.dispose();
        this.thumbMaterial.dispose();
    }

    private updatePointerAndScroll(dt: number): void {
        const input = this.input;
        if (!input) {
            this.pointerWasDown = false;
            return;
        }

        const pointerWorld = this.getPointerWorldPosition(this.pointerWorld);
        if (!pointerWorld) {
            this.pointerWasDown = false;
            return;
        }

        const pointerInBounds = this.isPointInViewportBounds(pointerWorld);
        if (pointerInBounds || this.dragMode !== null) {
            input.registerHover(this.nodeId);
        }

        const isPointerDown = input.isPointerDown;

        if (!this.pointerWasDown && isPointerDown) {
            this.pointerStartedInside = pointerInBounds;
            this.pointerDownWorldY = pointerWorld.y;
            this.lastPointerWorldY = pointerWorld.y;
            this.pointerDownScrollY = this.scrollY;
            this.scrollVelocity = 0;

            if (pointerInBounds && this.isPointInThumbBounds(pointerWorld)) {
                this.dragMode = 'thumb';
            }
        } else if (this.pointerWasDown && !isPointerDown) {
            this.pointerStartedInside = false;
            this.dragMode = null;
        }

        if (this.wheelScrollEnabled && pointerInBounds && input.wheelDelta.y !== 0) {
            this.scrollY += input.wheelDelta.y * this.wheelSensitivity;
            this.scrollVelocity = 0;
        }

        if (isPointerDown && this.dragMode === 'thumb') {
            const travel = Math.max(1, this.height - this.thumbHeight);
            const scrollRange = Math.max(0, this.getMaxScrollY());
            if (scrollRange > 0) {
                const deltaY = this.pointerWorld.y - this.pointerDownWorldY;
                this.scrollY = this.pointerDownScrollY - (deltaY * scrollRange) / travel;
            }
        } else if (this.dragScrollEnabled && isPointerDown && this.pointerStartedInside) {
            const deltaFromStart = this.pointerWorld.y - this.pointerDownWorldY;
            if (this.dragMode === 'content') {
                const deltaY = this.pointerWorld.y - this.lastPointerWorldY;
                this.scrollY += deltaY;
                const safeDt = Math.max(1 / 240, dt);
                this.scrollVelocity = deltaY / safeDt;
            } else if (Math.abs(deltaFromStart) >= this.dragThreshold && this.getMaxScrollY() > 0) {
                this.dragMode = 'content';
                this.lastPointerWorldY = this.pointerWorld.y;
            }
        } else if (!isPointerDown && this.dragMode === null && this.inertiaEnabled && Math.abs(this.scrollVelocity) > 0.5) {
            const decay = Math.exp(-this.inertiaDamping * Math.max(0, dt));
            const averageVelocity = this.scrollVelocity * (1 + decay) * 0.5;
            this.scrollY += averageVelocity * Math.max(0, dt);
            this.scrollVelocity *= decay;
            if (Math.abs(this.scrollVelocity) < 0.5) {
                this.scrollVelocity = 0;
            }
        }

        if (!isPointerDown && (this.scrollY <= 0 || this.scrollY >= this.getMaxScrollY())) {
            this.scrollVelocity = 0;
        }

        this.lastPointerWorldY = this.pointerWorld.y;
        this.pointerWasDown = isPointerDown;
        this.scrollY = this._scrollY;
    }

    private getScrollableChildren(): Node2D[] {
        const scrollableChildren: Node2D[] = [];
        for (const child of this.children) {
            if (child instanceof Node2D) {
                scrollableChildren.push(child);
            }
        }
        return scrollableChildren;
    }

    private hasScrollableChildren(): boolean {
        return this.getScrollableChildren().length > 0;
    }

    private applyScrollOffset(): void {
        const scrollableChildren = this.getScrollableChildren();
        if (scrollableChildren.length === 0) {
            this.lastAppliedScrollY = 0;
            return;
        }

        const clampedScrollY = ScrollContainer2D.clampScroll(this._scrollY, this.getMaxScrollY());
        if (!ScrollContainer2D.areClose(this._scrollY, clampedScrollY)) {
            this._scrollY = clampedScrollY;
        }

        for (const child of scrollableChildren) {
            const basePosition = this.syncChildBasePosition(child);
            child.position.set(basePosition.x, basePosition.y + clampedScrollY, basePosition.z);
        }

        this.lastAppliedScrollY = clampedScrollY;
    }

    private syncChildBasePosition(child: Node2D): Vector3 {
        const existingPosition = this.childBasePositions.get(child.nodeId);
        if (!existingPosition) {
            const nextBasePosition = child.position.clone();
            this.childBasePositions.set(child.nodeId, nextBasePosition);
            return nextBasePosition;
        }

        const expectedY = existingPosition.y + this.lastAppliedScrollY;
        if (
            !ScrollContainer2D.areClose(child.position.x, existingPosition.x) ||
            !ScrollContainer2D.areClose(child.position.z, existingPosition.z) ||
            !ScrollContainer2D.areClose(child.position.y, expectedY)
        ) {
            existingPosition.set(
                child.position.x,
                child.position.y - this.lastAppliedScrollY,
                child.position.z
            );
        }

        return existingPosition;
    }

    private applyClippingPlanes(): void {
        const scrollableChildren = this.getScrollableChildren();
        if (scrollableChildren.length === 0) {
            this.clearClippingPlanes();
            return;
        }

        this.getWorldPosition(this.tmpWorldPos);
        this.getWorldScale(this.tmpWorldScale);

        const halfWidth = (this.width * Math.abs(this.tmpWorldScale.x)) / 2;
        const halfHeight = (this.height * Math.abs(this.tmpWorldScale.y)) / 2;
        const left = this.tmpWorldPos.x - halfWidth;
        const right = this.tmpWorldPos.x + halfWidth;
        const bottom = this.tmpWorldPos.y - halfHeight;
        const top = this.tmpWorldPos.y + halfHeight;

        this.clippingPlanes[0].constant = -left;
        this.clippingPlanes[1].constant = right;
        this.clippingPlanes[2].constant = -bottom;
        this.clippingPlanes[3].constant = top;

        const nextMaterials = new Set<Material>();
        for (const scrollableChild of scrollableChildren) {
            scrollableChild.traverse((child: Object3D) => {
                const meshLike = child as Object3D & { material?: Material | Material[] };
                if (!meshLike.material) {
                    return;
                }

                const materials = Array.isArray(meshLike.material) ? meshLike.material : [meshLike.material];
                for (const material of materials) {
                    material.clippingPlanes = this.clippingPlanes;
                    material.clipIntersection = false;
                    material.needsUpdate = true;
                    nextMaterials.add(material);
                }
            });
        }

        for (const material of this.appliedClippingMaterials) {
            if (!nextMaterials.has(material)) {
                material.clippingPlanes = null;
                material.needsUpdate = true;
            }
        }

        this.appliedClippingMaterials.clear();
        for (const material of nextMaterials) {
            this.appliedClippingMaterials.add(material);
        }
    }

    private clearClippingPlanes(): void {
        for (const material of this.appliedClippingMaterials) {
            material.clippingPlanes = null;
            material.needsUpdate = true;
        }
        this.appliedClippingMaterials.clear();
    }

    private syncScrollbarVisuals(): void {
        const contentHeight = this.getContentHeight();
        const maxScrollY = this.getMaxScrollY();
        const shouldShowScrollbar = this.showScrollbar && contentHeight > this.height + 0.001;

        this.trackMesh.visible = shouldShowScrollbar;
        this.thumbMesh.visible = shouldShowScrollbar;
        if (!shouldShowScrollbar) {
            return;
        }

        this.trackCenterX = this.width / 2 - this.scrollbarInset - this.scrollbarWidth / 2;

        const safeTrackHeight = Math.max(1, this.height);
        const thumbRatio = safeTrackHeight / Math.max(safeTrackHeight, contentHeight);
        this.thumbHeight = Math.max(this.scrollbarMinHeight, Math.min(safeTrackHeight, safeTrackHeight * thumbRatio));
        const trackTravel = Math.max(0, safeTrackHeight - this.thumbHeight);
        const progress = maxScrollY > 0 ? Math.min(1, this.scrollY / maxScrollY) : 0;

        this.thumbCenterY = safeTrackHeight / 2 - this.thumbHeight / 2 - progress * trackTravel;
        this.trackMesh.position.set(this.trackCenterX, 0, 0.25);
        this.thumbMesh.position.set(this.trackCenterX, this.thumbCenterY, 0.3);

        if (
            !ScrollContainer2D.areClose(this.trackGeometry.parameters.width, this.scrollbarWidth) ||
            !ScrollContainer2D.areClose(this.trackGeometry.parameters.height, safeTrackHeight)
        ) {
            this.trackGeometry.dispose();
            this.trackGeometry = new PlaneGeometry(this.scrollbarWidth, safeTrackHeight);
            this.trackMesh.geometry = this.trackGeometry;
        }

        if (
            !ScrollContainer2D.areClose(this.thumbGeometry.parameters.width, this.scrollbarWidth) ||
            !ScrollContainer2D.areClose(this.thumbGeometry.parameters.height, this.thumbHeight)
        ) {
            this.thumbGeometry.dispose();
            this.thumbGeometry = new PlaneGeometry(this.scrollbarWidth, this.thumbHeight);
            this.thumbMesh.geometry = this.thumbGeometry;
        }

        this.trackMaterial.color.setStyle(this.scrollbarTrackColor);
        this.thumbMaterial.color.setStyle(this.scrollbarColor);
    }

    private getContentBounds(): { minY: number; maxY: number } | null {
        const scrollableChildren = this.getScrollableChildren();
        if (scrollableChildren.length === 0) {
            return null;
        }

        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;

        for (const child of scrollableChildren) {
            const basePosition = this.syncChildBasePosition(child);
            const extents = this.getChildVerticalExtents(child);
            minY = Math.min(minY, basePosition.y + extents.minY);
            maxY = Math.max(maxY, basePosition.y + extents.maxY);
        }

        if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
            return null;
        }

        return { minY, maxY };
    }

    private getChildVerticalExtents(child: Node2D): { minY: number; maxY: number } {
        const size = child.getCurrentLayoutSize();
        const height = Math.max(0, size.height);
        const childWithOptionalAnchor = child as Node2D & { anchor?: { y?: number } };
        const anchorY = ScrollContainer2D.clampNormalizedAnchor(childWithOptionalAnchor.anchor?.y ?? 0.5);
        return {
            minY: -anchorY * height,
            maxY: (1 - anchorY) * height,
        };
    }

    private isPointInThumbBounds(worldPoint: Vector2): boolean {
        if (!this.showScrollbar || !this.thumbMesh.visible) {
            return false;
        }

        this.getWorldPosition(this.tmpWorldPos);
        this.getWorldScale(this.tmpWorldScale);

        const centerX = this.tmpWorldPos.x + this.trackCenterX * this.tmpWorldScale.x;
        const centerY = this.tmpWorldPos.y + this.thumbCenterY * this.tmpWorldScale.y;
        const halfWidth = (this.scrollbarWidth * Math.abs(this.tmpWorldScale.x)) / 2;
        const halfHeight = (this.thumbHeight * Math.abs(this.tmpWorldScale.y)) / 2;

        return (
            worldPoint.x >= centerX - halfWidth &&
            worldPoint.x <= centerX + halfWidth &&
            worldPoint.y >= centerY - halfHeight &&
            worldPoint.y <= centerY + halfHeight
        );
    }

    private static areClose(left: number, right: number): boolean {
        return Math.abs(left - right) <= 0.001;
    }

    private static clampScroll(value: number, maxScrollY: number): number {
        const safeValue = Number.isFinite(value) ? value : 0;
        const safeMax = Number.isFinite(maxScrollY) ? Math.max(0, maxScrollY) : safeValue;
        return Math.max(0, Math.min(safeValue, safeMax));
    }

    private static clampNormalizedAnchor(value: number): number {
        if (!Number.isFinite(value)) {
            return 0.5;
        }
        return Math.max(0, Math.min(1, value));
    }
}