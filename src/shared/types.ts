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
export type PrMergeStatus =
  | 'none'
  | 'checking'
  | 'ready'
  | 'conflict'
  | 'auto-merging'
  | 'merged'
  | 'failed';

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
  prTitle: string | null;
  prNumber: number | null;
  prHeadRef: string | null;
  prBaseRef: string | null;
  prMergeStatus: PrMergeStatus;
  prMergeMessage: string | null;
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
  autoMerge: boolean;
  skipPr: boolean;
}

export interface RunOptions {
  repoPath: string;
  prompt: string;
  skipPlan: boolean;
  background?: boolean;
  planText?: string;
  modelOverrides?: Partial<ModelConfig>;
  autoMerge?: boolean;
  skipPr?: boolean;
}

export interface PrStatusPayload {
  runId: string;
  prUrl: string | null;
  prTitle: string | null;
  prNumber: number | null;
  prHeadRef: string | null;
  prBaseRef: string | null;
  prMergeStatus: PrMergeStatus;
  prMergeMessage: string | null;
}

export interface RunPrActionResult {
  ok: boolean;
  error?: string;
  payload?: PrStatusPayload;
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
  launchChecksPassed: boolean;
  recentRepos: string[];
  branchPrefix: string;
  skipPr: boolean;
}

export interface RepoMeta {
  path: string;
  name: string;
  owner: string;
  nameWithOwner: string;
  remoteUrl: string;
  mainBranch: string;
}

export interface ToolReadiness {
  installed: boolean;
  authenticated: boolean;
  hint: string;
  details: string | null;
}

export interface LaunchRequirements {
  ready: boolean;
  checkedAt: number;
  opencode: ToolReadiness;
  gh: ToolReadiness;
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
  RUN_PR_REFRESH: 'run:pr:refresh',
  RUN_PR_MERGE: 'run:pr:merge',
  RUN_PR_RESOLVE_MERGE: 'run:pr:resolve-merge',
  REPO_VALIDATE: 'repo:validate',
  REPO_META: 'repo:meta',
  REPO_PICK_FOLDER: 'repo:pick-folder',
  SHELL_OPEN_URL: 'shell:open-url',
  SHELL_OPEN_IN_VSCODE: 'shell:open-in-vscode',
  MODELS_LIST: 'models:list',
  APP_LAUNCH_REQUIREMENTS: 'app:launch-requirements',
} as const;
