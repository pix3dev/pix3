/**
 * Runtime Resource Manager
 *
 * Handles loading of assets and resources for the runtime.
 * Supports loading from:
 * - res:// (mapped to base public URL)
 * - file:// (not really supported in web, but mapped to URL)
 * - http:// / https://
 * - blob: / data:
 */
export interface ReadResourceOptions {
    readonly allowNetworkFallback?: boolean;
}
export interface EmbeddedResourceEntry {
    readonly base64: string;
    readonly mimeType?: string;
}
export type EmbeddedResourceMap = Record<string, EmbeddedResourceEntry>;
export declare class ResourceManager {
    private baseUrl;
    private readonly embeddedResources;
    private audioBuffers;
    constructor(baseUrl?: string, embeddedResources?: EmbeddedResourceMap);
    /**
     * Normalize a resource path to a full URL.
     */
    normalize(resource: string): string;
    /**
     * True when this manager was built with an embedded asset map — i.e. a
     * single-file build, where the embedded set is the whole universe of assets
     * and a `res://` miss cannot be found anywhere else.
     */
    get hasEmbeddedResources(): boolean;
    /** Whether a specific resource ships inside this build. */
    hasEmbeddedResource(resource: string): boolean;
    getAudioBuffer(key: string): AudioBuffer | undefined;
    setAudioBuffer(key: string, buffer: AudioBuffer): void;
    readText(resource: string): Promise<string>;
    readBlob(resource: string): Promise<Blob>;
    protected fetchText(url: string): Promise<string>;
    protected fetchBlob(url: string): Promise<Blob>;
    protected getScheme(resource: string): string;
    protected buildUrl(relativePath: string): string;
    private getEmbeddedEntry;
    private toEmbeddedPath;
    private normalizeEmbeddedPath;
    private decodeBase64ToBytes;
}
