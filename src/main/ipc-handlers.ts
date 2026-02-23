import { ipcMain, dialog, shell } from 'electron';
import { loadConfig, saveConfig } from './config-manager';
import { startRun, stopRun, getRunState, listRuns } from './script-runner';
import { validateRepo, getRepoMeta, listSupportedModels } from './repo-scanner';
import { getMainWindow } from './index';
import { IPC } from '../shared/types';
import type { AppConfig, RunOptions } from '../shared/types';

export function registerIpcHandlers() {
  // Config
  ipcMain.handle(IPC.CONFIG_LOAD, () => {
    return loadConfig();
  });

  ipcMain.handle(IPC.CONFIG_SAVE, (_event, config: AppConfig) => {
    saveConfig(config);
    return true;
  });

  // Runs
  ipcMain.handle(IPC.RUN_START, (_event, options: RunOptions) => {
    try {
      const runId = startRun(options);
      return { ok: true, runId };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle(IPC.RUN_STOP, (_event, runId: string) => {
    return stopRun(runId);
  });

  ipcMain.handle(IPC.RUN_LIST, () => {
    return listRuns();
  });

  ipcMain.handle(IPC.RUN_GET, (_event, runId: string) => {
    return getRunState(runId);
  });

  // Repo
  ipcMain.handle(IPC.REPO_VALIDATE, async (_event, repoPath: string) => {
    return validateRepo(repoPath);
  });

  ipcMain.handle(IPC.REPO_META, async (_event, repoPath: string) => {
    return getRepoMeta(repoPath);
  });

  ipcMain.handle(IPC.REPO_PICK_FOLDER, async () => {
    const win = getMainWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select Git Repository',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const repoPath = result.filePaths[0];
    const isValid = await validateRepo(repoPath);
    if (!isValid) return { error: 'Not a git repository' };
    const meta = await getRepoMeta(repoPath);
    return { path: repoPath, meta };
  });

  // Shell
  ipcMain.handle(IPC.SHELL_OPEN_URL, (_event, url: string) => {
    return shell.openExternal(url);
  });

  // Models
  ipcMain.handle(IPC.MODELS_LIST, async () => {
    return listSupportedModels();
  });
}
