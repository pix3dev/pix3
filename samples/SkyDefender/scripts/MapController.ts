import { Script } from '@pix3/runtime';
import type { Label2D, NodeBase, PropertySchema } from '@pix3/runtime';
import type { Texture } from 'three';
import { MISSIONS, MISSION_META, PORTRAITS, type Speaker } from './SdBalance';
import { session, type GameMode } from './SdSession';

/** Map → battle hand-off (SdSession owns the run; GameFlow reads these). */
declare global {
  // eslint-disable-next-line no-var
  var __SD_MODE: GameMode | undefined;
  // eslint-disable-next-line no-var
  var __SD_MISSION: number | undefined;
}

/** UIControl2D hides its canvas-text refresh behind a protected method. */
type RuntimeLabel2D = Label2D & { updateLabel(): void };
type SpriteNode = NodeBase & { setTexture?: (tex: Texture) => void };
type ControlNode = NodeBase & { enabled: boolean };

const CLICK_SOUND = 'res://src/assets/audio/gui/unibat/unibat_press.mp3';
const PAGE_SOUND = 'res://src/assets/audio/gui/ingame/ing_panel_move.mp3';

/** Conquest-map pixels (497×325, top-left origin) → stage-local (sprite at (-1,-2)). */
const mapToLocal = (mx: number, my: number): [number, number] => [mx - 249.5, 160.5 - my];

/**
 * Mirror of UIControl2D's label-texture sizing formula. The label mesh is a
 * plane of exactly this width centred on the node, with left-aligned glyphs
 * starting 10 px in — so `x = left + width/2 - 10` pins a line's left edge.
 */
const labelWidth = (text: string, fontSize: number): number =>
  Math.max(128, Math.ceil(text.length * fontSize * 0.75) + 24);

const TEXT_LEFT = -155; // briefing text column, stage-local
const TEXT_FONT = 15;
const LINE_COUNT = 4;
const WRAP_CHARS = 52;
const CHARS_PER_SECOND = 55;

/** Greedy word-wrap into at most LINE_COUNT rows (tail merges into the last). */
function wrapText(text: string): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > WRAP_CHARS && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  while (lines.length > LINE_COUNT) {
    const tail = lines.pop()!;
    lines[lines.length - 1] = `${lines[lines.length - 1]} ${tail}`;
  }
  return lines;
}

/**
 * MapController — the conquest map (Old World room) between battles.
 * Mission markers sit on the Grekon region; picking an unlocked one opens the
 * GDD briefing dialog (portrait + typewriter text), FIGHT hands the mission to
 * GameFlow via `__SD_MISSION`. Locked missions only tease. BACK returns to the
 * main menu; campaign progress (SdSession.mission) gates the markers.
 */
export class MapController extends Script {
  private markers: ControlNode[] = [];
  private missionTitle: RuntimeLabel2D | null = null;
  private goldLabel: RuntimeLabel2D | null = null;
  private overlay: NodeBase | null = null;
  private portraitSprite: SpriteNode | null = null;
  private speakerLabel: RuntimeLabel2D | null = null;
  private briefingTitle: RuntimeLabel2D | null = null;
  private goalLabel: RuntimeLabel2D | null = null;
  private lineLabels: RuntimeLabel2D[] = [];
  private backButton: ControlNode | null = null;
  private nextButton: ControlNode | null = null;
  private skipButton: ControlNode | null = null;
  private fightButton: ControlNode | null = null;
  private cancelButton: ControlNode | null = null;

  private portraits = new Map<Speaker, Texture>();

