/**
 * UI Kit Forge — the registry: which components exist, and in which tab they show.
 *
 * One place that names every exportable sprite. A tab marked `noExport` is a specification
 * rather than art: the showcase screens are drawn for the eye and for the generated docs,
 * and only their bricks ship as sprites.
 *
 * Ported from `src/dev/uikit/registry.js`. The build functions changed shape: instead of
 * flipping module globals they run each TOP-LEVEL descriptor inside its own
 * {@link runBuild}, which resets the uid counter — so one `(theme, name, lang)` yields a
 * byte-identical SVG (plan §9.2).
 */
import { PALETTE } from './ForgeTheme';
import {
  beginAnchors,
  runBuild,
  takeAnchors,
  type BuildOptions,
  type RawAnchor,
} from './build-context';
import type { RawComponent } from './svg-primitives';
import { tx } from './strings';
import {
  compBannerButton,
  compBigButton,
  compButton,
  compCheckMark,
  compCheckbox,
  compDayCard,
  compGlyph,
  compHeaderPlate,
  compHexButton,
  compIconTextButton,
  compLevelBar,
  compLevelHex,
  compLockBadge,
  compOfferCard,
  compPanel,
  compPanelBody,
  compPanelSlot,
  compPlate,
  compProgress,
  compRadio,
  compResourceCounter,
  compRibbon,
  compSegmentBar,
  compShield,
  compSlider,
  compSquareIcon,
  compStar,
  compTabBar,
  compTickSlider,
  compToggle,
  withShadow,
} from './skins';
import { scMap, scSettings, scSettingsGame, scShop, scTutorial, scWin } from './showcase';

/** One entry of a tab: the sprite name and the function that draws it. */
export interface ComponentDescriptor {
  name: string;
  make: () => RawComponent;
}

export interface TabDescriptor {
  id: string;
  name: string;
  /** Preview and documentation only — never shipped as sprites. */
  noExport?: boolean;
  list: () => ComponentDescriptor[];
}

/** A built component: the document, its size, and the anchors of any stripped captions. */
export interface ForgeComponent {
  name: string;
  tab: string;
  svg: string;
  w: number;
  h: number;
  anchors?: RawAnchor[];
}

