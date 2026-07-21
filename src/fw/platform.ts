/**
 * Platform detection utilities for cross-platform keyboard shortcut handling.
 * Provides robust detection for macOS, Windows, and Linux using modern APIs with fallbacks.
 */

/**
 * Supported platforms for shortcut display and behavior.
 */
export type Platform = 'mac' | 'windows' | 'linux';

let cachedPlatform: Platform | null = null;

/**
 * Detects the current operating system platform.
 * Uses modern userAgentData API (Chromium 89+) with fallback to navigator.platform.
 * Result is cached for performance.
 */
export function getCurrentPlatform(): Platform {
  if (cachedPlatform) {
    return cachedPlatform;
  }

  // Modern API: navigator.userAgentData (Chromium 89+)
  // @ts-expect-error - userAgentData is not yet in standard TypeScript types
  const userAgentData = navigator.userAgentData as { platform?: string } | undefined;
  if (userAgentData?.platform === 'macOS') {
    cachedPlatform = 'mac';
    return cachedPlatform;
  }

  // Fallback: navigator.platform (works on all browsers but may be deprecated)
  const platform = navigator.platform;
  if (/Mac|iPhone|iPod|iPad/.test(platform)) {
    cachedPlatform = 'mac';
  } else if (/Win/.test(platform)) {
    cachedPlatform = 'windows';
  } else {
    cachedPlatform = 'linux';
  }

  return cachedPlatform;
}

/**
 * Clears the cached platform detection result.
 * Primarily for testing purposes.
 * @internal
 */
export function _clearPlatformCache(): void {
  cachedPlatform = null;
}
