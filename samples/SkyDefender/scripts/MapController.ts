import { Script } from '@pix3/runtime';
import type { Label2D, NodeBase, PropertySchema } from '@pix3/runtime';
import type { Texture } from 'three';
import {
  MISSIONS,
  MISSION_META,
  PORTRAITS,
  missionNameKey,
  speakerKey,
  type BriefingLine,
  type Speaker,
} from './SdBalance';
import type { TrParams } from '@pix3/runtime';
import { session, type GameMode } from './SdSession';

/** Map → battle hand-off (SdSession owns the run; GameFlow reads these). */
declare global {
  // eslint-disable-next-line no-var
  var __SD_MODE: GameMode | undefined;
  // eslint-disable-next-line no-var
  var __SD_MISSION: number | undefined;
}

type SpriteNode = NodeBase & { setTexture?: (tex: Texture) => void };
type ControlNode = NodeBase & { enabled: boolean };

const CLICK_SOUND = 'res://src/assets/audio/gui/unibat/unibat_press.mp3';
const PAGE_SOUND = 'res://src/assets/audio/gui/ingame/ing_panel_move.mp3';

/** Conquest-map pixels (497×325, top-left origin) → stage-local (sprite at (-1,-2)). */
const mapToLocal = (mx: number, my: number): [number, number] => [mx - 249.5, 160.5 - my];

/**
 * MapController — the conquest map (Old World room) between battles.
 * Mission markers sit on the frontier region; picking an unlocked one opens the
 * GDD briefing dialog (portrait + typewriter text), FIGHT hands the mission to
 * GameFlow via `__SD_MISSION`. Locked missions only tease. BACK returns to the
 * main menu; campaign progress (SdSession.mission) gates the markers.
 */
export class MapController extends Script {
  private markers: ControlNode[] = [];
  private missionTitle: Label2D | null = null;
  private goldLabel: Label2D | null = null;
  private overlay: NodeBase | null = null;
  private portraitSprite: SpriteNode | null = null;
  private speakerLabel: Label2D | null = null;
  private briefingTitle: Label2D | null = null;
  private goalLabel: Label2D | null = null;
  private briefingText: Label2D | null = null;
  private backButton: ControlNode | null = null;
  private nextButton: ControlNode | null = null;
  private skipButton: ControlNode | null = null;
  private fightButton: ControlNode | null = null;
  private cancelButton: ControlNode | null = null;

  private portraits = new Map<Speaker, Texture>();

  /** 1-based mission of the open briefing; 0 = map view. */
  private briefingMission = 0;
  private lineIndex = 0;
  private dialogDone = false;
  /** The overlay doubles as the post-victory debriefing (no FIGHT at the end). */
  private overlayMode: 'briefing' | 'epilogue' = 'briefing';
  private dialogLines: BriefingLine[] = [];

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
    this.missionTitle = this.findNode('mission-title') as Label2D | null;
    this.goldLabel = this.findNode('gold-label') as Label2D | null;
    this.overlay = this.findNode('briefing-overlay');
    this.portraitSprite = this.findNode('briefing-portrait') as SpriteNode | null;
    this.speakerLabel = this.findNode('briefing-speaker') as Label2D | null;
    this.briefingTitle = this.findNode('briefing-title') as Label2D | null;
    this.goalLabel = this.findNode('briefing-goal') as Label2D | null;
    // Multiline label: wraps to its fixed box and types itself out
    // (typewriterSpeed is authored on the node in map.pix3scene).
    this.briefingText = this.findNode('briefing-text') as Label2D | null;

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

