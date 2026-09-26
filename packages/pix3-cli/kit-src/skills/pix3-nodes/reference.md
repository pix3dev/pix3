<!-- Pix3 agent kit {{version}} — generated from docs/node-types-reference.md. Do not edit: pix3 kit --update regenerates it. -->
# Pix3 node reference

Every node type the loader knows, with its properties. **Grep `### <NodeName>`** for one node
instead of reading this file. Keys are YAML keys under `properties:`; `position` / `rotation` /
`scale` go in the `transform:` block, `flow.*` in the `flow:` block, and the anchor keys in
`layout:` (see `pix3-scene-format`). Where a row says "not saved", the key does nothing in a file.

## Quick reference

{{include:docs/node-types-reference.md#Node Properties Quick Reference}}

## Choosing the right node

{{include:docs/node-types-reference.md#Choosing the Right Node|shift=1}}

{{include:docs/node-types-reference.md#2D Nodes|heading}}

{{include:docs/node-types-reference.md#3D Nodes|heading}}

{{include:docs/node-types-reference.md#Post-processing|heading}}

{{include:docs/node-types-reference.md#Audio|heading}}
