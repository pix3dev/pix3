/**
 * Reverse index of signal connections, keyed by the connection's *target*.
 *
 * `NodeBase` stores connections on the emitter, which is all `emit` needs. The
 * reverse direction — "every node this script is listening to" — is what lets a
 * detached script drop the handlers it connected on OTHER nodes
 * (`gameRoot.connect('score', this, this.onScore)` from a HUD script), not just
 * the ones on its own node. Without it a freed script keeps receiving signals and
 * its closures keep its node alive.
 *
 * Internal to the runtime (not re-exported from the package index). Only the
 * connect/disconnect paths touch it; `emit` never does.
 */
/** Minimal emitter surface, so this module needs no value import of `NodeBase`. */
export interface SignalLinkHost {
    disconnect(signalName: string, target: unknown, method: (...args: unknown[]) => void): void;
}
export interface SignalTargetLink {
    readonly host: SignalLinkHost;
    readonly signal: string;
    method: (...args: unknown[]) => void;
}
export declare function registerSignalTargetLink(target: unknown, link: SignalTargetLink): void;
export declare function unregisterSignalTargetLink(target: unknown, link: SignalTargetLink): void;
/**
 * Disconnect every handler `target` connected on any node. Safe to call more than
 * once and after an emitter was disposed (a disposed node already unregistered its
 * links; a stray one resolves to a no-op `disconnect`).
 */
export declare function disconnectSignalTargetEverywhere(target: unknown): void;
