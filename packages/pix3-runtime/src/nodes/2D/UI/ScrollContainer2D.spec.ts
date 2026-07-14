import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, Texture, Vector2 } from 'three';

import { Group2D } from '../Group2D';
import { Button2D } from './Button2D';
import { ScrollContainer2D } from './ScrollContainer2D';
import { AudioService } from '../../../core/AudioService';
import { AssetLoader } from '../../../core/AssetLoader';
import { InputService } from '../../../core/InputService';
import { ResourceManager } from '../../../core/ResourceManager';
import { SceneLoader } from '../../../core/SceneLoader';
import { SceneSaver } from '../../../core/SceneSaver';
import type { SceneService } from '../../../core/SceneService';
import { ScriptRegistry } from '../../../core/ScriptRegistry';

function createLoader(preloadTextures: string[] = []): SceneLoader {
    const assetLoader = new AssetLoader(new ResourceManager('/'), new AudioService());
    // Seed the texture cache so loadTexture() short-circuits before any network
    // fetch — res:// URLs 404 under happy-dom and would leak unhandled rejections.
    const cache = (assetLoader as unknown as { textureCache: Map<string, Texture> }).textureCache;
    for (const url of preloadTextures) {
        cache.set(url, new Texture());
    }
    return new SceneLoader(assetLoader, new ScriptRegistry(), new ResourceManager('/'));
}

function getScrollbarMaterials(container: ScrollContainer2D): {
    thumb: MeshBasicMaterial;
    track: MeshBasicMaterial;
} {
    const internals = container as unknown as {
        thumbMaterial: MeshBasicMaterial;
        trackMaterial: MeshBasicMaterial;
    };
    return { thumb: internals.thumbMaterial, track: internals.trackMaterial };
}

function baseOpacityOf(material: MeshBasicMaterial): number {
    return material.userData.__pix3BaseOpacity as number;
}

function createScrollContainer(): { container: ScrollContainer2D; content: Group2D; button: Button2D; input: InputService } {
    const container = new ScrollContainer2D({
        id: 'shop-scroll',
        name: 'Shop Scroll',
        width: 120,
        height: 120,
        showScrollbar: true,
        inertiaEnabled: true,
    });

    const content = new Group2D({
        id: 'shop-content',
        name: 'Shop Content',
        width: 120,
        height: 320,
        position: new Vector2(0, 0),
    });

    const button = new Button2D({
        id: 'upgrade-button',
        name: 'Upgrade Button',
        width: 80,
        height: 40,
        position: new Vector2(0, 0),
    });

    content.adoptChild(button);
    container.adoptChild(content);

    const input = new InputService();
    input.width = 200;
    input.height = 200;
    container.input = input;

    return { container, content, button, input };
}

function createDirectChildrenScrollContainer(): { container: ScrollContainer2D; topTool: Button2D; bottomTool: Button2D; input: InputService } {
    const container = new ScrollContainer2D({
        id: 'direct-scroll',
        name: 'Direct Scroll',
        width: 120,
        height: 120,
        showScrollbar: true,
    });

    const topTool = new Button2D({
        id: 'top-tool',
        name: 'Top Tool',
        width: 60,
        height: 40,
        position: new Vector2(0, 30),
    });
    const bottomTool = new Button2D({
        id: 'bottom-tool',
        name: 'Bottom Tool',
        width: 60,
        height: 40,
        position: new Vector2(0, -150),
    });

    container.adoptChild(topTool);
    container.adoptChild(bottomTool);

    const input = new InputService();
    input.width = 200;
    input.height = 200;
    container.input = input;

    return { container, topTool, bottomTool, input };
}

