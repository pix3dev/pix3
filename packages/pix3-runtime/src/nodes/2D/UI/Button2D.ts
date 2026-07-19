import {
    Mesh,
    MeshBasicMaterial,
    type Texture,
    Vector2,
} from 'three';
import { UIControl2D, type UIControl2DProps } from './UIControl2D';
import type { PropertySchema } from '../../../fw/property-schema';
import { coerceTextureResource, type TextureResourceRef } from '../../../core/TextureResource';
import { configure2DTexture } from '../../../core/configure-2d-texture';
import { SHARED_UNIT_QUAD_GEOMETRY } from '../../../core/shared-quad-geometry';
import { BATCHABLE_2D_KEY } from '../../../core/batch-2d';
import { getActiveLocalization } from '../../../core/localization/active-localization';

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
    stateTextureKeys?: Partial<Record<Button2DSpriteState, string>>;
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
    /**
     * Localization sprite keys per interaction state, resolved through the active
     * locale table's `sprites` section (skins with baked text that differ per
     * language). A resolvable key wins over the authored state texture ref; the
     * ref stays as the universal fallback. Missing/empty entries = not localized.
     */
    stateTextureKeys: Partial<Record<Button2DSpriteState, string>>;

    private buttonMesh: Mesh;
    private buttonMaterial: MeshBasicMaterial;
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
        this.stateTextureKeys = { ...(props.stateTextureKeys ?? {}) };

        // Create button mesh. Size lives on mesh.scale over the shared unit quad
        // so the skin can be quad-batched (see SHARED_UNIT_QUAD_GEOMETRY).
        this.buttonMaterial = new MeshBasicMaterial({
            color: this.backgroundColor,
            transparent: true,
            opacity: 1.0,
            depthTest: false,
        });
        this.registerSkinMaterial(this.buttonMaterial);
        this.buttonMesh = new Mesh(SHARED_UNIT_QUAD_GEOMETRY, this.buttonMaterial);
        this.buttonMesh.scale.set(this.width, this.height, 1);
        this.buttonMesh.renderOrder = 999;
        this.buttonMesh.userData[BATCHABLE_2D_KEY] = true;
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

    /**
     * The texture path that should actually be loaded for a state: the locale
     * table's `sprites[stateTextureKeys[state]]` for the active locale, else the
     * authored state texture ref. Single source of truth for the SceneLoader and
     * the locale-change re-resolve walk.
     */
    getEffectiveStateTexturePath(state: Button2DSpriteState): string | null {
        const key = this.stateTextureKeys[state];
        if (key) {
            const localized = getActiveLocalization()?.trSprite(key);
            if (localized) return localized;
        }
        switch (state) {
            case 'normal':
                return this.textureNormal?.url ?? null;
            case 'hover':
                return this.textureHover?.url ?? null;
            case 'pressed':
                return this.texturePressed?.url ?? null;
            case 'disabled':
                return this.textureDisabled?.url ?? null;
        }
    }

    /** Whether any interaction state carries a localization sprite key. */
    hasLocalizedStateTextures(): boolean {
        return Boolean(
            this.stateTextureKeys.normal ||
            this.stateTextureKeys.hover ||
            this.stateTextureKeys.pressed ||
            this.stateTextureKeys.disabled
        );
    }

    private setStateTextureKey(state: Button2DSpriteState, value: unknown): void {
        const key = String(value ?? '');
        if ((this.stateTextureKeys[state] ?? '') === key) return;
        if (key) {
            this.stateTextureKeys[state] = key;
        } else {
            delete this.stateTextureKeys[state];
        }
        // The loaded Texture may no longer match; the SceneLoader / locale walk
        // reloads from the effective path on the next load or locale change.
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
                        btn.buttonMesh.scale.set(btn.width, btn.height, 1);
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
                        btn.buttonMesh.scale.set(btn.width, btn.height, 1);
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
                {
                    name: 'textureNormalKey',
                    type: 'string',
                    ui: { label: 'Normal Sprite Key', group: 'Skin', editor: 'localization-key', description: 'Localization sprite key for the normal state (wins over the authored sprite when resolvable)' },
                    getValue: (n) => (n as Button2D).stateTextureKeys.normal ?? '',
                    setValue: (n, v) => { (n as Button2D).setStateTextureKey('normal', v); },
                },
                {
                    name: 'textureHoverKey',
                    type: 'string',
                    ui: { label: 'Hover Sprite Key', group: 'Skin', editor: 'localization-key', description: 'Localization sprite key for the hover state' },
                    getValue: (n) => (n as Button2D).stateTextureKeys.hover ?? '',
                    setValue: (n, v) => { (n as Button2D).setStateTextureKey('hover', v); },
                },
                {
                    name: 'texturePressedKey',
                    type: 'string',
                    ui: { label: 'Pressed Sprite Key', group: 'Skin', editor: 'localization-key', description: 'Localization sprite key for the pressed state' },
                    getValue: (n) => (n as Button2D).stateTextureKeys.pressed ?? '',
                    setValue: (n, v) => { (n as Button2D).setStateTextureKey('pressed', v); },
                },
                {
                    name: 'textureDisabledKey',
                    type: 'string',
                    ui: { label: 'Disabled Sprite Key', group: 'Skin', editor: 'localization-key', description: 'Localization sprite key for the disabled state' },
                    getValue: (n) => (n as Button2D).stateTextureKeys.disabled ?? '',
                    setValue: (n, v) => { (n as Button2D).setStateTextureKey('disabled', v); },
                },
            ],
            groups: {
                ...baseSchema.groups,
                Button: { label: 'Button', expanded: true },
            },
        };
    }
}
