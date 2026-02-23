import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/types';
import type {
  AppConfig,
  RunOptions,
  RunState,
  LogEntry,
  RepoMeta,
  LaunchRequirements,
  RunPrActionResult,
} from '@shared/types';

const api = {
  // Config
  loadConfig: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.CONFIG_LOAD),
  saveConfig: (config: AppConfig): Promise<boolean> => ipcRenderer.invoke(IPC.CONFIG_SAVE, config),

  // Runs
  startRun: (options: RunOptions): Promise<{ ok: boolean; runId?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.RUN_START, options),
  stopRun: (runId: string): Promise<boolean> => ipcRenderer.invoke(IPC.RUN_STOP, runId),
  listRuns: (): Promise<RunState[]> => ipcRenderer.invoke(IPC.RUN_LIST),
  getRun: (runId: string): Promise<RunState | null> => ipcRenderer.invoke(IPC.RUN_GET, runId),
  refreshRunPrStatus: (runId: string): Promise<RunPrActionResult> => ipcRenderer.invoke(IPC.RUN_PR_REFRESH, runId),
  mergeRunPr: (runId: string): Promise<RunPrActionResult> => ipcRenderer.invoke(IPC.RUN_PR_MERGE, runId),
  resolveAndMergeRunPr: (runId: string): Promise<RunPrActionResult> =>
    ipcRenderer.invoke(IPC.RUN_PR_RESOLVE_MERGE, runId),

  // Run events (streaming)
  onRunLog: (callback: (data: { runId: string; entry: LogEntry }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { runId: string; entry: LogEntry }) => callback(data);
    ipcRenderer.on(IPC.RUN_LOG, handler);
    return () => ipcRenderer.removeListener(IPC.RUN_LOG, handler);
  },
  onRunPhase: (
    callback: (data: { runId: string; currentPhase: string; phases: Record<string, string> }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { runId: string; currentPhase: string; phases: Record<string, string> }
    ) => callback(data);
    ipcRenderer.on(IPC.RUN_PHASE, handler);
    return () => ipcRenderer.removeListener(IPC.RUN_PHASE, handler);
  },
  onRunDone: (callback: (data: { runId: string; prUrl: string | null; status: string; finishedAt?: number }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { runId: string; prUrl: string | null; status: string; finishedAt?: number }
    ) => callback(data);
    ipcRenderer.on(IPC.RUN_DONE, handler);
    return () => ipcRenderer.removeListener(IPC.RUN_DONE, handler);
  },
  onRunError: (callback: (data: { runId: string; error: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { runId: string; error: string }) => callback(data);
    ipcRenderer.on(IPC.RUN_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC.RUN_ERROR, handler);
  },
  onRunStatus: (callback: (data: { runId: string; state: RunState }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { runId: string; state: RunState }) => callback(data);
    ipcRenderer.on(IPC.RUN_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC.RUN_STATUS, handler);
  },

  // Repo
  validateRepo: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.REPO_VALIDATE, path),
  getRepoMeta: (path: string): Promise<RepoMeta | null> => ipcRenderer.invoke(IPC.REPO_META, path),
  pickFolder: (): Promise<{ path: string; meta: RepoMeta | null } | { error: string } | null> =>
    ipcRenderer.invoke(IPC.REPO_PICK_FOLDER),

  // Shell
  openUrl: (url: string): Promise<void> => ipcRenderer.invoke(IPC.SHELL_OPEN_URL, url),

  // Models
  listModels: (): Promise<string[]> => ipcRenderer.invoke(IPC.MODELS_LIST),

  // Startup checks
  checkLaunchRequirements: (): Promise<LaunchRequirements> => ipcRenderer.invoke(IPC.APP_LAUNCH_REQUIREMENTS),
};

export type ElectronAPI = typeof api;

contextBridge.exposeInMainWorld('electronAPI', api);
