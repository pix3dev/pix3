import { Script } from '../core/ScriptComponent';
import { defineProperty } from '../fw/property-schema';
import { Vector3 } from 'three';
import { NodeBase } from '../nodes/NodeBase';
import { Node2D } from '../nodes/Node2D';
import { Object3D } from 'three';
import { Camera3D } from '../nodes/3D/Camera3D';

export class PinToNodeBehavior extends Script {
    targetNodeId: string = '';
    yOffset: number = 2.0;

    private targetNode: NodeBase | null = null;
    private cameraNode: Camera3D | null = null;
    private _unsubscribeViewport: (() => void) | null = null;
    private _tempWorldPos = new Vector3();
    private _tempPinnedWorldPos = new Vector3();
    private _tempPinnedLocalPos = new Vector3();

    static override getPropertySchema() {
        return {
            nodeType: 'PinToNodeBehavior',
            properties: [
                defineProperty('targetNodeId', 'node', {
                    ui: { label: 'Target Model', nodeTypes: ['MeshInstance', 'Node3D', 'Sprite3D'] },
                    getValue: (c: unknown) => (c as PinToNodeBehavior).targetNodeId,
                    setValue: (c: unknown, v: unknown) => { 
                        (c as PinToNodeBehavior).setTargetNodeId(String(v));
                    },
                }),
                defineProperty('yOffset', 'number', {
                    ui: { label: 'Y Offset', step: 0.1 },
                    getValue: (c: unknown) => (c as PinToNodeBehavior).yOffset,
                    setValue: (c: unknown, v: unknown) => { 
                        (c as PinToNodeBehavior).yOffset = Number(v); 
                    },
                }),
            ],
            groups: {}
        };
    }

    setTargetNodeId(id: string) {
        this.targetNodeId = id;
        this.targetNode = null;
    }

    private getSceneRoot(): Object3D | null {
        if (!this.node) return null;

        let root: Object3D = this.node;
        while (root.parent) {
            root = root.parent;
        }

        return root;
    }

    private resolveProjectionCamera(root: Object3D | null): Camera3D | null {
        const activeCamera = this.scene?.getActiveCamera() ?? null;
        if (activeCamera) {
            this.cameraNode = activeCamera;
            return activeCamera;
        }

        if (this.cameraNode) {
            return this.cameraNode;
        }

        if (root) {
            this.findCamera(root);
        }

        return this.cameraNode;
    }

    override onStart() {
        this.targetNode = null;
        this.cameraNode = null;

        this._unsubscribeViewport?.();
        this._unsubscribeViewport = this.scene?.onViewportChanged(() => {
            // Triggers re-computation of logical camera size on next update frame.
            this.updatePinning();
        }) ?? null;

        if (!this.node) return;

        const root = this.getSceneRoot();
        if (!root) return;

        if (this.targetNodeId) {
            this.targetNode = this.findNode(this.targetNodeId);
        }

        this.resolveProjectionCamera(root);
        
        // Initial pin update
        this.updatePinning();
    }

    override onDetach() {
        this._unsubscribeViewport?.();
        this._unsubscribeViewport = null;
    }

    private findCamera(node: Object3D) {
        if (node instanceof Camera3D) {
            this.cameraNode = node;
            return;
        }
        for (const child of node.children) {
            this.findCamera(child);
            if (this.cameraNode) return;
        }
    }

    override onUpdate(_dt: number) {
        this.updatePinning();
    }

    private updatePinning() {
        if (!this.node || !(this.node instanceof Node2D)) {
            return;
        }

        const root = this.getSceneRoot();
        if (!root) return;

        if (!this.targetNode && this.targetNodeId) {
            this.targetNode = this.findNode(this.targetNodeId);
        }

        const projectionCamera = this.resolveProjectionCamera(root);
        if (!this.targetNode || !projectionCamera) return;

        const targetObj = this.targetNode as unknown as Object3D;
        const cameraObj = projectionCamera.camera;

        if (!targetObj || !cameraObj) return;

        // Get world position of the target and apply Y offset
        targetObj.updateMatrixWorld(true);
        this._tempWorldPos.setFromMatrixPosition(targetObj.matrixWorld);
        this._tempWorldPos.y += this.yOffset;

        // Project 3D vector to 2D screen space using the camera
        this._tempWorldPos.project(cameraObj);

        const viewport = this.getLogicalCameraSize();
        if (viewport.width <= 0 || viewport.height <= 0) return;

        // Convert NDC (-1..1) to the 2D world space used by SceneRunner's orthographic camera.
        this._tempPinnedWorldPos.set(
            this._tempWorldPos.x * (viewport.width * 0.5),
            this._tempWorldPos.y * (viewport.height * 0.5),
            0
        );

        const parent = this.node.parent;
        if (!parent) return;

        parent.updateMatrixWorld(true);
        this._tempPinnedLocalPos.copy(this._tempPinnedWorldPos);
        parent.worldToLocal(this._tempPinnedLocalPos);

          // Write local coordinates so pinning remains correct under scaled or moved 2D parents.
        this.node.position.set(this._tempPinnedLocalPos.x, this._tempPinnedLocalPos.y, this.node.position.z);
    }

    /**
     * Returns the logical 2D camera dimensions used by SceneRunner's orthographic camera.
      * Mirrors the authored-base-size scaling that SceneRunner computes from project viewport
      * settings vs. the current viewport aspect ratio. Using CSS pixel dimensions here
     * (instead of device pixels) keeps coordinate-space consistent regardless of DPR.
     */
    private getLogicalCameraSize(): { width: number; height: number } {
        const logicalCamera = this.scene?.getLogicalCameraSize();
        if (
            logicalCamera &&
            logicalCamera.width > 0 &&
            logicalCamera.height > 0
        ) {
            return logicalCamera;
        }

        const viewport = this.scene?.getViewportSize();
        const cssWidth = (viewport && viewport.width > 0) ? viewport.width : (window.innerWidth);
        const cssHeight = (viewport && viewport.height > 0) ? viewport.height : (window.innerHeight);

        if (cssWidth <= 0 || cssHeight <= 0) {
            return { width: 1, height: 1 };
        }

        return { width: cssWidth, height: cssHeight };
    }
}
