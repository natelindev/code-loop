import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Anser from 'anser';
import { sendToRenderer, showNotification } from './index';
import { loadConfig, addRecentRepo, resolveScriptPath } from './config-manager';
import { shell } from 'electron';
import type {
  RunState,
  RunOptions,
  LogEntry,
  PhaseStatus,
  PipelinePhase,
} from '../shared/types';
import { PIPELINE_PHASES, IPC } from '../shared/types';

const activeRuns = new Map<string, { state: RunState; process: ChildProcess }>();
const persistedRuns = new Map<string, RunState>();
const RUN_HISTORY_PATH = path.join(os.homedir(), '.opencode-loop-runs.json');
const MAX_LOGS_PER_RUN = 10000;

let persistTimer: NodeJS.Timeout | null = null;

function persistRunsNow() {
  const runs = Array.from(persistedRuns.values()).sort((a, b) => a.startedAt - b.startedAt);
  fs.writeFileSync(RUN_HISTORY_PATH, JSON.stringify(runs), 'utf-8');
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      persistRunsNow();
    } catch {
      // Non-fatal: persistence should not break run execution.
    }
  }, 250);
}

function persistRunState(state: RunState) {
  persistedRuns.set(state.id, {
    ...state,
    phases: { ...state.phases },
    logs: [...state.logs],
  });
  schedulePersist();
}

