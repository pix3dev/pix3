# palette-lab

Dev harness for iterating on the Flow style-palette picker (`src/services/image-gen/image-ops.ts`)
against a folder of real reference PNGs, without a browser. Not part of the build; not a workspace.

```bash
npx tsx tools/palette-lab/run.ts --candidate baseline --corpus <dir-of-pngs> --out <dir>
```

Writes `<out>/<candidate>.json` (palettes + metrics) and `<out>/<candidate>-sheet.png` (thumbnail |
five swatches on the picture's own bg, in role order), and prints a Markdown table to stdout.

## Candidates

`candidates/<name>.ts` exports:

```ts
export const meta: CandidateMeta = { name, description };
export function pick(pixels: ImagePixels): string[]; // exactly 5 lower-case #rrggbb
```

Role order is the recipe contract (`paletteColorForRole`): `[bg, mid, mid, hazard, player]`.
`baseline.ts` is the shipped pipeline as the control — it calls the exported
`stylePaletteFromPixels` (the editor's own post-decode path), so it cannot drift from what ships.

Type-check: `npx tsc -p tools/palette-lab/tsconfig.json`.
