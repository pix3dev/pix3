/**
 * What `pix3 validate` reports: one {@link Diagnostic} per problem, each with a stable `code`.
 *
 * The codes are the contract with agents (the kit teaches them, `--json` carries them), so they are
 * listed here once, with the level that produces them. An error fails the run (exit code 1); a
 * warning never does.
 */

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  readonly severity: Severity;
  readonly code: DiagnosticCode;
  /** Project-relative, forward slashes (`scenes/main.pix3scene`). */
  readonly file: string;
  readonly nodeId?: string;
  /** Where in the document: `root[0].children[1].properties.material.color`. */
  readonly path?: string;
  /** 1-based line of `path` in `file`, when it could be located. */
  readonly line?: number;
  readonly message: string;
  /** What to do about it, when there is one obvious answer. */
  readonly fix?: string;
}

/** Every code, with its severity and the level that emits it. */
export const DIAGNOSTIC_CODES = {
  // Level 1 — no user code, no DOM.
  E_YAML: { severity: 'error', level: 1, summary: 'the file is not valid YAML' },
  E_SHAPE: {
    severity: 'error',
    level: 1,
    summary: 'document structure is wrong (root, node, component or override shape)',
  },
  E_UNKNOWN_NODE_TYPE: { severity: 'error', level: 1, summary: 'unknown `type:`' },
  W_TYPE_CASE: {
    severity: 'warning',
    level: 1,
    summary: '`type:` loads, but is not the canonical spelling',
  },
  E_UNKNOWN_PROPERTY: {
    severity: 'error',
    level: 1,
    summary: 'a key under `properties:` the loader never reads for this type',
  },
  W_WRITE_ONLY_PROPERTY: {
    severity: 'warning',
    level: 1,
    summary: 'the editor saves this property but the loader does not read it back',
  },
  W_LEGACY_KEY: {
    severity: 'warning',
    level: 1,
    summary: 'a read-compat spelling; the editor rewrites it on save',
  },
  E_PROPERTY_TYPE: { severity: 'error', level: 1, summary: 'value has the wrong type' },
  E_PROPERTY_RANGE: {
    severity: 'error',
    level: 1,
    summary: "value rejected by the property's validation rule (e.g. fov > 0)",
  },
  W_PROPERTY_RANGE: {
    severity: 'warning',
    level: 1,
    summary: "number outside the inspector's min..max (a UI range, not a load error)",
  },
  E_PROPERTY_ENUM: { severity: 'error', level: 1, summary: 'value is not one of the options' },
  E_UNKNOWN_COMPONENT: { severity: 'error', level: 1, summary: 'unknown component type' },
  E_UNKNOWN_CONFIG_KEY: {
    severity: 'error',
    level: 1,
    summary: 'component config key the component does not declare (`user:` ones at level 2)',
  },
  E_USER_SCRIPT_NOT_FOUND: {
    severity: 'error',
    level: 1,
    summary: 'no script under scripts/ exports a Script class with this name',
  },
  E_MISSING_RESOURCE: { severity: 'error', level: 1, summary: 'referenced file does not exist' },
  E_MISSING_PREFAB: { severity: 'error', level: 1, summary: '`instance:` target does not exist' },
  E_PREFAB_CYCLE: { severity: 'error', level: 1, summary: 'prefab instances form a cycle' },
  E_PREFAB_ROOT: {
    severity: 'error',
    level: 1,
    summary: 'an instanced prefab must have exactly one root node',
  },
  E_UNKNOWN_OVERRIDE_TARGET: {
    severity: 'error',
    level: 1,
    summary: '`overrides.byLocalId` names a node the prefab does not have',
  },
  E_DUPLICATE_ID: { severity: 'error', level: 1, summary: 'two nodes share an id' },
  E_EMOJI_AS_ART: {
    severity: 'error',
    level: 1,
    summary: 'text that is nothing but emoji — a picture standing in for a sprite',
  },
  W_LEGACY_VERSION: {
    severity: 'warning',
    level: 1,
    summary: 'scene `version:` is missing or not the current format version',
  },
  W_UNUSED_ASSET: {
    severity: 'warning',
    level: 1,
    summary: 'a file under sprites/ or audio/ nothing references (whole-project runs only)',
  },
  // Level 2 — the real SceneLoader, user scripts compiled and imported.
  E_LOAD: { severity: 'error', level: 2, summary: 'the loader rejected the scene or warned' },
  E_PENDING_COMPONENT: {
    severity: 'error',
    level: 2,
    summary: 'a component stayed unregistered after the scripts compiled',
  },
  E_SCRIPT_COMPILE: { severity: 'error', level: 2, summary: 'the project scripts do not compile' },
  W_SCRIPT_IMPORT: {
    severity: 'warning',
    level: 2,
    summary: 'compiled scripts threw on import in Node; user: properties not checked',
  },
  W_HYDRATE_SKIPPED: { severity: 'warning', level: 2, summary: 'level 2 did not run' },
  W_RENDERABILITY: {
    severity: 'warning',
    level: 2,
    summary: 'the scene may not show anything (W_RENDERABILITY_<ISSUE>)',
  },
} as const satisfies Record<string, { severity: Severity; level: 1 | 2; summary: string }>;

type StaticCode = keyof typeof DIAGNOSTIC_CODES;

/** `W_RENDERABILITY_LIT_MATERIAL_NO_LIGHT`, … — one per `RenderabilityIssueCode`. */
export type RenderabilityCode = `W_RENDERABILITY_${string}`;

export type DiagnosticCode = Exclude<StaticCode, 'W_RENDERABILITY'> | RenderabilityCode;

export const severityOf = (code: DiagnosticCode): Severity =>
  code.startsWith('W_') ? 'warning' : 'error';

export interface DiagnosticInput {
  readonly code: DiagnosticCode;
  readonly file: string;
  readonly nodeId?: string;
  readonly path?: string;
  readonly line?: number;
  readonly message: string;
  readonly fix?: string;
}

export const diagnostic = (input: DiagnosticInput): Diagnostic => {
  const out: { -readonly [K in keyof Diagnostic]: Diagnostic[K] } = {
    severity: severityOf(input.code),
    code: input.code,
    file: input.file,
    message: input.message,
  };
  if (input.nodeId !== undefined) out.nodeId = input.nodeId;
  if (input.path !== undefined) out.path = input.path;
  if (input.line !== undefined) out.line = input.line;
  if (input.fix !== undefined) out.fix = input.fix;
  return out;
};

/** Stable output order: file, then line, then path, then code. */
export const compareDiagnostics = (a: Diagnostic, b: Diagnostic): number =>
  a.file.localeCompare(b.file) ||
  (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
  (a.path ?? '').localeCompare(b.path ?? '') ||
  a.code.localeCompare(b.code);
