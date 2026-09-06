/**
 * UI Kit Forge — the captions of the kit, in BOTH languages.
 *
 * Why this file exists: a showcase written in whichever language a screen happened to be
 * drawn in hides exactly the case that breaks. A kit is judged on how the words SIT in the
 * shapes, and Cyrillic is wider at the same size and comes from a different face
 * (`ForgeTheme: faceFor`). So every caption goes through {@link tx}, the language is one
 * field of the build context, and a missing translation shows up as the KEY rather than as
 * a plausible-looking English word.
 *
 * Ported from `src/dev/uikit/strings.js`; the language global became the build context.
 */
import { lang } from './build-context';

interface Entry {
  ru: string;
  en: string;
}

// ru first, mirroring the source kit's primary dictionary.
const STR: Readonly<Record<string, Entry>> = {
  // --- shop ---
  shop_title: { ru: 'МАГАЗИН', en: 'Shop' },
  shop_pack: { ru: 'НАБОР НОВИЧКА', en: 'Starter Pack' },
  shop_buy: { ru: 'КУПИТЬ', en: 'Buy' },

  // --- level map ---
  map_hard: { ru: 'СЛОЖНЫЙ', en: 'HARD' },
  map_play: { ru: 'ИГРАТЬ', en: 'PLAY' },

  // --- settings ---
  set_title: { ru: 'НАСТРОЙКИ', en: 'SETTINGS' },
  set_sounds: { ru: 'Звук', en: 'Sounds' },
  set_haptic: { ru: 'Вибрация', en: 'Haptic' },
  set_notify: { ru: 'Уведомления', en: 'Notifications' },
  set_privacy: { ru: 'Приватность', en: 'Privacy' },
  set_contact: { ru: 'Поддержка', en: 'Contact' },
  set_restore: { ru: 'Восстановить', en: 'Restore' },
  set_save: { ru: 'Сохранить', en: 'Save' },
  set_restart: { ru: 'Начать заново', en: 'Restart Level' },
  set_home: { ru: 'На карту', en: 'Return Home' },

  // --- tutorial / daily rewards ---
  tut_title: { ru: 'ЕЖЕДНЕВНЫЕ НАГРАДЫ', en: 'Daily Rewards' },
  tut_line1: { ru: 'Заходи каждый день и забирай награду', en: 'Log in daily and collect rewards' },
  tut_line2: { ru: 'Не прерывай серию', en: 'Keep your streak going' },
  tut_tap: { ru: 'Нажми, чтобы продолжить', en: 'Tap to Continue' },
  day_1: { ru: 'День 1', en: 'Day 1' },
  day_2: { ru: 'День 2', en: 'Day 2' },
  day_5: { ru: 'День 5', en: 'Day 5' },

  // --- win ---
  win_level_name: { ru: 'Труба', en: 'Pipe' },
  win_again: { ru: 'Заново', en: 'Again' },
  win_reward: { ru: 'НАГРАДА', en: 'REWARD' },

  // --- component samples (the other tabs) ---
  s_activate: { ru: 'АКТИВИРОВАТЬ', en: 'Activate' },
  s_claim: { ru: 'ЗАБРАТЬ', en: 'Claim' },
  s_text: { ru: 'Текст', en: 'Text' },
  s_text_caps: { ru: 'ТЕКСТ', en: 'TEXT' },
  s_stage: { ru: 'ЭТАП', en: 'STAGE' },
  s_battle: { ru: 'БОЙ', en: 'BATTLE' },
  s_loading: { ru: 'Загрузка…71%', en: 'Loading...71%' },
  s_settings: { ru: 'Настройки', en: 'Settings' },
  s_title_text: { ru: 'Заголовок', en: 'Title text' },
  s_tab: { ru: 'Таб', en: 'Tab' },
  s_heroes: { ru: 'Герои', en: 'Heroes' },
  s_clan: { ru: 'Клан', en: 'Clan' },

  // --- template captions (dialog / settings, plan §5) ---
  dlg_title: { ru: 'ДИАЛОГ', en: 'DIALOG' },
  dlg_body: { ru: 'Текст сообщения', en: 'Message text' },
  dlg_ok: { ru: 'ОК', en: 'OK' },
  dlg_cancel: { ru: 'Отмена', en: 'Cancel' },
  dlg_close: { ru: 'Закрыть', en: 'Close' },
  dlg_on: { ru: 'ВКЛ', en: 'ON' },
};

/**
 * One caption in the build context's language.
 *
 * @returns the translation, or the KEY itself when there is none — a missing string must
 *   look broken in the preview, not merely English.
 */
export function tx(key: string): string {
  const entry = STR[key];
  if (!entry) return key;
  return entry[lang()] || entry.en || key;
}

/** Every key, for a completeness check. */
export function allKeys(): string[] {
  return Object.keys(STR);
}

/** The keys whose translation is missing in either language. */
export function missingKeys(): string[] {
  return Object.keys(STR).filter(k => !STR[k].ru || !STR[k].en);
}