export const TABS: readonly TabDescriptor[] = [
  {
    id: 'showcase',
    name: 'Showcase',
    noExport: true,
    list: () => [
      { name: 'sc_shop', make: () => scShop() },
      { name: 'sc_map', make: () => scMap() },
      { name: 'sc_settings', make: () => scSettings() },
      { name: 'sc_settings_ingame', make: () => scSettingsGame() },
      { name: 'sc_tutorial', make: () => scTutorial() },
      { name: 'sc_win', make: () => scWin() },
    ],
  },
  {
    id: 'buttons',
    name: 'Buttons',
    list: () => {
      const out: ComponentDescriptor[] = [];
      for (const p of PALETTE)
        out.push({ name: 'btn_' + p.id, make: () => compButton(p.id, p.label) });
      // The four states of one button, so the difference can be judged side by side (§9.3).
      out.push({ name: 'btn_state_normal', make: () => compButton('green', 'Play') });
      out.push({
        name: 'btn_state_hover',
        make: () => compButton('green', 'Play', 250, 88, { state: 'hover' }),
      });
      out.push({
        name: 'btn_state_pressed',
        make: () => compButton('green', 'Play', 250, 88, { state: 'pressed' }),
      });
      out.push({
        name: 'btn_state_disabled',
        make: () => compButton('green', 'Play', 250, 88, { state: 'disabled' }),
      });
      out.push({
        name: 'btn_banner_activate',
        make: () => compBannerButton('green', tx('s_activate'), 270, 92),
      });
      out.push({
        name: 'btn_banner_claim',
        make: () => compBannerButton('green', tx('s_claim'), 270, 92),
      });
      out.push({ name: 'btn_icon_video', make: () => compIconTextButton('yellow', 'film', '9/9') });
      out.push({
        name: 'btn_icon_text_blue',
        make: () => compIconTextButton('blue', 'film', tx('s_text')),
      });
      return out;
    },
  },
  {
    id: 'icons',
    name: 'Icon buttons',
    list: () => [
      { name: 'hex_settings', make: () => compHexButton('blue', 'gear') },
      { name: 'hex_play', make: () => compHexButton('blue', 'play') },
      { name: 'hex_refresh', make: () => compHexButton('blue', 'refresh') },
      { name: 'hex_exit', make: () => compHexButton('red', 'exit') },
      { name: 'sq_trash', make: () => compSquareIcon('blue', 'trash') },
      { name: 'sq_close', make: () => compSquareIcon('bluegray', 'close') },
      { name: 'sq_left', make: () => compSquareIcon('bluegray', 'left') },
      { name: 'sq_right', make: () => compSquareIcon('bluegray', 'right') },
      { name: 'sq_plus', make: () => compSquareIcon('blue', 'plus') },
      { name: 'sq_sound', make: () => compSquareIcon('green', 'sound') },
      { name: 'sq_trophy', make: () => compSquareIcon('yellow', 'trophy') },
      { name: 'sq_cart', make: () => compSquareIcon('sky', 'cart') },
      { name: 'badge_lock', make: () => compLockBadge() },
      { name: 'btn_stage', make: () => compBigButton('blue', 'map', tx('s_stage')) },
      { name: 'btn_battle', make: () => compBigButton('yellow', 'swords', tx('s_battle')) },
      { name: 'hex_level_done', make: () => compLevelHex(48, 'done') },
      { name: 'hex_level_current', make: () => compLevelHex(49, 'current') },
      { name: 'hex_level_locked', make: () => compLevelHex(50, 'locked') },
      { name: 'star_gold', make: () => compStar() },
    ],
  },
  {
    id: 'iconset',
    name: 'Glyphs',
    list: () => {
      const names = [
        'gear',
        'home',
        'star',
        'heart',
        'trophy',
        'crown',
        'shield2',
        'cart',
        'info',
        'question',
        'bell',
        'calendar',
        'flag2',
        'key',
        'search',
        'pause',
        'play',
        'refresh',
        'close',
        'check',
        'plus',
        'minus',
        'lock',
        'trash',
        'share',
        'chat',
        'sound',
        'bolt',
        'map',
        'swords',
        'left',
        'right',
        'exit',
        'film',
      ];
      return names.map(n => ({ name: 'ic_' + n, make: () => compGlyph(n) }));
    },
  },
  {
    id: 'toggles',
    name: 'Toggles',
    list: () => [
      { name: 'toggle_on', make: () => compToggle(true) },
      { name: 'toggle_off', make: () => compToggle(false) },
      { name: 'checkbox_on', make: () => compCheckbox(true) },
      { name: 'checkbox_off', make: () => compCheckbox(false) },
      { name: 'check_mark', make: () => compCheckMark() },
      { name: 'radio_on', make: () => compRadio(true) },
      { name: 'radio_off', make: () => compRadio(false) },
      { name: 'slider_ticks', make: () => compTickSlider(46) },
    ],
  },
  {
    id: 'progress',
    name: 'Progress',
    list: () => [
      { name: 'bar_loading', make: () => compProgress(71, tx('s_loading'), 'yellow', 620, 66) },
      { name: 'bar_hp', make: () => compProgress(64, '999/999', 'sky', 430, 54) },
      { name: 'bar_xp', make: () => compProgress(45, '99/99', 'green', 430, 54) },
      { name: 'bar_segments', make: () => compSegmentBar(3, 11, '9/99') },
      { name: 'slider_knob', make: () => compSlider(62) },
      {
        name: 'level_bar_gold',
        make: () => compLevelBar(99, tx('s_text_caps'), 'yellow', 'yellow'),
      },
      { name: 'level_bar_green', make: () => compLevelBar(99, tx('s_text_caps'), 'sky', 'green') },
      { name: 'level_bar_blue', make: () => compLevelBar(99, '99/99', 'sky', 'sky') },
    ],
  },
  {
    id: 'panels',
    name: 'Panels and resources',
    list: () => [
      { name: 'panel_window', make: () => compPanel(tx('s_settings')) },
      { name: 'panel_body', make: () => compPanelBody('sky', 420, 320) },
      { name: 'panel_slot', make: () => compPanelSlot() },
      { name: 'header_plate', make: () => compHeaderPlate(tx('set_title'), 'sky', 420, 76) },
      { name: 'plate_hard', make: () => compPlate('red', tx('map_hard')) },
      { name: 'offer_card_coins', make: () => compOfferCard('coin', 'x500', '0.99$') },
      { name: 'offer_card_gems', make: () => compOfferCard('gem', 'x50', '4.99$') },
      { name: 'day_card_done', make: () => compDayCard('done', tx('day_1')) },
      { name: 'day_card_reward', make: () => compDayCard('reward', tx('day_2')) },
      { name: 'day_card_mystery', make: () => compDayCard('mystery', tx('day_5')) },
      { name: 'ribbon_yellow', make: () => compRibbon('yellow', tx('s_title_text')) },
      { name: 'ribbon_green', make: () => compRibbon('green', tx('s_title_text')) },
      { name: 'ribbon_orange', make: () => compRibbon('orange', tx('s_title_text')) },
      {
        name: 'tabbar_1',
        make: () => compTabBar([tx('s_tab') + '1', tx('s_tab') + '2', tx('s_tab') + '3'], 0),
      },
      {
        name: 'tabbar_2',
        make: () =>
          compTabBar([tx('shop_title'), tx('s_heroes'), tx('s_battle'), tx('s_clan')], 2, 640, 84),
      },
      { name: 'badge_shield_9', make: () => compShield(9) },
      { name: 'badge_shield_99', make: () => compShield(99, 88, 'yellow') },
      { name: 'counter_energy', make: () => compResourceCounter('green', 'bolt', '99 / 99') },
      { name: 'counter_hearts', make: () => compResourceCounter('red', 'heart', '5') },
      { name: 'counter_coins', make: () => compResourceCounter('orange', 'coin', '9,999,999') },
      { name: 'counter_gems', make: () => compResourceCounter('purple', 'gem', '99,999') },
    ],
  },
];

