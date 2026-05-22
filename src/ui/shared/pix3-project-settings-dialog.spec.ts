import { afterEach, describe, expect, it } from 'vitest';
import { appState, resetAppState } from '@/state';
import { createDefaultProjectManifest } from '@/core/ProjectManifest';
import { ProjectSettingsDialog } from './pix3-project-settings-dialog';

describe('ProjectSettingsDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    resetAppState();
  });

  it('preserves unsaved general inputs on unrelated project updates', async () => {
    resetAppState();
    appState.project.manifest = createDefaultProjectManifest();

    const dialog = document.createElement('pix3-project-settings-dialog') as ProjectSettingsDialog;
    document.body.appendChild(dialog);
    await dialog.updateComplete;

    const exportSceneInput = dialog.querySelector('#defaultExportScenePath') as HTMLInputElement;
    const widthInput = dialog.querySelector('#viewportBaseWidth') as HTMLInputElement;
    const heightInput = dialog.querySelector('#viewportBaseHeight') as HTMLInputElement;

    exportSceneInput.value = 'src/assets/scenes/custom.pix3scene';
    exportSceneInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
    widthInput.value = '2500';
    widthInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
    heightInput.value = '1400';
    heightInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await dialog.updateComplete;

    appState.project.manifest = {
      ...createDefaultProjectManifest(),
      autoloads: [
        { scriptPath: 'scripts/GameManager.ts', singleton: 'GameManager', enabled: true },
      ],
      defaultExportScenePath: 'src/assets/scenes/main.pix3scene',
      viewportBaseSize: { width: 1920, height: 1080 },
    };

    await Promise.resolve();
    await dialog.updateComplete;

    expect((dialog as unknown as { defaultExportScenePath: string }).defaultExportScenePath).toBe(
      'src/assets/scenes/custom.pix3scene'
    );
    expect((dialog as unknown as { viewportBaseWidth: string }).viewportBaseWidth).toBe('2500');
    expect((dialog as unknown as { viewportBaseHeight: string }).viewportBaseHeight).toBe('1400');
  });

  it('syncs general inputs from manifest when fields are not dirty', async () => {
    resetAppState();
    appState.project.manifest = createDefaultProjectManifest();

    const dialog = document.createElement('pix3-project-settings-dialog') as ProjectSettingsDialog;
    document.body.appendChild(dialog);
    await dialog.updateComplete;

    appState.project.manifest = {
      ...createDefaultProjectManifest(),
      defaultExportScenePath: 'src/assets/scenes/intro.pix3scene',
      viewportBaseSize: { width: 1280, height: 720 },
    };

    await Promise.resolve();
    await dialog.updateComplete;

    expect((dialog as unknown as { defaultExportScenePath: string }).defaultExportScenePath).toBe(
      'src/assets/scenes/intro.pix3scene'
    );
    expect((dialog as unknown as { viewportBaseWidth: string }).viewportBaseWidth).toBe('1280');
    expect((dialog as unknown as { viewportBaseHeight: string }).viewportBaseHeight).toBe('720');
  });
});
