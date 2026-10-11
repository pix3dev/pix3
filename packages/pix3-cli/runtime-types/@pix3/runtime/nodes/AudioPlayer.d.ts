import { NodeBase, type NodeBaseProps } from './NodeBase';
import type { PropertySchema } from '../fw/property-schema';
import { type AudioBusName } from '../core/AudioService';
export interface AudioPlayerProps extends Omit<NodeBaseProps, 'type'> {
    audioTrack?: string | null;
    autoplay?: boolean;
    loop?: boolean;
    volume?: number;
    bus?: string;
    pitchVariation?: number;
    volumeVariation?: number;
}
export declare class AudioPlayer extends NodeBase {
    audioTrack: string | null;
    autoplay: boolean;
    loop: boolean;
    volume: number;
    bus: AudioBusName;
    pitchVariation: number;
    volumeVariation: number;
    private playback;
    private autoPlayed;
    constructor(props: AudioPlayerProps);
    get treeIcon(): string;
    tick(dt: number): void;
    play(): Promise<void>;
    stop(): void;
    /**
     * Live authored config for the saver. AudioPlayer schema setters write
     * instance fields (not the `properties` bag), so — like Camera2D /
     * VirtualCamera3D — the saver must read them back through here. Without this,
     * inspector edits were serialized from the stale load-time `properties`.
     */
    serializeConfig(): Record<string, unknown>;
    static getPropertySchema(): PropertySchema;
    private static normalizeTrack;
    private static toBoolean;
    private static clampVolume;
    private static normalizeBus;
    private static clampVariation;
}
