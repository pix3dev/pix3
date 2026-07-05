import {
    Mesh,
    MeshBasicMaterial,
    PlaneGeometry,
    type Texture,
    Vector2,
} from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';
import { coerceTextureResource, type TextureResourceRef } from '../../../core/TextureResource';
import { configure2DTexture } from '../../../core/configure-2d-texture';

export type Button2DSpriteState = 'normal' | 'hover' | 'pressed' | 'disabled';

export interface Button2DProps extends UIControl2DProps {
    width?: number;
    height?: number;
    backgroundColor?: string;
    hoverColor?: string;
    pressedColor?: string;
    buttonAction?: string;
    textureNormal?: TextureResourceRef | string | null;
    textureHover?: TextureResourceRef | string | null;
    texturePressed?: TextureResourceRef | string | null;
    textureDisabled?: TextureResourceRef | string | null;
}

/**
 * A clickable button control for 2D UI.
 * Emits virtual button presses and supports click callbacks.
 *
 * Skin: each interaction state (normal/hover/pressed/disabled) may set its own
 * sprite. A missing state sprite falls back to the normal sprite; with no sprites
 * at all the button keeps its flat-color behavior (backgroundColor/hoverColor/
 * pressedColor). The actual Texture objects are supplied post-construction by the
 * SceneLoader (nodes have no asset loader); the schema stores only resource refs.
 */
export class Button2D extends UIControl2D {
    width: number;
    height: number;
    backgroundColor: string;
    hoverColor: string;
    pressedColor: string;
    buttonAction: string;
    textureNormal: TextureResourceRef | null;
    textureHover: TextureResourceRef | null;
    texturePressed: TextureResourceRef | null;
    textureDisabled: TextureResourceRef | null;

    private buttonMesh: Mesh;
    private buttonMaterial: MeshBasicMaterial;
    private geometry: PlaneGeometry;
    private readonly stateTextures: Record<Button2DSpriteState, Texture | null> = {
        normal: null,
        hover: null,
        pressed: null,
        disabled: null,
    };

    constructor(props: Button2DProps) {
        super(props, 'Button2D');

        this.width = props.width ?? 100;
        this.height = props.height ?? 40;
        this.backgroundColor = props.backgroundColor ?? '#4a4a4a';
        this.hoverColor = props.hoverColor ?? '#5a5a5a';
        this.pressedColor = props.pressedColor ?? '#3a3a3a';
        this.buttonAction = props.buttonAction ?? 'Submit';
        this.textureNormal = coerceTextureResource(props.textureNormal ?? null);
        this.textureHover = coerceTextureResource(props.textureHover ?? null);
        this.texturePressed = coerceTextureResource(props.texturePressed ?? null);
        this.textureDisabled = coerceTextureResource(props.textureDisabled ?? null);

        // Create button mesh
        this.geometry = new PlaneGeometry(this.width, this.height);
        this.buttonMaterial = new MeshBasicMaterial({
            color: this.backgroundColor,
            transparent: true,
            opacity: 1.0,
            depthTest: false,
        });
        this.registerSkinMaterial(this.buttonMaterial);
        this.buttonMesh = new Mesh(this.geometry, this.buttonMaterial);
        this.buttonMesh.renderOrder = 999;
        this.add(this.buttonMesh);

        this.refreshSkinState();
    }

    override isPointInBounds(worldPoint: Vector2): boolean {
        this.getWorldPosition(this.tmpWorldPos);
        const dx = Math.abs(worldPoint.x - this.tmpWorldPos.x);
        const dy = Math.abs(worldPoint.y - this.tmpWorldPos.y);
        return dx <= this.width / 2 && dy <= this.height / 2;
    }

    override tick(dt: number): void {
        super.tick(dt);
        if (!this.input) return;

        const isDown = this.input.isPointerDown;
        const pointerWorld = this.getPointerWorldPosition();
        if (!pointerWorld) return;

        this.updatePointerState(pointerWorld.x, pointerWorld.y, isDown);
    }

