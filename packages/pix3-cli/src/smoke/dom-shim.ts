import { createStub2DContext } from '@pix3/runtime/node';

/**
 * The browser surface `pix3 smoke` fakes so a game can run in a Node worker.
 *
 * What the engine itself needs is small and known: `window.addEventListener` (input, audio), a
 * `document` that makes 2D canvases (every caption is measured on one), a canvas element with a
 * size and listeners (the renderer's `domElement`), `document.visibilityState`. Game scripts reach
 * further (`localStorage`, `matchMedia`, `window.innerWidth`, `document.body`), and those get
 * plausible answers too.
 *
 * Everything else is **recorded, not invented**: `window`, `document` and every element are proxies
 * that answer `undefined` for a property they do not have and remember the read as
 * `window.foo` / `document.bar` / `<div>.baz`. When a script then throws, the smoke report attaches
 * those reads to the error (`E_SMOKE_DOM`), which names the offending access instead of leaving a
 * bare "x is not a function". Nothing renders: pixels are the editor's job.
 */

export interface DomShim {
  /** `<img>` elements that were given a `src` and "loaded" blank. */
  readonly imagesLoaded: number;
  /** Every missing property read so far (feature detection excluded), first-seen order. */
  readonly missing: readonly string[];
  /** Missing reads since the previous call (for attaching to the next error). */
  takeRecentMissing(): string[];
  uninstall(): void;
}

/** Reads that are feature detection, not use — never attached to an error. */
const BENIGN_MISSING = new Set([
  'window.AudioContext',
  'window.webkitAudioContext',
  'window.__PIX3_DEBUG__',
  'window.ontouchstart',
  'window.PointerEvent',
  'window.visualViewport',
  'window.chrome',
  // three.js probing a canvas as a texture image.
  '<canvas>.depth',
]);

/** Properties never recorded (inspection, promise probing, iteration). */
const IGNORED_KEYS = new Set([
  'then',
  'toJSON',
  'constructor',
  'nodeType',
  'asymmetricMatch',
  '$$typeof',
  'inspect',
  'valueOf',
  'toString',
]);

interface Recorder {
  readonly missing: string[];
  readonly seen: Set<string>;
  recent: string[];
}

const recording = <T extends object>(
  target: T,
  label: string,
  recorder: Recorder,
  fallback?: object
): T =>
  new Proxy(target, {
    get(obj, property, receiver) {
      if (Reflect.has(obj, property)) return Reflect.get(obj, property, receiver) as unknown;
      if (fallback && Reflect.has(fallback, property))
        return Reflect.get(fallback, property) as unknown;
      if (typeof property === 'symbol' || IGNORED_KEYS.has(property)) return undefined;
      const access = `${label}.${property}`;
      if (BENIGN_MISSING.has(access)) return undefined;
      if (!recorder.seen.has(access)) {
        recorder.seen.add(access);
        recorder.missing.push(access);
      }
      recorder.recent.push(access);
      return undefined;
    },
    set(obj, property, value) {
      Reflect.set(obj, property, value);
      // `window.x = …` is a global in a browser.
      if (fallback && typeof property === 'string') Reflect.set(fallback, property, value);
      return true;
    },
  });

class MemoryStorage {
  private readonly data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.data.get(String(key)) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(String(key), String(value));
  }
  removeItem(key: string): void {
    this.data.delete(String(key));
  }
  clear(): void {
    this.data.clear();
  }
}

const rect = (width: number, height: number) => ({
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: width,
  bottom: height,
  width,
  height,
  toJSON: () => ({}),
});

type ElementFactory = (tag: string) => object;

