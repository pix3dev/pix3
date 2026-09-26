<!-- Pix3 agent kit {{version}} — generated from docs/pix3-specification.md ("Scene File Format"). Do not edit: pix3 kit --update regenerates it. -->
# `.pix3scene` — the engine specification

Excerpts of the engine's specification, as shipped with this CLI. `SKILL.md` beside this file
is the practical version and wins where they differ — in particular node ids may be readable
kebab-case, and there are no scene-format migrations today (`version: 1.0.0` is the only one).
The "Flat Asset Layout" principle is what `pix3 new` creates; an existing project keeps its own
layout (`res://` is always relative to the project root). Source paths quoted here (`src/…`, `packages/…`) are files of the Pix3 engine repository, not of this project.

## Key principles

{{include:docs/pix3-specification.md#Key Principles}}

## Skinned 2D UI controls

{{include:docs/pix3-specification.md#Skinned 2D UI controls}}

## Spine skeleton nodes

{{include:docs/pix3-specification.md#Spine skeleton nodes}}

## Groups

{{include:docs/pix3-specification.md#Groups Engine|shift=1}}

## Prefabs — instance creation

{{include:docs/pix3-specification.md#Instance Creation}}