    protected override onPress(isPressed: boolean): void {
        this.refreshSkinState();
        this.input?.setButton(this.buttonAction, isPressed);
    }

    protected override onHover(_isHovering: boolean): void {
        this.refreshSkinState();
    }

    protected override onEnabledChanged(enabled: boolean): void {
        // A control disabled mid-press never receives its release, so clear the
        // pressed state and the virtual button explicitly to avoid a stuck input.
        if (!enabled && this.isPressed) {
            this.isPressed = false;
            this.input?.setButton(this.buttonAction, false);
        }
        this.refreshSkinState();
    }

    /**
     * Route the legacy base skin texture (UIControl2D.texturePath) through state
     * resolution so its async load callback cannot clobber a state-specific map.
     */
    protected override applySkinTexture(texture: Texture | null): void {
        this.skinTexture = texture;
        this.refreshSkinState();
    }

    /** Assign the loaded Texture for a state (called by SceneLoader after loading). */
    setStateTexture(state: Button2DSpriteState, texture: Texture | null): void {
        if (texture) {
            // sRGB + mipmaps disabled (see configure2DTexture for the why).
            configure2DTexture(texture);
        }
        this.stateTextures[state] = texture;
        this.refreshSkinState();
    }

    private resolveStateTexture(): Texture | null {
        // Legacy single-skin texture acts as the effective-normal fallback.
        const normal = this.stateTextures.normal ?? this.skinTexture;
        if (!this.enabled) {
            return this.stateTextures.disabled ?? normal;
        }
        if (this.isPressed) {
            return this.stateTextures.pressed ?? normal;
        }
        if (this.isHovering) {
            return this.stateTextures.hover ?? normal;
        }
        return normal;
    }

    private resolveStateColor(): string {
        if (!this.enabled) {
            return this.backgroundColor;
        }
        if (this.isPressed) {
            return this.pressedColor;
        }
        if (this.isHovering) {
            return this.hoverColor;
        }
        return this.backgroundColor;
    }

    /** Apply the texture or flat color for the current interaction state. */
    private refreshSkinState(): void {
        if (!this.buttonMaterial) {
            return; // guard: called before the material exists during construction
        }
        const texture = this.resolveStateTexture();
        const hadMap = this.buttonMaterial.map !== null;
        if (texture) {
            this.buttonMaterial.map = texture;
            this.buttonMaterial.color.set('#ffffff');
            this.buttonMaterial.transparent = true;
        } else {
            this.buttonMaterial.map = null;
            this.buttonMaterial.color.setStyle(this.resolveStateColor());
        }
        // Only a change in map presence needs a shader recompile; state swaps
        // between textures or colors happen every frame and must stay cheap.
        if (hadMap !== (texture !== null)) {
            this.buttonMaterial.needsUpdate = true;
        }
    }

    private setStateTextureRef(state: Button2DSpriteState, value: unknown): void {
        const ref = coerceTextureResource(value);
        let previous: TextureResourceRef | null = null;
        switch (state) {
            case 'normal':
                previous = this.textureNormal;
                this.textureNormal = ref;
                break;
            case 'hover':
                previous = this.textureHover;
                this.textureHover = ref;
                break;
            case 'pressed':
                previous = this.texturePressed;
                this.texturePressed = ref;
                break;
            case 'disabled':
                previous = this.textureDisabled;
                this.textureDisabled = ref;
                break;
        }
        if (previous?.url !== ref?.url) {
            // The previously loaded Texture no longer matches the ref; drop it.
            // SceneLoader reloads from the ref on the next scene load / play.
            this.stateTextures[state] = null;
            this.refreshSkinState();
        }
    }