    // The frontier ring sits on the next mission to beat; the region overlay
    // highlights that mission's theater (original: per-region multiply tint).
    const frontier = Math.min(session.mission, MISSIONS.length);
    const frontierMeta = MISSION_META[frontier - 1];
    const ring = this.findNode('current-ring');
    if (ring && frontierMeta) {
      const [x, y] = mapToLocal(frontierMeta.spot[0], frontierMeta.spot[1]);
      ring.position.set(x, y, 0);
      ring.visible = true;
    }
    const highlight = this.findNode('region-highlight') as SpriteNode | null;
    const loader = this.scene?.getAssetLoader();
    if (highlight?.setTexture && loader && frontierMeta) {
      const url = `res://src/assets/textures/gui/maproom/regions/${frontierMeta.region.toLowerCase()}.png`;
      void loader
        .loadTexture(url)
        .then(tex => highlight.setTexture?.(tex))
        .catch(() => console.warn(`[MapController] missing region overlay ${url}`));
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
    if (loader) {
      for (const [speaker, path] of Object.entries(PORTRAITS) as [Speaker, string][]) {
        void loader
          .loadTexture(path)
          .then(tex => this.portraits.set(speaker, tex))
          .catch(() => console.warn(`[MapController] missing portrait ${path}`));
      }
    }

    this.updateGoldLabel();
    this.setLabelKey(
      this.missionTitle,
      session.mission > MISSIONS.length ? 'map.province-safe' : 'map.select-mission'
    );

    // Returning victorious: play the cleared missions' debriefings (GDD
    // epilogues) once per run, oldest first.
    this.openNextEpilogue();
  }

  /** First cleared mission with an unseen epilogue, or 0. */
  private nextPendingEpilogue(): number {
    for (let n = 1; n < session.mission && n <= MISSION_META.length; n++) {
      if ((MISSION_META[n - 1]?.epilogue?.length ?? 0) === 0) continue;
      if (!session.isEpilogueSeen(n)) return n;
    }
    return 0;
  }

  private openNextEpilogue(): void {
    const n = this.nextPendingEpilogue();
    if (n === 0 || this.briefingMission !== 0) return;
    this.openDialog(n, 'epilogue');
  }

  // ── map interactions ────────────────────────────────────────────────────────

  private onMissionClicked(n: number): void {
    if (this.briefingMission !== 0) return;
    this.scene?.audio.play(CLICK_SOUND, { bus: 'sfx' });
    if (n > session.mission) {
      this.setLabelKey(this.missionTitle, 'map.mission-locked', { n });
      return;
    }
    this.openBriefing(n);
  }

  private openBriefing(n: number): void {
    this.openDialog(n, 'briefing');
  }

  private openDialog(n: number, mode: 'briefing' | 'epilogue'): void {
    const meta = MISSION_META[n - 1];
    const lines = (mode === 'epilogue' ? meta?.epilogue : meta?.briefing) ?? [];
    if (lines.length === 0) return;
    this.briefingMission = n;
    this.overlayMode = mode;
    this.dialogLines = lines;
    this.lineIndex = 0;
    this.dialogDone = false;

    if (this.overlay) this.overlay.visible = true;
    for (const marker of this.markers) marker.enabled = false;
    if (this.backButton) this.backButton.enabled = false;
    this.setButton(this.nextButton, true);
    this.setButton(this.skipButton, true);
    this.setButton(this.cancelButton, true);
    this.setButton(this.fightButton, false);

    const name = this.tr(missionNameKey(n));
    this.setLabelKey(
      this.briefingTitle,
      mode === 'epilogue' ? 'map.briefing.title-cleared' : 'map.briefing.title',
      { n, name }
    );
    this.setLabel(this.goalLabel, '');
    this.showCurrentLine();
    this.scene?.audio.play(PAGE_SOUND, { bus: 'sfx' });
  }

