export interface TextureResourceRef {
    type: 'texture';
    url: string;
}
export declare function isTextureResourceRef(value: unknown): value is TextureResourceRef;
export declare function coerceTextureResource(value: unknown): TextureResourceRef | null;