    static getPropertySchema(): PropertySchema {
        const baseSchema = UIControl2D.getPropertySchema();
        return {
            nodeType: 'Button2D',
            extends: 'UIControl2D',
            properties: [
                ...baseSchema.properties,
                {
                    name: 'width',
                    type: 'number',
                    ui: { label: 'Width', group: 'Button', min: 10, max: 500, step: 1 },
                    getValue: (n) => (n as Button2D).width,
                    setValue: (n, v) => {
                        const btn = n as Button2D;
                        btn.width = Number(v);
                        btn.geometry.dispose();
                        btn.geometry = new PlaneGeometry(btn.width, btn.height);
                        btn.buttonMesh.geometry = btn.geometry;
                    },
                },
                {
                    name: 'height',
                    type: 'number',
                    ui: { label: 'Height', group: 'Button', min: 10, max: 500, step: 1 },
                    getValue: (n) => (n as Button2D).height,
                    setValue: (n, v) => {
                        const btn = n as Button2D;
                        btn.height = Number(v);
                        btn.geometry.dispose();
                        btn.geometry = new PlaneGeometry(btn.width, btn.height);
                        btn.buttonMesh.geometry = btn.geometry;
                    },
                },
                {
                    name: 'backgroundColor',
                    type: 'string',
                    ui: { label: 'Color', group: 'Button' },
                    getValue: (n) => (n as Button2D).backgroundColor,
                    setValue: (n, v) => {
                        const btn = n as Button2D;
                        btn.backgroundColor = String(v);
                        btn.refreshSkinState();
                    },
                },
                {
                    name: 'hoverColor',
                    type: 'string',
                    ui: { label: 'Hover Color', group: 'Button' },
                    getValue: (n) => (n as Button2D).hoverColor,
                    setValue: (n, v) => {
                        const btn = n as Button2D;
                        btn.hoverColor = String(v);
                        btn.refreshSkinState();
                    },
                },
                {
                    name: 'pressedColor',
                    type: 'string',
                    ui: { label: 'Pressed Color', group: 'Button' },
                    getValue: (n) => (n as Button2D).pressedColor,
                    setValue: (n, v) => {
                        const btn = n as Button2D;
                        btn.pressedColor = String(v);
                        btn.refreshSkinState();
                    },
                },
                {
                    name: 'buttonAction',
                    type: 'string',
                    ui: { label: 'Button Action', group: 'Input', description: 'Virtual button name' },
                    getValue: (n) => (n as Button2D).buttonAction,
                    setValue: (n, v) => { (n as Button2D).buttonAction = String(v); },
                },
                {
                    name: 'textureNormal',
                    type: 'object',
                    ui: { label: 'Normal Sprite', group: 'Skin', editor: 'texture-resource', resourceType: 'texture' },
                    getValue: (n) => (n as Button2D).textureNormal ?? { type: 'texture', url: '' },
                    setValue: (n, v) => { (n as Button2D).setStateTextureRef('normal', v); },
                },
                {
                    name: 'textureHover',
                    type: 'object',
                    ui: { label: 'Hover Sprite', group: 'Skin', editor: 'texture-resource', resourceType: 'texture' },
                    getValue: (n) => (n as Button2D).textureHover ?? { type: 'texture', url: '' },
                    setValue: (n, v) => { (n as Button2D).setStateTextureRef('hover', v); },
                },
                {
                    name: 'texturePressed',
                    type: 'object',
                    ui: { label: 'Pressed Sprite', group: 'Skin', editor: 'texture-resource', resourceType: 'texture' },
                    getValue: (n) => (n as Button2D).texturePressed ?? { type: 'texture', url: '' },
                    setValue: (n, v) => { (n as Button2D).setStateTextureRef('pressed', v); },
                },
                {
                    name: 'textureDisabled',
                    type: 'object',
                    ui: { label: 'Disabled Sprite', group: 'Skin', editor: 'texture-resource', resourceType: 'texture' },
                    getValue: (n) => (n as Button2D).textureDisabled ?? { type: 'texture', url: '' },
                    setValue: (n, v) => { (n as Button2D).setStateTextureRef('disabled', v); },
                },
            ],
            groups: {
                ...baseSchema.groups,
                Button: { label: 'Button', expanded: true },
            },
        };
    }
}