  private closeBriefing(): void {
    const wasEpilogue = this.overlayMode === 'epilogue';
    if (wasEpilogue && this.briefingMission > 0) {
      session.markEpilogueSeen(this.briefingMission);
    }
    this.briefingMission = 0;
    this.overlayMode = 'briefing';
    if (this.overlay) this.overlay.visible = false;
    this.setButton(this.nextButton, false);
    this.setButton(this.skipButton, false);
    this.setButton(this.cancelButton, false);
    this.setButton(this.fightButton, false);
    if (this.backButton) this.backButton.enabled = true;
    this.refreshMarkers();
    this.scene?.audio.play(CLICK_SOUND, { bus: 'sfx' });
    // Several missions may have cleared in one battle chain — debrief them all.
    if (wasEpilogue) this.openNextEpilogue();
  }

  // ── briefing dialog ─────────────────────────────────────────────────────────

  private showCurrentLine(): void {
    const line = this.dialogLines[this.lineIndex];
    if (!line) {
      this.finishDialog();
      return;
    }
    this.setLabelKey(this.speakerLabel, speakerKey(line.speaker));
    const portrait = this.portraits.get(line.speaker);
    if (portrait && this.portraitSprite?.setTexture) this.portraitSprite.setTexture(portrait);
    this.briefingText?.setTextKey(line.textKey);
    // setText only restarts on changed text; replaying the same line
    // (re-opened briefing) still needs a fresh reveal.
    this.briefingText?.restartTypewriter();
  }

  private advanceLine(): void {
    if (this.dialogDone) return;
    this.scene?.audio.play(CLICK_SOUND, { bus: 'sfx' });
    if (this.briefingText?.isTyping) {
      // First click completes the line, the next one turns the page.
      this.briefingText.skipTypewriter();
      return;
    }
    this.lineIndex += 1;
    if (this.lineIndex >= this.dialogLines.length) {
      this.finishDialog();
    } else {
      this.showCurrentLine();
    }
  }

  private skipDialog(): void {
    if (this.dialogDone) return;
    if (this.dialogLines.length > 0) {
      this.lineIndex = this.dialogLines.length - 1;
      this.showCurrentLine();
      this.briefingText?.skipTypewriter();
    }
    this.finishDialog();
  }

  /**
   * Dialog exhausted. Briefing: show the objective and swap NEXT for FIGHT.
   * Epilogue: nothing left to start — CANCEL (already visible) closes it.
   */
  private finishDialog(): void {
    this.dialogDone = true;
    this.setButton(this.nextButton, false);
    this.setButton(this.skipButton, false);
    if (this.overlayMode === 'epilogue') {
      this.setLabel(this.goalLabel, '');
      this.setButton(this.fightButton, false);
      return;
    }
    const meta = MISSION_META[this.briefingMission - 1];
    if (meta) {
      this.setLabelKey(this.goalLabel, 'map.objective', { goal: this.tr(meta.goalKey) });
    } else {
      this.setLabel(this.goalLabel, '');
    }
    this.setButton(this.fightButton, true);
  }

  private startBattle(): void {
    if (this.briefingMission === 0) return;
    globalThis.__SD_MODE = 'campaign';
    globalThis.__SD_MISSION = this.briefingMission;
    void this.goTo(String(this.config.battleScene || 'res://src/assets/scenes/main.pix3scene'));
  }

  // ── plumbing ────────────────────────────────────────────────────────────────

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
    this.setLabelKey(this.goldLabel, 'hud.gold', { amount: Math.floor(session.gold) });
  }

  private setLabel(label: Label2D | null, text: string): void {
    label?.setText(text);
  }

  /** Bind a label to a translation key — re-resolves live on locale switch. */
  private setLabelKey(label: Label2D | null, key: string, params?: TrParams): void {
    label?.setTextKey(key, params);
  }

  /** Translate a key through the scene's localization (echoes the key when inert). */
  private tr(key: string): string {
    return this.scene?.localization.tr(key) ?? key;
  }

  private async goTo(scenePath: string): Promise<void> {
    if (!this.scene) return;
    this.scene.audio.play(CLICK_SOUND, { bus: 'sfx' });
    await this.scene.changeScene(scenePath, { transition: 'fade' });
  }
}
