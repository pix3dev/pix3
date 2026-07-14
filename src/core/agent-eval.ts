/**
 * Deterministic eval scorecard for the in-editor agent — the automated "verifier" of the
 * agent-harness tuning loop (`.plans/agent-eval-scenarios.md`).
 *
 * A scenario expectation table ("skill read early", "scripts compile", "input moves the
 * player", "sprite has alpha and is trimmed") becomes an {@link EvalSpec}: a JSON list of
 * typed checks the judge runs after `agent.send(...)` finishes. Every check either measures
 * real state (scene graph, compile diagnostics, captured errors, live gameplay via
 * `game_input`, image alpha stats) or matches the recorded tool trace — no LLM judgment
 * anywhere, so a report is reproducible and cannot be sweet-talked.
 *
 * The engine is deliberately decoupled from the editor: it runs against the narrow
 * {@link EvalHarness} interface so it can be unit-tested with a fake and wired to live
 * services by the debug bridge (`__PIX3_DEBUG__.eval`).
 */
import type { Json } from '@/core/agent-introspection';

// ---------------------------------------------------------------------------
// Harness — the few primitives checks are allowed to touch
// ---------------------------------------------------------------------------

/** Summary of the agent conversation under evaluation (report footer). */
export interface EvalAgentSummary {
  status: string;
  notice: string | null;
  messageCount: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** One recorded tool call from the agent's conversation, in emission order. */
export interface EvalToolCall {
  name: string;
  input: unknown;
}

/** Deterministic image measurements (dimensions + alpha stats) for a project asset. */
export interface EvalImageStats {
  width: number;
  height: number;
  bytes: number;
  hasAlpha: boolean;
  transparentFraction: number;
}

/**
 * Everything the scorecard may observe or drive. The debug bridge implements it over live
 * services; specs implement it with fakes.
 */
export interface EvalHarness {
  /** Execute an agent tool by name — exactly what the agent chat's loop runs. */
  executeTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** All tool calls of the current agent conversation, in order. */
  toolCalls(): readonly EvalToolCall[];
  /** Conversation status/usage for the report footer. */
  agentSummary(): EvalAgentSummary;
  /** Case-insensitive scene-graph search across node name + type (authored graph). */
  findNodes(query: string): ReadonlyArray<{ nodeId: string; name: string; type: string }>;
  /** Properties + attached components of one node, or null when the id is unknown. */
  nodeDetail(nodeId: string): {
    properties: Json;
    components: ReadonlyArray<{ className: string; scriptId: string | null }>;
  } | null;
  /** Captured runtime errors (console.error / window errors / rejections). */
  errors(): ReadonlyArray<{ source: string; message: string }>;
  clearErrors(): void;
  isPlaying(): boolean;
  /** Measure a project image (null when missing/undecodable). */
  imageStats(path: string): Promise<EvalImageStats | null>;
  wait(ms: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Check types
// ---------------------------------------------------------------------------

interface CheckBase {
  /** Human label for the report row (defaults to a generated one). */
  label?: string;
}

/** The agent called `tool` (optionally with args matching a regex, optionally early). */
export interface ToolCalledCheck extends CheckBase {
  kind: 'tool-called';
  tool: string;
  /** Case-insensitive regex tested against `JSON.stringify(input)`. */
  inputMatch?: string;
  /** Only accept a match among the first N tool calls ("read the skill BEFORE acting"). */
  withinFirstCalls?: number;
}

/** The first `first` call happened before the first `then` call (both must exist). */
export interface ToolOrderCheck extends CheckBase {
  kind: 'tool-order';
  first: string;
  then: string;
}

/** Project scripts compile (esbuild) — and optionally type-check — clean right now. */
export interface CompileCleanCheck extends CheckBase {
  kind: 'compile-clean';
  /** Also run `check_scripts` and require zero type errors. */
  typeCheck?: boolean;
}

/** A node whose name contains `name` (and type contains `type`) exists in the scene. */
export interface NodeExistsCheck extends CheckBase {
  kind: 'node-exists';
  name: string;
  type?: string;
  minCount?: number;
}

/** The first node matching `node` has a component (optionally of a matching type). */
export interface NodeComponentCheck extends CheckBase {
  kind: 'node-component';
  node: string;
  /** Substring matched against the component's scriptId or class name. */
  componentType?: string;
}

/** A property (dot path into the node's serialized properties) exists / equals / matches. */
export interface NodePropertyCheck extends CheckBase {
  kind: 'node-property';
  node: string;
  property: string;
  equals?: Json;
  /** Case-insensitive regex tested against `String(value)`. */
  matches?: string;
}

/** A project text file exists (optionally containing a substring or matching a regex). */
export interface FileCheck extends CheckBase {
  kind: 'file';
  path: string;
  contains?: string;
  matches?: string;
}

/** A saved image asset measures right: alpha present, trimmed/downscaled, small enough. */
export interface AssetCheck extends CheckBase {
  kind: 'asset';
  path: string;
  requireAlpha?: boolean;
  /** Longest edge must be ≤ this many px. */
  maxDimension?: number;
  maxBytes?: number;
}

/** Play mode starts and stays error-free for `settleMs`. */
export interface PlayCleanCheck extends CheckBase {
  kind: 'play-clean';
  settleMs?: number;
  /** Leave the game running for follow-up gameplay checks (default: stop it). */
  keepPlaying?: boolean;
}

/** Real input moves the observed nodes (`game_input` — proves controls work). */
export interface InputMovesCheck extends CheckBase {
  kind: 'input-moves';
  /** `game_input` steps, passed through verbatim. */
  steps: Json[];
  observe: string[];
  /** Nodes that must report `moved: true` (default: every observed node). */
  expectMoved?: string[];
  /** Leave the game running afterwards (default: stop it). */
  keepPlaying?: boolean;
}

/** Nodes move on their own (`game_observe` with a sampling window — AI cars, spawners). */
export interface ObserveMovingCheck extends CheckBase {
  kind: 'observe-moving';
  nodes: string[];
  sampleMs?: number;
  /** Nodes that must report movement (default: every listed node). */
  expectMoving?: string[];
  keepPlaying?: boolean;
}

/** No captured runtime errors at this point of the run. */
export interface NoErrorsCheck extends CheckBase {
  kind: 'no-errors';
}

export type EvalCheck =
  | ToolCalledCheck
  | ToolOrderCheck
  | CompileCleanCheck
  | NodeExistsCheck
  | NodeComponentCheck
  | NodePropertyCheck
  | FileCheck
  | AssetCheck
  | PlayCleanCheck
  | InputMovesCheck
  | ObserveMovingCheck
  | NoErrorsCheck;

export const EVAL_CHECK_KINDS: ReadonlyArray<EvalCheck['kind']> = [
  'tool-called',
  'tool-order',
  'compile-clean',
  'node-exists',
  'node-component',
  'node-property',
  'file',
  'asset',
  'play-clean',
  'input-moves',
  'observe-moving',
  'no-errors',
];

export interface EvalSpec {
  name: string;
  checks: EvalCheck[];
}

export interface EvalCheckResult {
  index: number;
  kind: string;
  label: string;
  pass: boolean;
  /** One line of evidence: what was measured and why it passed/failed. */
  detail: string;
}

export interface EvalReport {
  name: string;
  ok: boolean;
  passed: number;
  failed: number;
  total: number;
  checks: EvalCheckResult[];
  agent: EvalAgentSummary;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const DEFAULT_PLAY_SETTLE_MS = 1500;
const MAX_PLAY_SETTLE_MS = 15_000;
const DEFAULT_OBSERVE_SAMPLE_MS = 1000;

/**
 * Run every check in order (order matters — play checks change state) and return the report.
 * A check that throws is a failed check, never an aborted run.
 */
export async function runEvalSpec(harness: EvalHarness, spec: EvalSpec): Promise<EvalReport> {
  const results: EvalCheckResult[] = [];
  for (let index = 0; index < spec.checks.length; index++) {
    const check = spec.checks[index];
    let outcome: { pass: boolean; detail: string };
    try {
      outcome = await runCheck(harness, check);
    } catch (error) {
      outcome = { pass: false, detail: `check threw: ${messageOf(error)}` };
    }
    results.push({
      index,
      kind: check.kind,
      label: check.label ?? defaultLabel(check),
      pass: outcome.pass,
      detail: outcome.detail,
    });
  }
  const passed = results.filter(r => r.pass).length;
  return {
    name: spec.name,
    ok: passed === results.length,
    passed,
    failed: results.length - passed,
    total: results.length,
    checks: results,
    agent: harness.agentSummary(),
  };
}

type Outcome = { pass: boolean; detail: string };

async function runCheck(harness: EvalHarness, check: EvalCheck): Promise<Outcome> {
  switch (check.kind) {
    case 'tool-called':
      return checkToolCalled(harness, check);
    case 'tool-order':
      return checkToolOrder(harness, check);
    case 'compile-clean':
      return checkCompileClean(harness, check);
    case 'node-exists':
      return checkNodeExists(harness, check);
    case 'node-component':
      return checkNodeComponent(harness, check);
    case 'node-property':
      return checkNodeProperty(harness, check);
    case 'file':
      return checkFile(harness, check);
    case 'asset':
      return checkAsset(harness, check);
    case 'play-clean':
      return checkPlayClean(harness, check);
    case 'input-moves':
      return checkInputMoves(harness, check);
    case 'observe-moving':
      return checkObserveMoving(harness, check);
    case 'no-errors': {
      const errors = harness.errors();
      return errors.length === 0
        ? { pass: true, detail: 'no captured errors' }
        : { pass: false, detail: `${errors.length} error(s): ${firstErrors(errors)}` };
    }
  }
}

function checkToolCalled(harness: EvalHarness, check: ToolCalledCheck): Outcome {
  const calls = harness.toolCalls();
  const scope =
    check.withinFirstCalls && check.withinFirstCalls > 0
      ? calls.slice(0, check.withinFirstCalls)
      : calls;
  const pattern = check.inputMatch ? compileRegex(check.inputMatch) : null;
  if (check.inputMatch && !pattern) {
    return { pass: false, detail: `invalid inputMatch regex: ${check.inputMatch}` };
  }
  const hit = scope.findIndex(
    call => call.name === check.tool && (!pattern || pattern.test(JSON.stringify(call.input ?? {})))
  );
  if (hit >= 0) {
    return { pass: true, detail: `call #${hit + 1} of ${calls.length}` };
  }
  const scopeNote = scope.length < calls.length ? ` within the first ${scope.length} calls` : '';
  return {
    pass: false,
    detail: `no matching ${check.tool} call${scopeNote} (${calls.length} calls total)`,
  };
}

function checkToolOrder(harness: EvalHarness, check: ToolOrderCheck): Outcome {
  const calls = harness.toolCalls();
  const first = calls.findIndex(call => call.name === check.first);
  const then = calls.findIndex(call => call.name === check.then);
  if (first < 0 || then < 0) {
    const missing = [first < 0 ? check.first : null, then < 0 ? check.then : null]
      .filter(Boolean)
      .join(', ');
    return { pass: false, detail: `never called: ${missing}` };
  }
  return first < then
    ? { pass: true, detail: `${check.first} (#${first + 1}) before ${check.then} (#${then + 1})` }
    : {
        pass: false,
        detail: `${check.then} (#${then + 1}) came before ${check.first} (#${first + 1})`,
      };
}

async function checkCompileClean(harness: EvalHarness, check: CompileCleanCheck): Promise<Outcome> {
  const compiled = asRecord(await harness.executeTool('compile_scripts'));
  if (compiled.ok !== true) {
    const where =
      typeof compiled.file === 'string'
        ? ` (${compiled.file}:${String(compiled.line ?? '?')})`
        : '';
    return {
      pass: false,
      detail: `compile failed: ${String(compiled.error ?? 'unknown')}${where}`,
    };
  }
  if (!check.typeCheck) {
    return { pass: true, detail: `compiled ${String(compiled.fileCount ?? '?')} file(s)` };
  }
  const checked = asRecord(await harness.executeTool('check_scripts'));
  const errorCount = typeof checked.errorCount === 'number' ? checked.errorCount : NaN;
  if (checked.ok === true && errorCount === 0) {
    return {
      pass: true,
      detail: `compiled + type-checked ${String(checked.filesChecked ?? '?')} file(s)`,
    };
  }
  return {
    pass: false,
    detail: `type check: ${Number.isNaN(errorCount) ? 'failed to run' : `${errorCount} error(s)`}`,
  };
}

function checkNodeExists(harness: EvalHarness, check: NodeExistsCheck): Outcome {
  const nameNeedle = check.name.toLowerCase();
  const typeNeedle = check.type?.toLowerCase();
  const matches = harness
    .findNodes(check.name)
    .filter(node => node.name.toLowerCase().includes(nameNeedle))
    .filter(node => !typeNeedle || node.type.toLowerCase().includes(typeNeedle));
  const min = check.minCount ?? 1;
  return matches.length >= min
    ? {
        pass: true,
        detail: `${matches.length} node(s): ${matches
          .slice(0, 3)
          .map(n => n.name)
          .join(', ')}`,
      }
    : { pass: false, detail: `found ${matches.length}, expected ≥ ${min}` };
}

function checkNodeComponent(harness: EvalHarness, check: NodeComponentCheck): Outcome {
  const node = findFirstNode(harness, check.node);
  if (!node) {
    return { pass: false, detail: `node not found: ${check.node}` };
  }
  const detail = harness.nodeDetail(node.nodeId);
  const components = detail?.components ?? [];
  const needle = check.componentType?.toLowerCase();
  const matched = needle
    ? components.filter(
        c =>
          c.className.toLowerCase().includes(needle) ||
          (c.scriptId ?? '').toLowerCase().includes(needle)
      )
    : components;
  return matched.length > 0
    ? {
        pass: true,
        detail: `${node.name}: ${matched
          .map(c => c.scriptId ?? c.className)
          .slice(0, 4)
          .join(', ')}`,
      }
    : {
        pass: false,
        detail: `${node.name} has ${components.length} component(s), none matching "${check.componentType ?? ''}"`,
      };
}

function checkNodeProperty(harness: EvalHarness, check: NodePropertyCheck): Outcome {
  const node = findFirstNode(harness, check.node);
  if (!node) {
    return { pass: false, detail: `node not found: ${check.node}` };
  }
  const properties = harness.nodeDetail(node.nodeId)?.properties ?? null;
  const value = resolvePath(properties, check.property);
  if (value === undefined) {
    return { pass: false, detail: `${node.name}.${check.property} is not set` };
  }
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  if (check.equals !== undefined) {
    const pass = JSON.stringify(value) === JSON.stringify(check.equals);
    return { pass, detail: `${node.name}.${check.property} = ${rendered}` };
  }
  if (check.matches) {
    const pattern = compileRegex(check.matches);
    if (!pattern) {
      return { pass: false, detail: `invalid matches regex: ${check.matches}` };
    }
    return {
      pass: pattern.test(String(typeof value === 'string' ? value : rendered)),
      detail: `${node.name}.${check.property} = ${rendered}`,
    };
  }
  return { pass: true, detail: `${node.name}.${check.property} = ${rendered}` };
}

async function checkFile(harness: EvalHarness, check: FileCheck): Promise<Outcome> {
  let result: Record<string, unknown>;
  try {
    result = asRecord(await harness.executeTool('fs_read', { path: check.path }));
  } catch (error) {
    return { pass: false, detail: `cannot read ${check.path}: ${messageOf(error)}` };
  }
  const content = typeof result.content === 'string' ? result.content : null;
  if (content === null) {
    return { pass: false, detail: `${check.path} is not a text file` };
  }
  if (check.contains && !content.includes(check.contains)) {
    return { pass: false, detail: `${check.path} does not contain "${check.contains}"` };
  }
  if (check.matches) {
    const pattern = compileRegex(check.matches);
    if (!pattern) {
      return { pass: false, detail: `invalid matches regex: ${check.matches}` };
    }
    if (!pattern.test(content)) {
      return { pass: false, detail: `${check.path} does not match /${check.matches}/i` };
    }
  }
  return { pass: true, detail: `${check.path} (${content.length} chars)` };
}

async function checkAsset(harness: EvalHarness, check: AssetCheck): Promise<Outcome> {
  const stats = await harness.imageStats(check.path);
  if (!stats) {
    return { pass: false, detail: `image missing or undecodable: ${check.path}` };
  }
  const facts = `${stats.width}×${stats.height}, ${Math.round(stats.bytes / 1024)}KB, alpha=${stats.hasAlpha} (${Math.round(stats.transparentFraction * 100)}% transparent)`;
  if (check.requireAlpha && !stats.hasAlpha) {
    return { pass: false, detail: `no alpha channel — background not removed. ${facts}` };
  }
  const longest = Math.max(stats.width, stats.height);
  if (check.maxDimension && longest > check.maxDimension) {
    return { pass: false, detail: `longest edge ${longest}px > ${check.maxDimension}px. ${facts}` };
  }
  if (check.maxBytes && stats.bytes > check.maxBytes) {
    return { pass: false, detail: `${stats.bytes} bytes > ${check.maxBytes}. ${facts}` };
  }
  return { pass: true, detail: facts };
}

async function checkPlayClean(harness: EvalHarness, check: PlayCleanCheck): Promise<Outcome> {
  harness.clearErrors();
  const started = asRecord(await harness.executeTool('play_start'));
  if (started.ok !== true) {
    return { pass: false, detail: 'play_start failed' };
  }
  const settle = Math.min(
    Math.max(check.settleMs ?? DEFAULT_PLAY_SETTLE_MS, 0),
    MAX_PLAY_SETTLE_MS
  );
  await harness.wait(settle);
  const playing = harness.isPlaying();
  const errors = harness.errors();
  if (!check.keepPlaying) {
    await harness.executeTool('play_stop');
  }
  if (!playing) {
    return { pass: false, detail: `game not playing after ${settle}ms` };
  }
  return errors.length === 0
    ? { pass: true, detail: `ran ${settle}ms without errors` }
    : { pass: false, detail: `${errors.length} error(s) in ${settle}ms: ${firstErrors(errors)}` };
}

async function checkInputMoves(harness: EvalHarness, check: InputMovesCheck): Promise<Outcome> {
  const startedHere = await ensurePlaying(harness);
  if (startedHere === 'failed') {
    return { pass: false, detail: 'play_start failed' };
  }
  const result = asRecord(
    await harness.executeTool('game_input', { steps: check.steps, observe: check.observe })
  );
  if (!check.keepPlaying) {
    await harness.executeTool('play_stop');
  }
  if (result.ok !== true) {
    return { pass: false, detail: `game_input failed: ${String(result.error ?? 'unknown')}` };
  }
  const newErrors = Array.isArray(result.newErrors) ? result.newErrors : [];
  const observed = asRecord(result.observed);
  const expect = check.expectMoved ?? check.observe;
  const verdicts = expect.map(name => {
    const delta = asRecord(observed[name]);
    const moved = delta.moved === true;
    const distance = asRecord(delta.delta).distance;
    return { name, moved, distance: typeof distance === 'number' ? Math.round(distance) : null };
  });
  const still = verdicts.filter(v => !v.moved);
  const movedNote = verdicts
    .map(v => `${v.name}: ${v.moved ? `moved ${v.distance ?? '?'}` : 'did NOT move'}`)
    .join('; ');
  if (newErrors.length > 0) {
    return { pass: false, detail: `input raised ${newErrors.length} error(s). ${movedNote}` };
  }
  return still.length === 0
    ? { pass: true, detail: movedNote }
    : { pass: false, detail: movedNote };
}

async function checkObserveMoving(
  harness: EvalHarness,
  check: ObserveMovingCheck
): Promise<Outcome> {
  const startedHere = await ensurePlaying(harness);
  if (startedHere === 'failed') {
    return { pass: false, detail: 'play_start failed' };
  }
  const result = asRecord(
    await harness.executeTool('game_observe', {
      nodes: check.nodes,
      sampleMs: check.sampleMs ?? DEFAULT_OBSERVE_SAMPLE_MS,
    })
  );
  if (!check.keepPlaying) {
    await harness.executeTool('play_stop');
  }
  if (result.ok !== true) {
    return { pass: false, detail: `game_observe failed: ${String(result.error ?? 'unknown')}` };
  }
  const movement = asRecord(result.movement);
  const expect = check.expectMoving ?? check.nodes;
  const verdicts = expect.map(name => {
    const delta = asRecord(movement[name]);
    return { name, moving: delta.moved === true || delta.moving === true };
  });
  const note = verdicts.map(v => `${v.name}: ${v.moving ? 'moving' : 'STILL'}`).join('; ');
  return verdicts.every(v => v.moving)
    ? { pass: true, detail: note }
    : { pass: false, detail: note };
}

/** Start play mode if needed. Returns how it went for error reporting. */
async function ensurePlaying(harness: EvalHarness): Promise<'already' | 'started' | 'failed'> {
  if (harness.isPlaying()) {
    return 'already';
  }
  harness.clearErrors();
  const started = asRecord(await harness.executeTool('play_start'));
  if (started.ok !== true) {
    return 'failed';
  }
  await harness.wait(1000);
  return 'started';
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function defaultLabel(check: EvalCheck): string {
  switch (check.kind) {
    case 'tool-called':
      return `agent called ${check.tool}`;
    case 'tool-order':
      return `${check.first} before ${check.then}`;
    case 'compile-clean':
      return check.typeCheck ? 'scripts compile + type-check' : 'scripts compile';
    case 'node-exists':
      return `node "${check.name}" exists`;
    case 'node-component':
      return `"${check.node}" has component ${check.componentType ?? ''}`.trim();
    case 'node-property':
      return `"${check.node}".${check.property}`;
    case 'file':
      return `file ${check.path}`;
    case 'asset':
      return `asset ${check.path}`;
    case 'play-clean':
      return 'plays without errors';
    case 'input-moves':
      return `input moves ${(check.expectMoved ?? check.observe).join(', ')}`;
    case 'observe-moving':
      return `${(check.expectMoving ?? check.nodes).join(', ')} move(s) on its own`;
    case 'no-errors':
      return 'no runtime errors';
  }
}

function findFirstNode(
  harness: EvalHarness,
  query: string
): { nodeId: string; name: string; type: string } | null {
  const needle = query.toLowerCase();
  const matches = harness.findNodes(query);
  // Prefer a name match over the find()'s broader name-or-type match.
  return matches.find(node => node.name.toLowerCase().includes(needle)) ?? matches[0] ?? null;
}

/** Resolve a dot path (e.g. "texture" or "config.speed") inside a serialized Json object. */
function resolvePath(root: Json | null, path: string): Json | undefined {
  let current: Json | undefined = root ?? undefined;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, Json>)[segment];
  }
  return current;
}

function compileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstErrors(errors: ReadonlyArray<{ message: string }>): string {
  return errors
    .slice(0, 2)
    .map(e => e.message.slice(0, 120))
    .join(' | ');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
