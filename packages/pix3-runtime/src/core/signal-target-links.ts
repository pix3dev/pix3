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

const linksByTarget = new WeakMap<object, Set<SignalTargetLink>>();

const isLinkable = (target: unknown): target is object =>
  (typeof target === 'object' && target !== null) || typeof target === 'function';

export function registerSignalTargetLink(target: unknown, link: SignalTargetLink): void {
  if (!isLinkable(target)) {
    return;
  }
  let links = linksByTarget.get(target);
  if (!links) {
    links = new Set();
    linksByTarget.set(target, links);
  }
  links.add(link);
}

export function unregisterSignalTargetLink(target: unknown, link: SignalTargetLink): void {
  if (!isLinkable(target)) {
    return;
  }
  const links = linksByTarget.get(target);
  if (!links) {
    return;
  }
  links.delete(link);
  if (links.size === 0) {
    linksByTarget.delete(target);
  }
}

/**
 * Disconnect every handler `target` connected on any node. Safe to call more than
 * once and after an emitter was disposed (a disposed node already unregistered its
 * links; a stray one resolves to a no-op `disconnect`).
 */
export function disconnectSignalTargetEverywhere(target: unknown): void {
  if (!isLinkable(target)) {
    return;
  }
  const links = linksByTarget.get(target);
  if (!links) {
    return;
  }
  linksByTarget.delete(target);
  for (const link of links) {
    try {
      link.host.disconnect(link.signal, target, link.method);
    } catch (error) {
      console.error('[signals] Failed to disconnect a detached target', {
        signal: link.signal,
        error,
      });
    }
  }
}