function loadPersistedRuns() {
  if (!fs.existsSync(RUN_HISTORY_PATH)) return;
  let didMigrateRunningStatus = false;
  try {
    const raw = fs.readFileSync(RUN_HISTORY_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as RunState[];
    for (const run of parsed) {
      const loadedRun: RunState = {
        ...run,
        phases: { ...run.phases },
        logs: Array.isArray(run.logs) ? run.logs : [],
      };

      if (loadedRun.status === 'running') {
        didMigrateRunningStatus = true;
        loadedRun.status = 'stopped';
        loadedRun.finishedAt = loadedRun.finishedAt ?? Date.now();
        loadedRun.logs.push({
          timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
          phase: 'INIT',
          message: 'Run marked as stopped after app restart',
          raw: '[INIT] Run marked as stopped after app restart',
        });
      }

      persistedRuns.set(loadedRun.id, loadedRun);
    }
    if (didMigrateRunningStatus) {
      schedulePersist();
    }
  } catch {
    // Ignore malformed history and continue with empty history.
  }
}

loadPersistedRuns();

function createInitialPhases(skipPlan: boolean): Record<string, PhaseStatus> {
  const phases: Record<string, PhaseStatus> = {};
  for (const phase of PIPELINE_PHASES) {
    if (phase === 'PLAN' && skipPlan) {
      phases[phase] = 'skipped';
    } else {
      phases[phase] = 'pending';
    }
  }
  return phases;
}

const LOG_LINE_REGEX = /^\[(.+?)\] \[(.+?)\] (.*)$/;
const PR_URL_REGEX = /PR created:\s*(https:\/\/\S+)/;

function parseLine(raw: string): LogEntry | null {
  // Strip ANSI codes
  const clean = Anser.ansiToText(raw);
  const match = clean.match(LOG_LINE_REGEX);
  if (match) {
    return {
      timestamp: match[1],
      phase: match[2],
      message: match[3],
      raw: clean,
    };
  }
  // Non-structured line
  if (clean.trim()) {
    return {
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
      phase: 'OUTPUT',
      message: clean.trim(),
      raw: clean,
    };
  }
  return null;
}

function updatePhaseStatus(state: RunState, phase: string) {
  const phaseUpper = phase.toUpperCase() as PipelinePhase;
  if (!PIPELINE_PHASES.includes(phaseUpper)) return;

  // Mark current active phase as completed if switching to a new one
  for (const p of PIPELINE_PHASES) {
    if (state.phases[p] === 'active' && p !== phaseUpper) {
      state.phases[p] = 'completed';
    }
  }

  if (state.phases[phaseUpper] !== 'skipped') {
    state.phases[phaseUpper] = 'active';
  }
  state.currentPhase = phaseUpper;
}

function markPhaseCompleted(state: RunState, phase: string) {
  const phaseUpper = phase.toUpperCase() as PipelinePhase;
  if (PIPELINE_PHASES.includes(phaseUpper) && state.phases[phaseUpper] === 'active') {
    state.phases[phaseUpper] = 'completed';
  }
}

function handleLogEntry(runId: string, entry: LogEntry, state: RunState) {
  state.logs.push(entry);
  if (state.logs.length > MAX_LOGS_PER_RUN) {
    state.logs.splice(0, state.logs.length - MAX_LOGS_PER_RUN);
  }

  // Detect phase transitions
  const phase = entry.phase.toUpperCase();

  if (phase === 'DONE') {
    // Mark all active phases as completed
    for (const p of PIPELINE_PHASES) {
      if (state.phases[p] === 'active') state.phases[p] = 'completed';
    }

    // Check for PR URL
    const prMatch = entry.message.match(PR_URL_REGEX);
    if (prMatch) {
      state.prUrl = prMatch[1];
    }
  } else if (phase === 'FIX') {
    if (entry.message.includes('Skipped')) {
      state.phases['FIX'] = 'skipped';
    } else {
      updatePhaseStatus(state, phase);
    }
  } else if (phase === 'PLAN' && entry.message.includes('Skipped')) {
    state.phases['PLAN'] = 'skipped';
  } else if (PIPELINE_PHASES.includes(phase as PipelinePhase)) {
    if (entry.message.match(/^Completed in \d+s/)) {
      markPhaseCompleted(state, phase);
    } else {
      updatePhaseStatus(state, phase);
    }
  }

  sendToRenderer(IPC.RUN_LOG, { runId, entry });
  sendToRenderer(IPC.RUN_PHASE, {
    runId,
    currentPhase: state.currentPhase,
    phases: { ...state.phases },
  });
  persistRunState(state);
}

export function startRun(options: RunOptions): string {
  const runId = uuidv4();
  const config = loadConfig();

  // Add to recent repos
  addRecentRepo(config, options.repoPath);

  const scriptPath = resolveScriptPath();
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Script not found: ${scriptPath}`);
  }

  // Build environment overrides
  const mergedModels = { ...config.models, ...options.modelOverrides };
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    OPENCODE_LOOP_WORKSPACE_ROOT: config.workspaceRoot,
    OPENCODE_LOOP_MODEL_PLAN: mergedModels.modelPlan,
    OPENCODE_LOOP_MODEL_IMPLEMENT: mergedModels.modelImplement,
    OPENCODE_LOOP_MODEL_REVIEW: mergedModels.modelReview,
    OPENCODE_LOOP_MODEL_FIX: mergedModels.modelFix,
    OPENCODE_LOOP_MODEL_COMMIT: mergedModels.modelCommit,
    OPENCODE_LOOP_MODEL_PR: mergedModels.modelPr,
    OPENCODE_LOOP_MODEL_BRANCH: mergedModels.modelBranch,
    OPENCODE_LOOP_MAX_RETRIES: String(config.maxRetries),
    OPENCODE_LOOP_NOTIFICATION_SOUND: String(config.notificationSound),
  };

  // Build args — always foreground, the app manages concurrency
  const args = [
    '--fg',
    '--log-opencode',
    '--config',
    path.join(os.homedir(), '.opencode-loop.conf'),
    '--repo-dir',
    options.repoPath,
  ];

  // Handle skip plan
  let planTempFile: string | null = null;
  if (options.skipPlan && options.planText) {
    planTempFile = path.join(os.tmpdir(), `opencode-plan-${runId}.md`);
    fs.writeFileSync(planTempFile, options.planText, 'utf-8');
    args.push('--plan-file', planTempFile);
  }

  // Add the prompt
  args.push(options.prompt);

  const repoName = options.repoPath.split('/').pop() || 'repo';

  const state: RunState = {
    id: runId,
    repoPath: options.repoPath,
    repoName,
    prompt: options.prompt,
    branchName: '',
    status: 'running',
    currentPhase: 'INIT',
    phases: createInitialPhases(options.skipPlan),
    logs: [],
    prUrl: null,
    startedAt: Date.now(),
    finishedAt: null,
    pid: null,
    skipPlan: options.skipPlan,
  };

  const child = spawn('bash', [scriptPath, ...args], {
    env,
    cwd: options.repoPath,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  state.pid = child.pid ?? null;
  activeRuns.set(runId, { state, process: child });
  persistRunState(state);

  // Send initial state
  sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });

  let stdoutBuffer = '';
  let stderrBuffer = '';

  child.stdout?.on('data', (data: Buffer) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = parseLine(line);
      if (entry) {
        // Detect branch name
        if (entry.phase === 'INIT' && entry.message.startsWith('Target branch:')) {
          state.branchName = entry.message.replace('Target branch:', '').trim();
        }
        handleLogEntry(runId, entry, state);
      }
    }
  });

  child.stderr?.on('data', (data: Buffer) => {
    stderrBuffer += data.toString();
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = parseLine(line);
      if (entry) {
        handleLogEntry(runId, entry, state);
      }
    }
  });

  child.on('close', (code) => {
    // Flush remaining buffers
    if (stdoutBuffer.trim()) {
      const entry = parseLine(stdoutBuffer);
      if (entry) handleLogEntry(runId, entry, state);
    }
    if (stderrBuffer.trim()) {
      const entry = parseLine(stderrBuffer);
      if (entry) handleLogEntry(runId, entry, state);
    }

    state.finishedAt = Date.now();

    if (state.status === 'stopped') {
      // Already marked as stopped
    } else if (code === 0) {
      state.status = 'completed';
      // Mark remaining active phases as completed
      for (const p of PIPELINE_PHASES) {
        if (state.phases[p] === 'active') state.phases[p] = 'completed';
      }

      showNotification(
        'CodeLoop',
        state.prUrl ? `PR ready: ${state.prUrl}` : 'Run completed successfully',
        () => {
          if (state.prUrl) shell.openExternal(state.prUrl);
        }
      );
    } else {
      state.status = 'failed';
      // Mark active phases as failed
      for (const p of PIPELINE_PHASES) {
        if (state.phases[p] === 'active') state.phases[p] = 'failed';
      }
      showNotification('CodeLoop', `Run failed (exit code ${code})`);
    }

    // Clean up temp plan file
    if (planTempFile && fs.existsSync(planTempFile)) {
      try { fs.unlinkSync(planTempFile); } catch { /* ignore */ }
    }

    sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
    sendToRenderer(IPC.RUN_DONE, { runId, prUrl: state.prUrl, status: state.status });
    persistRunState(state);
  });

  child.on('error', (err) => {
    state.status = 'failed';
    state.finishedAt = Date.now();
    sendToRenderer(IPC.RUN_ERROR, { runId, error: err.message });
    sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
    persistRunState(state);
  });

  return runId;
}

export function stopRun(runId: string): boolean {
  const run = activeRuns.get(runId);
  if (!run || run.state.status !== 'running') return false;

  run.state.status = 'stopped';
  run.state.finishedAt = Date.now();
  sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...run.state } });
  persistRunState(run.state);

  try {
    // Kill process group first so child/sub-processes are terminated together.
    if (run.process.pid) {
      process.kill(-run.process.pid, 'SIGTERM');
      setTimeout(() => {
        const current = activeRuns.get(runId);
        if (!current || current.state.status !== 'stopped') return;
        try {
          process.kill(-run.process.pid!, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }, 3000);
    }
    run.process.kill('SIGTERM');
  } catch {
    try { run.process.kill('SIGKILL'); } catch { /* ignore */ }
  }
  return true;
}

export function getRunState(runId: string): RunState | null {
  const active = activeRuns.get(runId)?.state;
  if (active) return active;
  return persistedRuns.get(runId) ?? null;
}

export function listRuns(): RunState[] {
  return Array.from(persistedRuns.values()).map((state) => ({
    ...state,
    phases: { ...state.phases },
    logs: [...state.logs],
  }));
}
