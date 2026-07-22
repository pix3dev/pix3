// Service lifetime types
export const ServiceLifetime = {
  Singleton: 'singleton',
  Transient: 'transient',
} as const;
export type ServiceLifetimeOption = (typeof ServiceLifetime)[keyof typeof ServiceLifetime];

/** Generic constructor type for dependency injection */
type Constructor<T = unknown> = new (...args: never[]) => T;

// Base service interface
export interface IService {
  dispose?(): void;
}

// Service descriptor interface
interface ServiceDescriptor<T = unknown> {
  token: symbol;
  implementation: new () => T;
  lifetime: ServiceLifetimeOption;
}

// Main container class
export class ServiceContainer {
  private static instance: ServiceContainer;
  private services = new Map<symbol, ServiceDescriptor>();
  private singletonInstances = new Map<symbol, unknown>();
  private stringTokenRegistry = new Map<string, symbol>();
  private constructorTokenRegistry = new WeakMap<Constructor, symbol>();

  static getInstance(): ServiceContainer {
    if (!ServiceContainer.instance) {
      ServiceContainer.instance = new ServiceContainer();
    }
    return ServiceContainer.instance;
  }

  // Register a service
  addService<T>(token: symbol, implementation: Constructor<T>, lifetime: ServiceLifetimeOption) {
    const existingDescriptor = this.services.get(token);
    if (
      existingDescriptor &&
      existingDescriptor.implementation === implementation &&
      existingDescriptor.lifetime === lifetime
    ) {
      return;
    }

    // If a service is re-registered, remove any existing cached singleton instance so
    // tests and runtime can replace implementations without stale instances.
    if (this.singletonInstances.has(token)) {
      const existing = this.singletonInstances.get(token) as IService | undefined;
      try {
        existing?.dispose?.();
      } catch {
        // swallow disposal errors during re-registration
      }
      this.singletonInstances.delete(token);
    }

    this.services.set(token, { token, implementation, lifetime });
  }

  // Retrieve an existing token or create a new one
  getOrCreateToken(service: symbol | string | Constructor): symbol {
    if (typeof service === 'symbol') {
      return service;
    }

    if (typeof service === 'string') {
      if (!service) {
        throw new Error('Cannot derive DI token from an empty service name.');
      }

      if (!this.stringTokenRegistry.has(service)) {
        this.stringTokenRegistry.set(service, Symbol(service));
      }

      return this.stringTokenRegistry.get(service)!;
    }

    if (!service) {
      throw new Error('Cannot derive service token for DI. Provide a class, string, or symbol.');
    }

    let token = this.constructorTokenRegistry.get(service);
    if (!token) {
      token = Symbol(service.name || 'anonymous-service');
      this.constructorTokenRegistry.set(service, token);
    }

    return token;
  }

  // Get service instance
  getService<T = unknown>(token: symbol): T {
    const descriptor = this.services.get(token) as ServiceDescriptor<T> | undefined;

    if (!descriptor) {
      throw new Error(`Service not registered for token: ${token.toString()}`);
    }

    if (descriptor.lifetime === ServiceLifetime.Singleton) {
      return this.getSingletonInstance(descriptor) as T;
    }

    if (descriptor.lifetime === ServiceLifetime.Transient) {
      return new descriptor.implementation() as T;
    }

    throw new Error(`Unsupported lifetime: ${descriptor.lifetime}`);
  }

  private getSingletonInstance<T>(descriptor: ServiceDescriptor<T>): T {
    if (!this.singletonInstances.has(descriptor.token)) {
      this.singletonInstances.set(descriptor.token, new descriptor.implementation());
    }
    return this.singletonInstances.get(descriptor.token) as T;
  }
}

// Service decorator (similar to @Injectable in Blazor)
export function injectable(
  lifetime: ServiceLifetimeOption = ServiceLifetime.Singleton
): <T extends Constructor>(target: T) => void {
  return function <T extends Constructor>(target: T): void {
    const container = ServiceContainer.getInstance();
    const token = container.getOrCreateToken(target);
    container.addService(token, target, lifetime);
  };
}

// Inject decorator (auto-detects type if not provided)
import 'reflect-metadata';

export function inject<T>(serviceType?: Constructor<T>) {
  return function (target: object, propertyKey: string | symbol) {
    // If no explicit type, use reflect-metadata to get the property type
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const type = serviceType || (Reflect as any).getMetadata('design:type', target, propertyKey);
    if (!type) {
      throw new Error(
        `Cannot resolve type for property '${String(propertyKey)}'. Make sure emitDecoratorMetadata is enabled.`
      );
    }
    const container = ServiceContainer.getInstance();
    const token = container.getOrCreateToken(type);
    const descriptor = {
      get: function (this: object) {
        try {
          return container.getService<T>(token);
        } catch (error) {
          const hostName =
            (this as { constructor?: { name?: string } }).constructor?.name ?? 'UnknownHost';
          const dependencyName =
            typeof type === 'function' && type.name ? type.name : String(propertyKey);
          const message = `Failed to inject "${dependencyName}" into "${hostName}.${String(propertyKey)}".`;
          const cause = error instanceof Error ? error.message : String(error);
          throw new Error(`${message} ${cause}`);
        }
      },
      enumerable: true,
      configurable: true,
    };
    Object.defineProperty(target, propertyKey, descriptor);
  };
}

/** Async accessor for a lazily-loaded service. */
export type LazyService<T> = () => Promise<T>;

/**
 * Like {@link inject}, but the service class is loaded via dynamic `import()` on
 * first access, keeping heavy modules out of the eager bundle. The decorated
 * property becomes a `LazyService<T>` — call `await this.foo()` to resolve.
 *
 * Only the module import is cached; the service is resolved through the
 * container on every accessor call, so re-registration is observed and
 * lifetimes (singleton/transient) behave exactly like `@inject`. The loader
 * must return the service CLASS (registered via `@injectable` in its own
 * module). Use sparingly: `@inject` remains the default. Reach for this only
 * when the service is heavy AND its consumers only touch it inside async flows
 * (e.g. Monaco IntelliSense, playable export).
 */
export function injectLazy<T>(load: () => Promise<Constructor<T>>) {
  return function (target: object, propertyKey: string | symbol) {
    let modulePromise: Promise<Constructor<T>> | undefined;
    Object.defineProperty(target, propertyKey, {
      get: function (this: object): LazyService<T> {
        return () => {
          if (!modulePromise) {
            modulePromise = load();
            // A failed load must not latch: clear the cache so the next call
            // retries. The `.catch` here only observes the rejection to avoid
            // an unhandled-rejection warning; callers still see the original
            // error via the promise returned below.
            modulePromise.catch(() => {
              modulePromise = undefined;
            });
          }
          return modulePromise.then(ctor => {
            const container = ServiceContainer.getInstance();
            try {
              return container.getService<T>(container.getOrCreateToken(ctor));
            } catch (error) {
              const hostName =
                (this as { constructor?: { name?: string } }).constructor?.name ?? 'UnknownHost';
              const dependencyName = ctor.name || String(propertyKey);
              const message = `Failed to lazily inject "${dependencyName}" into "${hostName}.${String(propertyKey)}".`;
              const cause = error instanceof Error ? error.message : String(error);
              throw new Error(`${message} ${cause}`);
            }
          });
        };
      },
      enumerable: true,
      configurable: true,
    });
  };
}
