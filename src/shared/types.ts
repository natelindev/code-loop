export const PIPELINE_PHASES = [
  'CLONE',
  'SETUP',
  'PLAN',
  'IMPLEMENT',
  'REVIEW',
  'FIX',
  'COMMIT',
  'PUSH',
  'PR',
] as const;

export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

export type PhaseStatus = 'pending' | 'active' | 'completed' | 'skipped' | 'failed';

export type RunStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface LogEntry {
  timestamp: string;
  phase: string;
  message: string;
  raw: string;
}

export interface RunState {
  id: string;
  repoPath: string;
  repoName: string;
  prompt: string;
  branchName: string;
  status: RunStatus;
  currentPhase: string;
  phases: Record<string, PhaseStatus>;
  logs: LogEntry[];
  prUrl: string | null;
  startedAt: number;
  finishedAt: number | null;
  pid: number | null;
  skipPlan: boolean;
  background: boolean;
  modelOverrides: Partial<ModelConfig> | null;
  planText: string | null;
  runMode: 'foreground' | 'background';
  logFilePath: string | null;
  logFileOffset: number;
}

export interface RunOptions {
  repoPath: string;
  prompt: string;
  skipPlan: boolean;
  background?: boolean;
  planText?: string;
  modelOverrides?: Partial<ModelConfig>;
}

export interface ModelConfig {
  modelPlan: string;
  modelImplement: string;
  modelReview: string;
  modelFix: string;
  modelCommit: string;
  modelPr: string;
  modelBranch: string;
}

export interface AppConfig {
  workspaceRoot: string;
  models: ModelConfig;
  lastModelOverrides: Partial<ModelConfig>;
  postCloneCommands: string[];
  maxRetries: number;
  retryDelays: number[];
  notificationSound: boolean;
  autoApproveExternalDirectory: boolean;
  recentRepos: string[];
}

export interface RepoMeta {
  path: string;
  name: string;
  owner: string;
  nameWithOwner: string;
  remoteUrl: string;
  mainBranch: string;
}

// IPC channel names
export const IPC = {
  CONFIG_LOAD: 'config:load',
  CONFIG_SAVE: 'config:save',
  RUN_START: 'run:start',
  RUN_STOP: 'run:stop',
  RUN_LIST: 'run:list',
  RUN_GET: 'run:get',
  RUN_LOG: 'run:log',
  RUN_PHASE: 'run:phase',
  RUN_DONE: 'run:done',
  RUN_ERROR: 'run:error',
  RUN_STATUS: 'run:status',
  REPO_VALIDATE: 'repo:validate',
  REPO_META: 'repo:meta',
  REPO_PICK_FOLDER: 'repo:pick-folder',
  SHELL_OPEN_URL: 'shell:open-url',
  MODELS_LIST: 'models:list',
} as const;
