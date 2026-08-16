import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Sliding-window request budgets.
 *
 * Generalised from the per-IP room-creation bucket in `rooms-router.ts`, which was the only rate
 * limit this server had — leaving `/api/auth/login` open to unthrottled password guessing,
 * `/api/auth/register` open to filling the users table, and `/api/preview/sessions` open to
 * allocating six-hour sessions in a loop.
 *
 * In-process and therefore per-instance: two replicas mean two budgets. That is the honest scope of
 * a limiter with no shared store, and it is still the difference between a few hundred guesses an
 * hour and a few million. A deployment that grows past one instance wants Redis here, not a bigger
 * number.
 *
 * Time is injected rather than read from `Date.now()` so the window can be tested without sleeping.
 */

export interface RateLimitOptions {
  /** Requests allowed per window. `<= 0` disables the limiter entirely. */
  readonly limit: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /**
   * Cap on tracked keys. Past it, keys whose hits have all aged out are dropped — otherwise the map
   * grows one entry per distinct client forever, which is its own denial of service.
   */
  readonly maxKeys?: number;
  /** Injectable clock. */
  readonly now?: () => number;
}

export interface RateLimiter {
  /** Records a hit and reports whether it is within budget. */
  consume(key: string): boolean;
  /** Milliseconds until `key` frees a slot; `0` when it already has one. */
  retryAfterMs(key: string): number;
  /** Drops all state. For tests and for a caller that wants to reset a key set. */
  reset(): void;
}

const DEFAULT_MAX_KEYS = 4096;

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const { limit, windowMs } = options;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, number[]>();

  function live(key: string, at: number): number[] {
    const windowStart = at - windowMs;
    return (buckets.get(key) ?? []).filter(hit => hit > windowStart);
  }

  return {
    consume(key) {
      if (limit <= 0) {
        return true;
      }

      const at = now();
      const hits = live(key, at);

      if (hits.length >= limit) {
        // Store the pruned list even on refusal, so a key that stops being hammered still ages out.
        buckets.set(key, hits);
        return false;
      }

      hits.push(at);
      buckets.set(key, hits);

      if (buckets.size > maxKeys) {
        const windowStart = at - windowMs;
        for (const [candidate, timestamps] of buckets) {
          if (timestamps.every(hit => hit <= windowStart)) {
            buckets.delete(candidate);
          }
        }
      }

      return true;
    },

    retryAfterMs(key) {
      if (limit <= 0) {
        return 0;
      }

      const at = now();
      const hits = live(key, at);
      if (hits.length < limit) {
        return 0;
      }

      // The oldest hit still in the window is the one whose expiry frees a slot.
      return Math.max(0, hits[0]! + windowMs - at);
    },

    reset() {
      buckets.clear();
    },
  };
}

/** How a request is bucketed. Defaults to the client IP. */
export type RateLimitKeyResolver = (req: Request) => string;

export interface RateLimitMiddlewareOptions extends RateLimitOptions {
  readonly keyResolver?: RateLimitKeyResolver;
  /** Body of the 429. */
  readonly message: string;
  /** Machine-readable code in the 429 body. */
  readonly code?: string;
}

/**
 * Express middleware around {@link createRateLimiter}.
 *
 * Answers 429 with `Retry-After`, which is what a well-behaved client needs to back off and what an
 * operator reading a log needs to tell throttling apart from a failure.
 */
export function rateLimit(options: RateLimitMiddlewareOptions): RequestHandler {
  const limiter = createRateLimiter(options);
  const resolveKey = options.keyResolver ?? (req => req.ip ?? 'unknown');
  const code = options.code ?? 'rate_limited';

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = resolveKey(req);
    if (limiter.consume(key)) {
      next();
      return;
    }

    res.setHeader('Retry-After', Math.ceil(limiter.retryAfterMs(key) / 1000));
    res.status(429).json({ error: code, message: options.message });
  };
}
