import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, Vector2 } from 'three';

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

function createLoader(): SceneLoader {
    return new SceneLoader(
        new AssetLoader(new ResourceManager('/'), new AudioService()),
        new ScriptRegistry(),
        new ResourceManager('/'),
    );
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

    it('maps button hit testing through the logical camera size instead of raw input resolution', () => {
        const { container, button, input } = createScrollContainer();
        const logicalSize = { width: 1000, height: 1000 };
        let pressCount = 0;

        container.scene = {
            getLogicalCameraSize: () => logicalSize,
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