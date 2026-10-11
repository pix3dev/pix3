import { Script } from '../core/ScriptComponent';
export declare class PinToNodeBehavior extends Script {
    targetNodeId: string;
    yOffset: number;
    private targetNode;
    private cameraNode;
    private _unsubscribeViewport;
    private _tempWorldPos;
    private _tempPinnedWorldPos;
    private _tempPinnedLocalPos;
    static getPropertySchema(): {
        nodeType: string;
        properties: import("..").PropertyDefinition[];
        groups: {};
    };
    setTargetNodeId(id: string): void;
    private getSceneRoot;
    private resolveProjectionCamera;
    onStart(): void;
    onDetach(): void;
    private findCamera;
    onUpdate(_dt: number): void;
    private updatePinning;
    /**
     * Returns the logical 2D camera dimensions used by SceneRunner's orthographic camera.
     * Mirrors the authored-base-size scaling that SceneRunner computes from project viewport
     * settings vs. the current viewport aspect ratio. Using CSS pixel dimensions here
     * (instead of device pixels) keeps coordinate-space consistent regardless of DPR.
     */
    private getLogicalCameraSize;
}
