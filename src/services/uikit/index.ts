/**
 * UI Kit Forge — the public surface of the host-agnostic core.
 *
 * Everything here is a pure function of a {@link ForgeTheme} plus a spec. The core knows
 * nothing about a DOM, a file picker, rasterization or the editor's services: a host supplies
 * those, which is what lets the standalone page and the editor panel share one generator
 * without a branch inside it (plan §4).
 *
 * `host-agnostic.spec.ts` enforces that invariant by scanning these sources.
 */

// colour maths
export { adj, brightness, hexToHsl, hslToHex, isHex, lum, type ColorDelta } from './color';

// the theme
export {
  C,
  CYR_FONTS,
  DARK,
  DEFAULT_THEME,
  FONTS,
  LABEL_EDGE,
  NAVY,
  PALETTE,
  faceFor,
  faceSpecs,
  fontFamilies,
  fontStack,
  fontW,
  hasCyr,
  ink,
  isCyrText,
  normalizeTheme,
  weightOf,
  type FaceInlineSpec,
  type FaceSpec,
  type FontSpec,
  type ForgeTheme,
  type GlossType,
  type PaletteEntry,
  type PaletteId,
  type ShadowMode,
  type TxtColorMode,
} from './ForgeTheme';

// the build context
export {
  LANGS,
  beginAnchors,
  hasBuildContext,
  isStrippingText,
  lang,
  pushAnchor,
  runBuild,
  takeAnchors,
  theme,
  uid,
  type BuildOptions,
  type ForgeLang,
  type RawAnchor,
} from './build-context';

// SVG primitives
export {
  bevelRect,
  escapeXml,
  estTextWidth,
  fitTextSize,
  glossFor,
  innerOf,
  label,
  pillowPath,
  recessRect,
  roundedPoly,
  svgDoc,
  vGrad,
  type BevelRectOptions,
  type LabelOptions,
  type Paint,
  type RawComponent,
  type RecessRectOptions,
  type RoundedPolyOptions,
} from './svg-primitives';

// icons
export {
  ICONS,
  ICON_ALIASES,
  ICON_NAMES,
  icon,
  iconStroke,
  resolveIconName,
  type IconDef,
  type IconStrokeOptions,
} from './icons';

// generators
export * from './skins';

// showcase screens
export {
  SCREEN_W,
  SETTINGS_ROW,
  place,
  scMap,
  scSettings,
  scSettingsBase,
  scSettingsGame,
  scShop,
  scTutorial,
  scWin,
  screenDoc,
  type SettingsButton,
  type SettingsRow,
} from './showcase';

// captions
export { allKeys, missingKeys, tx } from './strings';

// the registry
export {
  TABS,
  buildAll,
  buildComponent,
  buildTab,
  listAll,
  type ComponentDescriptor,
  type ForgeComponent,
  type TabDescriptor,
  type TaggedDescriptor,
} from './registry';

// slicing metadata
export {
  BODY_ALPHA,
  TRIM_ALPHA,
  alphaBounds,
  bodyBounds,
  fitsCaps,
  frameMeta,
  glossIsTopStrip,
  midFraction,
  nineCap,
  num,
  round2,
  round3,
  sliceBorder,
  textAnchor,
  trimBounds,
  type FrameMeta,
  type FrameMetaArgs,
  type RgbaBuffer,
  type SliceBorder,
  type SliceBorderOptions,
  type SliceCaps,
  type SliceFit,
  type SliceRect,
  type TextAnchor,
  type TextAnchorOptions,
} from './slices';

// the engine lane
export {
  BUTTON_STATES,
  DEFAULT_SKIN_ICON,
  MIN_GLOSS_BAND,
  STRETCHED_COMPONENTS,
  buildButtonStates,
  buildSkin,
  capGlossForStretch,
  engineLaneTheme,
  isNineSliceable,
  skinBuildTheme,
  type ButtonLikeComponent,
  type SkinComponent,
  type SkinPart,
  type SkinSpec,
} from './SkinSpec';

// templates
export {
  buildTemplate,
  walkTemplate,
  type TemplateAnchor,
  type TemplateId,
  type TemplateNode,
  type TemplateNodeType,
  type TemplateOptions,
  type TemplateSpec,
} from './TemplateSpec';

// presets
export { DEFAULT_PRESET, PRESETS, presetNames, presetTheme, type ForgePreset } from './presets';

// the style contract
export {
  CONTRACT_VERSION,
  GENERATOR,
  buildStyleMarkdown,
  buildTokensJson,
  type ForgeTokens,
  type PaletteTokens,
  type StyleDocFrame,
  type StyleDocOptions,
} from './style-doc';