/** A descriptor plus the tab it came from. */
export interface TaggedDescriptor extends ComponentDescriptor {
  tab: string;
}

/**
 * The descriptors of every EXPORTABLE component, in tab order.
 *
 * Safe to call outside a build context: descriptors only name the work, they do not do it.
 *
 * @param tabId only this tab (the glyphs ship as their own atlas)
 */
export function listAll(tabId?: string): TaggedDescriptor[] {
  const out: TaggedDescriptor[] = [];
  for (const t of TABS) {
    if (t.noExport) continue; // showcase — preview and docs only, not sprites
    if (tabId && t.id !== tabId) continue;
    for (const d of t.list()) out.push({ tab: t.id, ...d });
  }
  return out;
}

/**
 * Build one descriptor inside its own build context.
 *
 * The counter reset is per TOP-LEVEL build, which is what makes the output deterministic
 * without pinning it with a string snapshot: a showcase screen nests a dozen parts into one
 * document, and their gradient ids must not collide.
 */
function buildOne(descriptor: TaggedDescriptor, opts: BuildOptions): ForgeComponent {
  return runBuild(opts, () => {
    if (opts.stripText) beginAnchors();
    const raw = withShadow(descriptor.make());
    const anchors = opts.stripText ? takeAnchors() : [];
    const comp: ForgeComponent = {
      name: descriptor.name,
      tab: descriptor.tab,
      svg: raw.svg,
      w: raw.w,
      h: raw.h,
    };
    if (anchors.length) comp.anchors = anchors;
    return comp;
  });
}

/**
 * Build every exportable component.
 *
 * `opts.stripText` drops the captions: a host's engine lane draws them at runtime, so a baked
 * word would be wrong in every other language and at every other count. With it on, each
 * returned component also carries `anchors` — where the captions it gave up belonged.
 */
export function buildAll(opts: BuildOptions, tabId?: string): ForgeComponent[] {
  return listAll(tabId).map(d => buildOne(d, opts));
}

/** One tab's components — including a `noExport` tab, which is what a preview wants. */
export function buildTab(tabId: string, opts: BuildOptions): ForgeComponent[] {
  const tab = TABS.find(t => t.id === tabId);
  if (!tab) return [];
  return tab.list().map(d => buildOne({ tab: tab.id, ...d }, opts));
}

/** One component by name, from any tab. `null` when there is no such name. */
export function buildComponent(name: string, opts: BuildOptions): ForgeComponent | null {
  for (const tab of TABS) {
    for (const d of tab.list()) {
      if (d.name === name) return buildOne({ tab: tab.id, ...d }, opts);
    }
  }
  return null;
}
