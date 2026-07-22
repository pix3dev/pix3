import { injectable } from '@/fw/di';

export type RovingOrientation = 'horizontal' | 'vertical';

export interface RovingFocusOptions {
  /**
   * CSS selector used to determine which elements participate in the roving
   * tabindex group.
   */
  selector: string;
  /**
   * Determines which arrow keys trigger next/previous focus transitions.
   * Horizontal → Left/Right, Vertical → Up/Down. Defaults to horizontal.
   */
  orientation?: RovingOrientation;
  /**
   * When enabled, moving past the first/last element wraps to the opposite
   * end of the group. Defaults to true.
   */
  loop?: boolean;
  /**
   * Automatically moves focus to the first enabled element when the group is
   * initialised. Useful for toolbars that gain focus programmatically.
   */
  focusFirstOnInit?: boolean;
}

@injectable()
export class FocusRingService {
  /**
   * Attaches a roving tabindex controller to the provided element. The
   * returned function must be invoked to remove listeners when the host is
   * disconnected.
   */
  attachRovingFocus(host: HTMLElement, options: RovingFocusOptions): () => void {
    if (!host) {
      throw new Error('[FocusRingService] Host element is required.');
    }

    if (!options.selector) {
      throw new Error('[FocusRingService] `selector` option is required.');
    }

    const normalized = {
      orientation: options.orientation ?? 'horizontal',
      loop: options.loop ?? true,
      focusFirstOnInit: options.focusFirstOnInit ?? false,
      selector: options.selector,
    } as const;

    let activeIndex = 0;

    const queryAll = (): HTMLElement[] => {
      return Array.from(host.querySelectorAll<HTMLElement>(normalized.selector));
    };

    const isDisabled = (element: HTMLElement): boolean => {
      const node = element as HTMLElement & { disabled?: boolean };
      if (typeof node.disabled === 'boolean') {
        return node.disabled;
      }
      const ariaDisabled = element.getAttribute('aria-disabled');
      if (ariaDisabled === 'true') {
        return true;
      }
      return element.hasAttribute('disabled');
    };

    const getEnabledItems = (): HTMLElement[] => {
      return queryAll().filter(element => !isDisabled(element));
    };

    const assignTabIndexes = () => {
      const allItems = queryAll();
      const enabledItems = getEnabledItems();

      const activeElement = document.activeElement;
      const focusedIndex = enabledItems.findIndex(item => item === activeElement);
      if (focusedIndex >= 0) {
        activeIndex = focusedIndex;
      }

      if (enabledItems.length === 0) {
        allItems.forEach(item => {
          item.tabIndex = -1;
          item.removeAttribute('data-roving-index');
        });
        return;
      }

      if (activeIndex >= enabledItems.length) {
        activeIndex = normalized.loop ? 0 : enabledItems.length - 1;
      }

      enabledItems.forEach((item, index) => {
        item.tabIndex = index === activeIndex ? 0 : -1;
        item.setAttribute('data-roving-index', String(index));
      });

      const disabledItems = allItems.filter(item => !enabledItems.includes(item));
      disabledItems.forEach(item => {
        item.tabIndex = -1;
        item.removeAttribute('data-roving-index');
      });
    };

    const focusAtIndex = (index: number) => {
      const enabledItems = getEnabledItems();
      if (enabledItems.length === 0) {
        return;
      }

      let nextIndex = index;
      if (index < 0 || index >= enabledItems.length) {
        if (!normalized.loop) {
          nextIndex = Math.max(0, Math.min(enabledItems.length - 1, index));
        } else {
          const length = enabledItems.length;
          nextIndex = ((index % length) + length) % length;
        }
      }

      activeIndex = nextIndex;
      assignTabIndexes();
      enabledItems[nextIndex]?.focus();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.target instanceof HTMLElement)) {
        return;
      }

      if (!event.target.matches(normalized.selector)) {
        return;
      }

      const enabledItems = getEnabledItems();
      if (enabledItems.length === 0) {
        return;
      }

      const currentIndex = enabledItems.indexOf(event.target);
      if (currentIndex === -1) {
        return;
      }

      const isHorizontal = normalized.orientation === 'horizontal';
      const prevKeys = isHorizontal ? ['ArrowLeft'] : ['ArrowUp'];
      const nextKeys = isHorizontal ? ['ArrowRight'] : ['ArrowDown'];

      if (prevKeys.includes(event.key)) {
        event.preventDefault();
        focusAtIndex(currentIndex - 1);
        return;
      }

      if (nextKeys.includes(event.key)) {
        event.preventDefault();
        focusAtIndex(currentIndex + 1);
        return;
      }

      if (event.key === 'Home') {
        event.preventDefault();
        focusAtIndex(0);
        return;
      }

      if (event.key === 'End') {
        event.preventDefault();
        focusAtIndex(getEnabledItems().length - 1);
        return;
      }

      if (event.key === ' ' || event.key === 'Enter') {
        const role = event.target.getAttribute('role');
        if (role === 'button' || event.target.tagName === 'BUTTON') {
          event.preventDefault();
          // Imitate native button activation for div-based buttons.
          event.target.click();
        }
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) {
        return;
      }

      if (!host.contains(event.target)) {
        return;
      }

      if (!event.target.matches(normalized.selector)) {
        const enabledItems = getEnabledItems();
        if (enabledItems.length === 0) {
          return;
        }
        if (event.target === host) {
          // When the container itself gains focus (e.g., programmatic
          // focus), move focus to the active item.
          enabledItems[activeIndex]?.focus();
        }
        return;
      }

      const enabledItems = getEnabledItems();
      const focusedIndex = enabledItems.indexOf(event.target);
      if (focusedIndex >= 0) {
        activeIndex = focusedIndex;
        assignTabIndexes();
      }
    };

    const observer = new MutationObserver(assignTabIndexes);
    observer.observe(host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-disabled'],
    });

    host.addEventListener('keydown', onKeyDown);
    host.addEventListener('focusin', onFocusIn);

    queueMicrotask(() => {
      assignTabIndexes();
      if (normalized.focusFirstOnInit) {
        const enabled = getEnabledItems();
        if (enabled.length > 0) {
          activeIndex = 0;
          assignTabIndexes();
          enabled[0].focus();
        }
      }
    });

    return () => {
      observer.disconnect();
      host.removeEventListener('keydown', onKeyDown);
      host.removeEventListener('focusin', onFocusIn);
    };
  }

  dispose(): void {
    // FocusRingService is stateless — cleanup is per-host via the returned teardown fn
  }
}

export type FocusRingServiceOptions = RovingFocusOptions;
