<!-- Pix3 agent kit {{version}} — generated from docs/nodes-and-systems.md, src/services/agent/agent-skills/engine-api-map.md and the runtime's component registry. Do not edit: pix3 kit --update regenerates it. -->
# Script API reference

Generated from the engine's own documentation and code. Grep a heading instead of reading it
whole. Tool names the in-editor agent uses appear in places: `add_component` /
`set_component_property` = edit the scene YAML's `components:`; `list_component_types` = the
"`core:` components" section at the end of this file; `engine_search` / `engine_read` do not
exist for you — the runtime's declarations are in `.pix3/types/@pix3/runtime/`.

## The surface a `Script` sees

{{include:docs/nodes-and-systems.md#Scripts-facing runtime API}}

## Engine API map

### A `Script`

{{include:src/services/agent/agent-skills/engine-api-map.md#A `Script`}}

### Nodes

{{include:src/services/agent/agent-skills/engine-api-map.md#Nodes}}

### `this.scene`

{{include:src/services/agent/agent-skills/engine-api-map.md#`this.scene`}}

### `this.input`

{{include:src/services/agent/agent-skills/engine-api-map.md#`this.input`}}

### Traps

{{include:src/services/agent/agent-skills/engine-api-map.md#Traps}}

## Capability catalog — nodes

{{include:docs/nodes-and-systems.md#Nodes (scene building blocks)|shift=1}}

## Capability catalog — `core:*` behaviours

{{include:docs/nodes-and-systems.md#Script components you can attach|shift=1}}

## `core:` components — every config key

Read from the runtime's component registry for this CLI's version: the keys a `config:` block
may carry, their type, the default a fresh component has, and the inspector's range/options.

{{generated:core-components}}
