/**
 * UI Kit Forge — canvas padding and the drop shadow (post-processing).
 *
 * `theme.pad` is FIXED and independent of the shadow parameters, so changing the shadow
 * leaves objects where they were, in the preview and in an atlas alike.
 *
 * NOTE: that padding is what made an exported kit unusable before — it lands INSIDE the
 * frame, so a consumer computing a cap from the frame size slices empty space. The engine
 * lane therefore forces `pad: 0` (plan §3.5) and a host records the real body via
 * `slices.ts` instead of trusting the frame.
 */
import { NAVY } from '../ForgeTheme';
import { theme, uid } from '../build-context';
import { innerOf, type RawComponent } from '../svg-primitives';

/** A filter to emit once, and the attribute that applies it to a group. */
export interface ShadowDef {
  def: string;
  attr: string;
}

/**
 * The drop-shadow filter for the current theme, as a reusable pair.
 *
 * Split out of {@link withShadow} because the showcase needs the SAME shadow without the
 * canvas padding: its screens place components at fixed coordinates, so padding them would
 * shift the whole layout. `shadowMode 1` is a hard offset (no blur) — a slab shadow, not a
 * glow. Both fields are empty when the theme has no shadow.
 */
export function shadowDef(): ShadowDef {
  const t = theme();
  if (!t.shadowMode) return { def: '', attr: '' };
  const id = uid('sh');
  const blur = t.shadowMode === 2 ? t.shadowBlur : 0;
  const def =
    `<filter id="${id}" x="-45%" y="-45%" width="190%" height="190%">` +
    `<feDropShadow dx="${t.shadowDx}" dy="${t.shadowDy}" stdDeviation="${blur}" ` +
    `flood-color="${NAVY()}" flood-opacity="${(t.shadowA / 100).toFixed(2)}"/></filter>`;
  return { def, attr: ` filter="url(#${id})"` };
}

/** Pad a component's canvas by `theme.pad` on every side and apply the theme's shadow. */
export function withShadow(comp: RawComponent): RawComponent {
  const t = theme();
  const p = Math.max(0, Math.round(t.pad || 0));
  if (p === 0 && !t.shadowMode) return comp;
  const inner = innerOf(comp);
  const W = comp.w + p * 2;
  const H = comp.h + p * 2;
  const sh = shadowDef();
  return {
    w: W,
    h: H,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      `${sh.def}<g${sh.attr} transform="translate(${p},${p})">${inner}</g></svg>`,
  };
}