const makeElementFactory = (
  recorder: Recorder,
  viewport: { width: number; height: number }
): ElementFactory => {
  const create = (tag: string): object => {
    const events = new EventTarget();
    const children: object[] = [];
    const isCanvas = tag === 'canvas';
    const classes = new Set<string>();
    const attributes = new Map<string, string>();
    const element: Record<string, unknown> = {
      tagName: tag.toUpperCase(),
      nodeName: tag.toUpperCase(),
      style: {},
      dataset: {},
      children,
      childNodes: children,
      parentElement: null,
      parentNode: null,
      textContent: '',
      innerHTML: '',
      width: isCanvas ? viewport.width : 0,
      height: isCanvas ? viewport.height : 0,
      clientWidth: isCanvas ? viewport.width : 0,
      clientHeight: isCanvas ? viewport.height : 0,
      offsetWidth: isCanvas ? viewport.width : 0,
      offsetHeight: isCanvas ? viewport.height : 0,
      classList: {
        add: (...names: string[]) => names.forEach(name => classes.add(name)),
        remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
        toggle: (name: string, force?: boolean) => {
          const on = force ?? !classes.has(name);
          if (on) classes.add(name);
          else classes.delete(name);
          return on;
        },
        contains: (name: string) => classes.has(name),
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      getBoundingClientRect: () => (isCanvas ? rect(viewport.width, viewport.height) : rect(0, 0)),
      getContext: (kind: string) => (isCanvas && kind === '2d' ? createStub2DContext() : null),
      appendChild: (child: object) => {
        children.push(child);
        return child;
      },
      removeChild: (child: object) => {
        const index = children.indexOf(child);
        if (index >= 0) children.splice(index, 1);
        return child;
      },
      insertBefore: (child: object) => {
        children.push(child);
        return child;
      },
      append: (...nodes: object[]) => void children.push(...nodes),
      prepend: (...nodes: object[]) => void children.unshift(...nodes),
      remove: () => {},
      contains: () => false,
      setAttribute: (name: string, value: string) => void attributes.set(name, String(value)),
      getAttribute: (name: string) => attributes.get(name) ?? null,
      removeAttribute: (name: string) => void attributes.delete(name),
      hasAttribute: (name: string) => attributes.has(name),
      querySelector: () => null,
      querySelectorAll: () => [],
      focus: () => {},
      blur: () => {},
      click: () => {},
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      hasPointerCapture: () => false,
      requestPointerLock: () => {},
      animate: () => ({ cancel: () => {}, finished: Promise.resolve() }),
    };
    return recording(element, `<${tag}>`, recorder);
  };
  return create;
};

/**
 * An `<img>` that "loads" as a blank 1×1 picture as soon as it gets a `src` (asynchronously, as a
 * browser would). three's `TextureLoader`/`ImageLoader` wait for that event; an image that never
 * fired it would leave every game that preloads textures itself awaiting forever, which reads as a
 * clean run of a game that never started. Pixels are not a smoke test's business; progress is.
 */
const blankImage = (onLoad: () => void): Record<string, unknown> => {
  const events = new EventTarget();
  let source = '';
  const image: Record<string, unknown> = {
    tagName: 'IMG',
    style: {},
    crossOrigin: null,
    complete: false,
    width: 0,
    height: 0,
    naturalWidth: 0,
    naturalHeight: 0,
    onload: null,
    onerror: null,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    decode: () => Promise.resolve(),
  };
  Object.defineProperty(image, 'src', {
    get: () => source,
    set: (value: string) => {
      source = String(value);
      setTimeout(() => {
        Object.assign(image, {
          complete: true,
          width: 1,
          height: 1,
          naturalWidth: 1,
          naturalHeight: 1,
        });
        onLoad();
        events.dispatchEvent(new Event('load'));
        const handler = image.onload;
        if (typeof handler === 'function')
          (handler as (event: Event) => void).call(image, new Event('load'));
      }, 0);
    },
  });
  return image;
};

/**
 * DOM classes, for `instanceof` checks (the engine's input layer asks `instanceof
 * HTMLCanvasElement`) — matched by tag name, since the shim's elements are plain objects.
 */
const elementClass = (name: string, tags: readonly string[] | null): unknown => {
  const cls = class {};
  Object.defineProperty(cls, 'name', { value: name });
  Object.defineProperty(cls, Symbol.hasInstance, {
    value: (candidate: unknown): boolean => {
      if (candidate === null || typeof candidate !== 'object') return false;
      const tag = Reflect.get(candidate, 'tagName');
      return typeof tag === 'string' && (tags === null || tags.includes(tag));
    },
  });
  return cls;
};

const eventClass = (name: string): unknown => {
  const cls = class extends Event {
    constructor(type: string, init: Record<string, unknown> = {}) {
      super(type, init);
      Object.assign(this, init);
    }
  };
  Object.defineProperty(cls, 'name', { value: name });
  return cls;
};

const DOM_CLASSES: Readonly<Record<string, () => unknown>> = {
  Node: () => elementClass('Node', null),
  Element: () => elementClass('Element', null),
  HTMLElement: () => elementClass('HTMLElement', null),
  HTMLCanvasElement: () => elementClass('HTMLCanvasElement', ['CANVAS']),
  HTMLDivElement: () => elementClass('HTMLDivElement', ['DIV']),
  HTMLImageElement: () => elementClass('HTMLImageElement', ['IMG']),
  HTMLVideoElement: () => elementClass('HTMLVideoElement', ['VIDEO']),
  PointerEvent: () => eventClass('PointerEvent'),
  MouseEvent: () => eventClass('MouseEvent'),
  KeyboardEvent: () => eventClass('KeyboardEvent'),
  TouchEvent: () => eventClass('TouchEvent'),
  WheelEvent: () => eventClass('WheelEvent'),
  FocusEvent: () => eventClass('FocusEvent'),
};

/** Globals the shim defines, with whatever was there before (restored by `uninstall`). */
const SHIMMED_GLOBALS = [
  ...Object.keys(DOM_CLASSES),
  'Image',
  'window',
  'self',
  'document',
  'localStorage',
  'sessionStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'matchMedia',
  'getComputedStyle',
  'innerWidth',
  'innerHeight',
  'devicePixelRatio',
] as const;

export const installDomShim = (viewport: { width: number; height: number }): DomShim => {
  const recorder: Recorder = { missing: [], seen: new Set(), recent: [] };
  let imagesLoaded = 0;
  const makeImage = (): Record<string, unknown> =>
    blankImage(() => {
      imagesLoaded += 1;
    });
  const createElement = makeElementFactory(recorder, viewport);
  const windowEvents = new EventTarget();
  const documentEvents = new EventTarget();

  const body = createElement('body');
  const head = createElement('head');
  const documentElement = createElement('html');

  const documentTarget: Record<string, unknown> = {
    body,
    head,
    documentElement,
    visibilityState: 'visible',
    hidden: false,
    readyState: 'complete',
    fonts: {
      add: () => {},
      delete: () => {},
      load: () => Promise.resolve([]),
      ready: Promise.resolve(),
      check: () => true,
    },
    hasFocus: () => true,
    createElement: (tag: string) => {
      const name = String(tag).toLowerCase();
      return name === 'img' ? makeImage() : createElement(name);
    },
    createElementNS: (_namespace: string, tag: string) =>
      tag === 'img' ? makeImage() : createElement(String(tag).toLowerCase()),
    createTextNode: (text: string) => ({ textContent: text }),
    getElementById: () => null,
    getElementsByClassName: () => [],
    getElementsByTagName: () => [],
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    dispatchEvent: documentEvents.dispatchEvent.bind(documentEvents),
  };
  const documentProxy = recording(documentTarget, 'document', recorder);

  let rafHandle = 0;
  const rafTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const requestAnimationFrame = (callback: (time: number) => void): number => {
    const handle = ++rafHandle;
    rafTimers.set(
      handle,
      setTimeout(() => {
        rafTimers.delete(handle);
        callback(performance.now());
      }, 16)
    );
    return handle;
  };
  const cancelAnimationFrame = (handle: number): void => {
    const timer = rafTimers.get(handle);
    if (timer !== undefined) clearTimeout(timer);
    rafTimers.delete(handle);
  };
  const matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });

  const windowTarget: Record<string, unknown> = {
    document: documentProxy,
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    outerWidth: viewport.width,
    outerHeight: viewport.height,
    devicePixelRatio: 1,
    screen: {
      width: viewport.width,
      height: viewport.height,
      orientation: { type: 'portrait-primary', angle: 0 },
    },
    location: {
      href: 'http://localhost/',
      origin: 'http://localhost',
      protocol: 'http:',
      host: 'localhost',
      hostname: 'localhost',
      port: '',
      pathname: '/',
      search: '',
      hash: '',
      reload: () => {},
      assign: () => {},
      replace: () => {},
    },
    history: { pushState: () => {}, replaceState: () => {}, back: () => {} },
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    requestAnimationFrame,
    cancelAnimationFrame,
    matchMedia,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
    focus: () => {},
    blur: () => {},
    open: () => null,
    alert: () => {},
    confirm: () => false,
    prompt: () => null,
    scrollTo: () => {},
  };
  const windowProxy = recording(windowTarget, 'window', recorder, globalThis);
  windowTarget.window = windowProxy;
  windowTarget.self = windowProxy;
  windowTarget.top = windowProxy;
  windowTarget.parent = windowProxy;

  const previous = new Map<string, PropertyDescriptor | undefined>();
  const define = (name: string, value: unknown): void => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  define('window', windowProxy);
  define('self', windowProxy);
  define('document', documentProxy);
  define('localStorage', windowTarget.localStorage);
  define('sessionStorage', windowTarget.sessionStorage);
  define('requestAnimationFrame', requestAnimationFrame);
  define('cancelAnimationFrame', cancelAnimationFrame);
  define('matchMedia', matchMedia);
  define('getComputedStyle', windowTarget.getComputedStyle);
  define('innerWidth', viewport.width);
  define('innerHeight', viewport.height);
  define('devicePixelRatio', 1);
  for (const [name, make] of Object.entries(DOM_CLASSES)) {
    // Node's own (Event, EventTarget, CustomEvent…) stay; only what Node lacks is added.
    if (typeof Reflect.get(globalThis, name) === 'undefined') define(name, make());
  }
  define('Image', function Image(this: unknown) {
    return makeImage();
  } as unknown);

  return {
    get imagesLoaded() {
      return imagesLoaded;
    },
    get missing() {
      return recorder.missing;
    },
    takeRecentMissing() {
      const recent = [...new Set(recorder.recent)];
      recorder.recent = [];
      return recent;
    },
    uninstall() {
      for (const timer of rafTimers.values()) clearTimeout(timer);
      rafTimers.clear();
      for (const name of SHIMMED_GLOBALS) {
        if (!previous.has(name)) continue;
        const descriptor = previous.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};