describe('ScrollContainer2D', () => {
    it('scrolls with wheel input, clamps to content height, and updates the content offset', () => {
        const { container, content, input } = createScrollContainer();

        expect(container.type).toBe('ScrollContainer2D');

        input.pointerPosition.set(100, 100);
        input.wheelDelta.set(0, 48);
        container.tick(1 / 60);

        expect(container.scrollY).toBeCloseTo(48, 5);
        expect(content.position.y).toBeCloseTo(48, 5);

        input.wheelDelta.set(0, 400);
        container.tick(1 / 60);

        expect(container.scrollY).toBe(100);
        expect(content.position.y).toBe(100);
    });

    it('supports drag scrolling with inertia after release', () => {
        const { container, input } = createScrollContainer();

        input.pointerPosition.set(100, 100);
        input.isPointerDown = true;
        container.tick(1 / 60);

        input.pointerPosition.set(100, 70);
        container.tick(1 / 60);

        input.pointerPosition.set(100, 20);
        container.tick(1 / 60);

        expect(container.scrollY).toBeGreaterThan(40);

        input.isPointerDown = false;
        container.tick(1 / 60);
        const releasedScrollY = container.scrollY;

        container.tick(1 / 60);
        container.tick(1 / 60);

        expect(container.scrollY).toBeGreaterThan(releasedScrollY);
    });

    it('blocks descendant UI interaction when the pointer is outside the viewport or the container is dragging', () => {
        const { container, button, input } = createScrollContainer();
        let pressCount = 0;
        button.onPressed = () => {
            pressCount += 1;
        };

        input.pointerPosition.set(100, 100);
        input.isPointerDown = true;
        container.tick(1 / 60);

        expect(pressCount).toBe(1);

        input.isPointerDown = false;
        container.tick(1 / 60);

        container.scrollY = 120;
        input.pointerPosition.set(100, 100);
        input.isPointerDown = true;
        container.tick(1 / 60);

        expect(pressCount).toBe(1);

        container.scrollY = 0;
        input.pointerPosition.set(100, 100);
        input.isPointerDown = true;
        container.tick(1 / 60);
        input.pointerPosition.set(100, 40);
        container.tick(1 / 60);
        container.tick(1 / 60);

        expect(container.hasActivePointerCapture()).toBe(true);
        expect(pressCount).toBe(2);
    });

    it('applies clipping planes to descendant materials while the content overflows', () => {
        const { container, button } = createScrollContainer();

        container.tick(1 / 60);

        const buttonMesh = button.children[0] as unknown as Mesh;
        const buttonMaterial = buttonMesh.material as MeshBasicMaterial;
        expect(buttonMaterial.clippingPlanes).toHaveLength(4);
    });

    it('applies a thumb texture, forces full base opacity, and keeps the map through a sync', () => {
        const { container } = createScrollContainer();
        const { thumb } = getScrollbarMaterials(container);
        const thumbTexture = new Texture();

        container.setScrollbarThumbTexture(thumbTexture);
        expect(thumb.map).toBe(thumbTexture);
        expect(baseOpacityOf(thumb)).toBe(1);

        // A tick runs syncScrollbarVisuals, which re-applies the tint color; the
        // map must survive it.
        container.tick(1 / 60);
        expect(thumb.map).toBe(thumbTexture);
    });

    it('keeps the thumb texture map when the scrollbar geometry is rebuilt on width change', () => {
        const { container } = createScrollContainer();
        const { thumb } = getScrollbarMaterials(container);
        const thumbTexture = new Texture();
        container.setScrollbarThumbTexture(thumbTexture);

        container.scrollbarWidth = 16;
        container.tick(1 / 60); // triggers a geometry rebuild inside syncScrollbarVisuals

        expect(thumb.map).toBe(thumbTexture);
    });

    it('applies a track texture and restores base opacities when cleared', () => {
        const { container } = createScrollContainer();
        const { thumb, track } = getScrollbarMaterials(container);
        const trackTexture = new Texture();

        container.setScrollbarTrackTexture(trackTexture);
        expect(track.map).toBe(trackTexture);
        expect(baseOpacityOf(track)).toBe(1);

        container.setScrollbarTrackTexture(null);
        expect(track.map).toBeNull();
        expect(baseOpacityOf(track)).toBeCloseTo(0.18, 5);

        container.setScrollbarThumbTexture(null);
        expect(baseOpacityOf(thumb)).toBeCloseTo(0.92, 5);
    });

    it('serializes and restores scrollbar thumb and track texture refs', async () => {
        const container = new ScrollContainer2D({
            id: 'tex-scroll',
            name: 'Tex Scroll',
            width: 120,
            height: 120,
            scrollbarThumbTexture: { type: 'texture', url: 'res://ui/thumb.png' },
            scrollbarTrackTexture: 'res://ui/track.png',
        });
        const content = new Group2D({ id: 'tex-content', name: 'Tex Content', width: 120, height: 320 });
        container.adoptChild(content);

        const saver = new SceneSaver();
        const yaml = saver.serializeScene({
            version: '1.0.0',
            metadata: {},
            rootNodes: [container],
            nodeMap: new Map([
                [container.nodeId, container],
                [content.nodeId, content],
            ]),
        });

        expect(yaml).toContain('res://ui/thumb.png');
        expect(yaml).toContain('res://ui/track.png');

        const graph = await createLoader([
            'res://ui/thumb.png',
            'res://ui/track.png',
        ]).parseScene(yaml, { filePath: 'res://scenes/scroll.pix3scene' });
        const loaded = graph.rootNodes[0] as ScrollContainer2D;

        expect(loaded.scrollbarThumbTexture?.url).toBe('res://ui/thumb.png');
        expect(loaded.scrollbarTrackTexture?.url).toBe('res://ui/track.png');
    });

    it('serializes and parses the node with its scroll properties', async () => {
        const container = new ScrollContainer2D({
            id: 'scroll-container',
            name: 'Scroll Container',
            width: 220,
            height: 140,
            scrollY: 42,
            dragScrollEnabled: true,
            wheelScrollEnabled: false,
            inertiaEnabled: true,
            showScrollbar: true,
            scrollbarWidth: 12,
            scrollbarInset: 6,
            scrollbarMinHeight: 18,
            scrollbarColor: '#ffeeaa',
            scrollbarTrackColor: '#222244',
            position: new Vector2(40, -30),
        });

        const content = new Group2D({
            id: 'scroll-content',
            name: 'Scroll Content',
            width: 220,
            height: 300,
        });
        container.adoptChild(content);

        const saver = new SceneSaver();
        const yaml = saver.serializeScene({
            version: '1.0.0',
            metadata: {},
            rootNodes: [container],
            nodeMap: new Map([
                [container.nodeId, container],
                [content.nodeId, content],
            ]),
        });

        expect(yaml).toContain('type: ScrollContainer2D');
        expect(yaml).toContain('scrollY: 42');
        expect(yaml).toContain('wheelScrollEnabled: false');

        const graph = await createLoader().parseScene(yaml, { filePath: 'res://scenes/scroll.pix3scene' });
        const loaded = graph.rootNodes[0] as ScrollContainer2D;

        expect(loaded).toBeInstanceOf(ScrollContainer2D);
        expect(loaded.type).toBe('ScrollContainer2D');
        expect(loaded.scrollY).toBe(42);
        expect(loaded.width).toBe(220);
        expect(loaded.height).toBe(140);
        expect(loaded.wheelScrollEnabled).toBe(false);
        expect(loaded.scrollbarWidth).toBe(12);
        expect(loaded.scrollbarInset).toBe(6);
    });

    it('scrolls multiple direct Node2D children together for the scene authoring pattern used in DeepCore', () => {
        const { container, topTool, bottomTool, input } = createDirectChildrenScrollContainer();

        expect(container.getContentNode()).toBe(null);
        expect(container.getMaxScrollY()).toBe(110);

        input.pointerPosition.set(100, 100);
        input.wheelDelta.set(0, 70);
        container.tick(1 / 60);

        expect(container.scrollY).toBe(70);
        expect(topTool.position.y).toBeCloseTo(100, 5);
        expect(bottomTool.position.y).toBeCloseTo(-80, 5);

        input.wheelDelta.set(0, 200);
        container.tick(1 / 60);

        expect(container.scrollY).toBe(110);
        expect(topTool.position.y).toBeCloseTo(140, 5);
        expect(bottomTool.position.y).toBeCloseTo(-40, 5);
    });

    it('does not mutate authored child transforms when scrollY is assigned outside the game loop', () => {
        const { container, topTool, bottomTool } = createDirectChildrenScrollContainer();

        // Editor-style assignment (inspector edit, prefab instance override):
        // children keep their authored positions until the game loop runs.
        container.scrollY = 70;

        expect(container.scrollY).toBe(70);
        expect(container.properties.scrollY).toBe(70);
        expect(topTool.position.y).toBe(30);
        expect(bottomTool.position.y).toBe(-150);

        container.tick(1 / 60);

        expect(topTool.position.y).toBeCloseTo(100, 5);
        expect(bottomTool.position.y).toBeCloseTo(-80, 5);
    });

    it('maps button hit testing through the logical camera size instead of raw input resolution', () => {
        const { container, button, input } = createScrollContainer();
        const logicalSize = { width: 1000, height: 1000 };
        let pressCount = 0;

        container.scene = {
            getLogicalCameraSize: () => logicalSize,
            // No UI camera in this fixture → pointer mapping falls back to the
            // logical-size path these tests exercise (matches the pre-Camera2D setup).
            getUICamera: () => null,
        } as unknown as SceneService;

        button.position.set(40, 40, 0);
        button.onPressed = () => {
            pressCount += 1;
        };

        input.pointerPosition.set(
            ((button.position.x + logicalSize.width / 2) / logicalSize.width) * input.width,
            ((logicalSize.height / 2 - button.position.y) / logicalSize.height) * input.height,
        );
        input.isPointerDown = true;

        container.tick(1 / 60);

        expect(pressCount).toBe(1);
    });

    it('uses logical camera coordinates when deciding whether wheel scrolling is inside the viewport', () => {
        const { container, input } = createScrollContainer();
        const logicalSize = { width: 1000, height: 1000 };

        container.scene = {
            getLogicalCameraSize: () => logicalSize,
            getUICamera: () => null,
        } as unknown as SceneService;
        container.position.set(-120, 150, 0);

        input.pointerPosition.set(
            ((container.position.x + logicalSize.width / 2) / logicalSize.width) * input.width,
            ((logicalSize.height / 2 - container.position.y) / logicalSize.height) * input.height,
        );
        input.wheelDelta.set(0, 32);

        container.tick(1 / 60);

        expect(container.scrollY).toBeCloseTo(32, 5);
    });
});