  /** 1-based mission of the open briefing; 0 = map view. */
  private briefingMission = 0;
  private lineIndex = 0;
  private charsShown = 0;
  private dialogDone = false;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      battleScene: 'res://src/assets/scenes/main.pix3scene',
      menuScene: 'res://src/assets/scenes/menu.pix3scene',
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'MapController',
      properties: [
        {
          name: 'battleScene',
          type: 'string',
          ui: { label: 'Battle Scene', group: 'Map' },
          getValue: (c: unknown) => (c as MapController).config.battleScene,
          setValue: (c: unknown, v: unknown) => {
            (c as MapController).config.battleScene = String(v);
          },
        },
        {
          name: 'menuScene',
          type: 'string',
          ui: { label: 'Menu Scene', group: 'Map' },
          getValue: (c: unknown) => (c as MapController).config.menuScene,
          setValue: (c: unknown, v: unknown) => {
            (c as MapController).config.menuScene = String(v);
          },
        },
      ],
      groups: { Map: { label: 'Campaign Map', expanded: true } },
    };
  }

  onStart(): void {
    this.missionTitle = this.findNode('mission-title') as RuntimeLabel2D | null;
    this.goldLabel = this.findNode('gold-label') as RuntimeLabel2D | null;
    this.overlay = this.findNode('briefing-overlay');
    this.portraitSprite = this.findNode('briefing-portrait') as SpriteNode | null;
    this.speakerLabel = this.findNode('briefing-speaker') as RuntimeLabel2D | null;
    this.briefingTitle = this.findNode('briefing-title') as RuntimeLabel2D | null;
    this.goalLabel = this.findNode('briefing-goal') as RuntimeLabel2D | null;
    this.lineLabels = [];
    for (let i = 1; i <= LINE_COUNT; i++) {
      const line = this.findNode(`briefing-line-${i}`) as RuntimeLabel2D | null;
      if (line) this.lineLabels.push(line);
    }

    // Mission markers: position from balance data, gate by campaign progress.
    this.markers = [];
    for (let n = 1; n <= MISSIONS.length; n++) {
      const marker = this.findNode(`mission-${n}`) as ControlNode | null;
      if (!marker) continue;
      const meta = MISSION_META[n - 1];
      if (meta) {
        const [x, y] = mapToLocal(meta.spot[0], meta.spot[1]);
        marker.position.set(x, y, 0);
      }
      marker.connect('click', this, () => this.onMissionClicked(n));
      this.markers.push(marker);
    }
    this.refreshMarkers();

    // The frontier ring sits on the next mission to beat.
    const ring = this.findNode('current-ring');
    if (ring) {
      const frontier = Math.min(session.mission, MISSIONS.length);
      const meta = MISSION_META[frontier - 1];
      if (meta) {
        const [x, y] = mapToLocal(meta.spot[0], meta.spot[1]);
        ring.position.set(x, y, 0);
        ring.visible = true;
      }
    }

    this.backButton = this.findNode('map-back-button') as ControlNode | null;
    this.backButton?.connect('click', this, () => {
      void this.goTo(String(this.config.menuScene || 'res://src/assets/scenes/menu.pix3scene'));
    });

    // Briefing controls start disabled — invisible controls still hit-test.
    this.nextButton = this.wirePanelButton('briefing-next-button', () => this.advanceLine());
    this.skipButton = this.wirePanelButton('briefing-skip-button', () => this.skipDialog());
    this.fightButton = this.wirePanelButton('briefing-fight-button', () => this.startBattle());
    this.cancelButton = this.wirePanelButton('briefing-cancel-button', () => this.closeBriefing());

    // Portraits swap per speaker; warm them up front.
    const loader = this.scene?.getAssetLoader();
    if (loader) {
      for (const [speaker, path] of Object.entries(PORTRAITS) as [Speaker, string][]) {
        void loader
          .loadTexture(path)
          .then(tex => this.portraits.set(speaker, tex))
          .catch(() => console.warn(`[MapController] missing portrait ${path}`));
      }
    }

    this.updateGoldLabel();
    this.setLabel(
      this.missionTitle,
      session.mission > MISSIONS.length
        ? 'The province is safe — replay any mission.'
        : 'Select a mission to defend.'
    );
  }

  onUpdate(dt: number): void {
    if (this.briefingMission === 0 || this.dialogDone) return;
    const meta = MISSION_META[this.briefingMission - 1];
    const line = meta?.briefing[this.lineIndex];
    if (!line) return;
    if (this.charsShown < line.text.length) {
      this.charsShown = Math.min(line.text.length, this.charsShown + dt * CHARS_PER_SECOND);
      this.renderTypedText(line.text);
    }
  }

  // ── map interactions ────────────────────────────────────────────────────────

  private onMissionClicked(n: number): void {
    if (this.briefingMission !== 0) return;
    this.scene?.audio.play(CLICK_SOUND, { bus: 'sfx' });
    if (n > session.mission) {
      this.setLabel(this.missionTitle, `Mission ${n} is locked — clear the previous one first.`);
      return;
    }
    this.openBriefing(n);
  }

  private openBriefing(n: number): void {
    this.briefingMission = n;
    this.lineIndex = 0;
    this.charsShown = 0;
    this.dialogDone = false;

    if (this.overlay) this.overlay.visible = true;
    for (const marker of this.markers) marker.enabled = false;
    if (this.backButton) this.backButton.enabled = false;
    this.setButton(this.nextButton, true);
    this.setButton(this.skipButton, true);
    this.setButton(this.cancelButton, true);
    this.setButton(this.fightButton, false);

    this.setLabel(this.briefingTitle, `Mission ${n} — ${MISSIONS[n - 1]?.name ?? ''}`);
    this.setLabel(this.goalLabel, '');
    this.showCurrentLine();
    this.scene?.audio.play(PAGE_SOUND, { bus: 'sfx' });
  }

  private closeBriefing(): void {
    this.briefingMission = 0;
    if (this.overlay) this.overlay.visible = false;
    this.setButton(this.nextButton, false);
    this.setButton(this.skipButton, false);
    this.setButton(this.cancelButton, false);
    this.setButton(this.fightButton, false);
    if (this.backButton) this.backButton.enabled = true;
    this.refreshMarkers();
    this.scene?.audio.play(CLICK_SOUND, { bus: 'sfx' });
  }

  // ── briefing dialog ─────────────────────────────────────────────────────────

  private currentLineText(): string {
    return MISSION_META[this.briefingMission - 1]?.briefing[this.lineIndex]?.text ?? '';
  }

  private showCurrentLine(): void {
    const meta = MISSION_META[this.briefingMission - 1];
    const line = meta?.briefing[this.lineIndex];
    if (!line) {
      this.finishDialog();
      return;
    }
    this.charsShown = 0;
    this.setLabel(this.speakerLabel, line.speaker);
    const portrait = this.portraits.get(line.speaker);
    if (portrait && this.portraitSprite?.setTexture) this.portraitSprite.setTexture(portrait);
    this.renderTypedText(line.text);
  }

  private advanceLine(): void {
    if (this.dialogDone) return;
    const text = this.currentLineText();
    this.scene?.audio.play(CLICK_SOUND, { bus: 'sfx' });
    if (this.charsShown < text.length) {
      // First click completes the line, the next one turns the page.
      this.charsShown = text.length;
      this.renderTypedText(text);
      return;
    }
    this.lineIndex += 1;
    const meta = MISSION_META[this.briefingMission - 1];
    if (!meta || this.lineIndex >= meta.briefing.length) {
      this.finishDialog();
    } else {
      this.showCurrentLine();
    }
  }

  private skipDialog(): void {
    if (this.dialogDone) return;
    const meta = MISSION_META[this.briefingMission - 1];
    if (meta && meta.briefing.length > 0) {
      this.lineIndex = meta.briefing.length - 1;
      this.showCurrentLine();
      this.charsShown = this.currentLineText().length;
      this.renderTypedText(this.currentLineText());
    }
    this.finishDialog();
  }

  /** Dialog exhausted: show the objective and swap NEXT for FIGHT. */
  private finishDialog(): void {
    this.dialogDone = true;
    const meta = MISSION_META[this.briefingMission - 1];
    this.setLabel(this.goalLabel, meta ? `Objective: ${meta.goal}` : '');
    this.setButton(this.nextButton, false);
    this.setButton(this.skipButton, false);
    this.setButton(this.fightButton, true);
  }

  private startBattle(): void {
    if (this.briefingMission === 0) return;
    globalThis.__SD_MODE = 'campaign';
    globalThis.__SD_MISSION = this.briefingMission;
    void this.goTo(String(this.config.battleScene || 'res://src/assets/scenes/main.pix3scene'));
  }

  // ── plumbing ────────────────────────────────────────────────────────────────

  /** Reveal `charsShown` characters of `text` across the wrapped line labels. */
  private renderTypedText(text: string): void {
    const lines = wrapText(text);
    let budget = Math.floor(this.charsShown);
    for (let i = 0; i < this.lineLabels.length; i++) {
      const label = this.lineLabels[i];
      const full = lines[i] ?? '';
      const shown = full.slice(0, Math.max(0, budget));
      budget -= full.length + 1; // the split-off space counts too
      // Pin the left edge: the mesh is centred, so shift by half its width.
      label.position.x = TEXT_LEFT + labelWidth(shown, TEXT_FONT) / 2 - 10;
      this.setLabel(label, shown);
    }
  }

  private refreshMarkers(): void {
    for (let i = 0; i < this.markers.length; i++) {
      const marker = this.markers[i];
      marker.enabled = true;
      // Locked markers stay clickable for the hint but read as small + dimmed.
      const locked = i + 1 > session.mission;
      const s = locked ? 0.65 : 1;
      marker.scale.set(s, s, 1);
      (marker as ControlNode & { opacity?: number }).opacity = locked ? 0.4 : 1;
    }
  }

  private wirePanelButton(id: string, handler: () => void): ControlNode | null {
    const button = this.findNode(id) as ControlNode | null;
    if (!button) {
      console.warn(`[MapController] Button not found: ${id}`);
      return null;
    }
    button.enabled = false;
    button.connect('click', this, handler);
    return button;
  }

  /** Panel buttons pair visibility with `enabled` (invisible ≠ unclickable). */
  private setButton(button: ControlNode | null, on: boolean): void {
    if (!button) return;
    button.visible = on;
    button.enabled = on;
  }

  private updateGoldLabel(): void {
    this.setLabel(this.goldLabel, `Gold: ${Math.floor(session.gold)}`);
  }

  private setLabel(label: RuntimeLabel2D | null, text: string): void {
    if (!label || label.label === text) return;
    label.label = text;
    label.updateLabel();
  }

  private async goTo(scenePath: string): Promise<void> {
    if (!this.scene) return;
    this.scene.audio.play(CLICK_SOUND, { bus: 'sfx' });
    await this.scene.changeScene(scenePath, { transition: 'fade' });
  }
}
