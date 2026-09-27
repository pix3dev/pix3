import type { ServiceContainer } from '@/fw/di';

/**
 * Resolve a service when the container has it, else null — for the co-authoring hooks inside
 * operations that also run under minimal test containers (which register only what the test
 * needs). Errors thrown by a REGISTERED service's construction still propagate.
 */
export function optionalService<T>(
  container: Pick<ServiceContainer, 'getOrCreateToken' | 'getService'> &
    Partial<Pick<ServiceContainer, 'hasService'>>,
  type: new (...args: never[]) => T
): T | null {
  const token = container.getOrCreateToken(type);
  if (typeof container.hasService === 'function') {
    return container.hasService(token) ? container.getService<T>(token) : null;
  }
  try {
    return container.getService<T>(token);
  } catch {
    return null;
  }
}
