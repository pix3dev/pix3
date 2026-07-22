/**
 * Centralized keyboard shortcut service.
 *
 * Manages keybinding registration, keyboard event matching, and context evaluation.
 * Commands register their keybindings, and the service handles platform-specific
 * formatting and event matching.
 */

import { injectable } from '@/fw/di';
import type { Platform } from '@/fw/platform';
import { getCurrentPlatform } from '@/fw/platform';
import type { AppState } from '@/state';
import { appState } from '@/state';
import type { CommandId } from '@/core/command';
import type { KeybindingDescriptor, KeybindingContext, Keybinding } from '@/core/keybinding';
import { parseKeybinding, formatKeybindingForDisplay, evaluateContext } from '@/core/keybinding';

interface RegisteredKeybinding {
  commandId: CommandId;
  keybindings: Keybinding[];
  descriptor: KeybindingDescriptor;
}

/**
 * Service for managing keyboard shortcuts across the application.
 *
 * Features:
 * - Platform-aware keybinding formatting (⌘ on Mac, Ctrl on Windows/Linux)
 * - Context-sensitive execution ('when' clauses)
 * - Layout-independent matching (uses event.code for character keys)
 * - Key repeat prevention
 * - Conflict detection
 */
@injectable()
export class KeybindingService {
  private readonly platform: Platform;
  private readonly registry: Map<CommandId, RegisteredKeybinding> = new Map();
  private readonly state: AppState;

  constructor(state: AppState = appState) {
    this.platform = getCurrentPlatform();
    this.state = state;
  }

  /**
   * Register a keybinding for a command.
   *
   * @param commandId - Unique command identifier
   * @param descriptor - Abstract keybinding descriptor (e.g., 'Mod+D')
   * @param options - Optional context and repeat prevention settings
   */
  register(
    commandId: CommandId,
    descriptor: KeybindingDescriptor,
    options?: { when?: KeybindingContext; preventRepeat?: boolean }
  ): void {
    try {
      const keybindings = parseKeybinding(descriptor, options);

      // Check for conflicts with existing keybindings
      this.detectConflicts(commandId, keybindings);

      this.registry.set(commandId, {
        commandId,
        keybindings,
        descriptor,
      });
    } catch (error) {
      console.error(`Failed to register keybinding for ${commandId}:`, error);
    }
  }

  /**
   * Unregister a keybinding for a command.
   *
   * @param commandId - Command identifier to unregister
   */
  unregister(commandId: CommandId): void {
    this.registry.delete(commandId);
  }

  /**
   * Get the formatted display string for a command's keybinding.
   *
   * @param commandId - Command identifier
   * @returns Formatted shortcut string (e.g., '⌘D' on Mac, 'Ctrl+D' on Windows) or undefined
   */
  getDisplayString(commandId: CommandId): string | undefined {
    const registered = this.registry.get(commandId);
    if (!registered) {
      return undefined;
    }

    return formatKeybindingForDisplay(registered.descriptor, this.platform);
  }

  /**
   * Handle a keyboard event and find the matching command.
   *
   * @param event - Keyboard event to match
   * @returns Command ID if a matching keybinding is found and context is satisfied, otherwise undefined
   */
  handleKeyboardEvent(event: KeyboardEvent): CommandId | undefined {
    // Check if the event target is an input element
    const target = event.target as HTMLElement;
    const isInputElement =
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.contentEditable === 'true';

    // Update global input focus state
    if (this.state.editorContext.isInputFocused !== isInputElement) {
      this.state.editorContext.isInputFocused = isInputElement;
    }

    // Iterate through registered keybindings to find a match
    for (const registered of this.registry.values()) {
      for (const keybinding of registered.keybindings) {
        if (this.matchesEvent(event, keybinding)) {
          // Check context clause
          if (!evaluateContext(keybinding.when, this.state.editorContext)) {
            continue;
          }

          return registered.commandId;
        }
      }
    }

    return undefined;
  }

  /**
   * Check if a keyboard event matches a keybinding.
   *
   * @param event - Keyboard event
   * @param keybinding - Parsed keybinding to match against
   * @returns True if the event matches the keybinding
   */
  private matchesEvent(event: KeyboardEvent, keybinding: Keybinding): boolean {
    // Check key repeat prevention
    if (keybinding.preventRepeat && event.repeat) {
      return false;
    }

    // Match modifiers
    if (!!keybinding.ctrl !== event.ctrlKey) return false;
    if (!!keybinding.shift !== event.shiftKey) return false;
    if (!!keybinding.alt !== event.altKey) return false;
    if (!!keybinding.meta !== event.metaKey) return false;

    // Match key
    // Prioritize event.code for character keys (layout-independent)
    // Use event.key for special keys (Enter, Delete, etc.)
    if (event.code && event.code === keybinding.key) {
      return true;
    }

    // Fallback to event.key for special keys or if code doesn't match
    if (
      keybinding.keyFallback &&
      event.key.toLowerCase() === keybinding.keyFallback.toLowerCase()
    ) {
      return true;
    }

    return false;
  }

  /**
   * Detect conflicts with existing keybindings and warn in console.
   *
   * @param commandId - Command being registered
   * @param keybindings - Keybindings to check for conflicts
   */
  private detectConflicts(commandId: CommandId, keybindings: Keybinding[]): void {
    for (const newBinding of keybindings) {
      for (const [existingCommandId, registered] of this.registry.entries()) {
        if (existingCommandId === commandId) {
          continue; // Skip self
        }

        for (const existingBinding of registered.keybindings) {
          if (this.bindingsConflict(newBinding, existingBinding)) {
            console.warn(
              `Keybinding conflict detected: ${commandId} and ${existingCommandId} both use ` +
                `${this.formatBindingForLog(newBinding)}` +
                (newBinding.when || existingBinding.when
                  ? ` with potentially overlapping contexts`
                  : '')
            );
          }
        }
      }
    }
  }

  /**
   * Check if two keybindings conflict (same key + modifiers).
   *
   * @param a - First keybinding
   * @param b - Second keybinding
   * @returns True if the keybindings conflict
   */
  private bindingsConflict(a: Keybinding, b: Keybinding): boolean {
    // Same key and same modifiers = conflict
    return (
      a.key === b.key &&
      !!a.ctrl === !!b.ctrl &&
      !!a.shift === !!b.shift &&
      !!a.alt === !!b.alt &&
      !!a.meta === !!b.meta
    );
  }

  /**
   * Format a keybinding for logging.
   *
   * @param keybinding - Keybinding to format
   * @returns Human-readable string
   */
  private formatBindingForLog(keybinding: Keybinding): string {
    const parts: string[] = [];
    if (keybinding.ctrl) parts.push('Ctrl');
    if (keybinding.shift) parts.push('Shift');
    if (keybinding.alt) parts.push('Alt');
    if (keybinding.meta) parts.push('Meta');
    parts.push(keybinding.keyFallback || keybinding.key);
    return parts.join('+');
  }

  /**
   * Dispose of the service and clean up resources.
   */
  dispose(): void {
    this.registry.clear();
  }
}
