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

type ActiveRun = {
  state: RunState;
  process: ChildProcess | null;
  logPoller: NodeJS.Timeout | null;
  logLineBuffer: string;
};

const activeRuns = new Map<string, ActiveRun>();
const persistedRuns = new Map<string, RunState>();
const RUN_HISTORY_PATH = path.join(os.homedir(), '.opencode-loop-runs.json');
const MAX_LOGS_PER_RUN = 10000;
const BG_BOOTSTRAP_REGEX = /Running in background\. Log: (.+)\. PID: (\d+)$/;
const PLAN_FILE_REGEX = /Plan saved to (.+)$/;

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

function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readNewLogChunk(filePath: string, offset: number): { chunk: string; nextOffset: number } {
  if (!fs.existsSync(filePath)) {
    return { chunk: '', nextOffset: offset };
  }

  const stats = fs.statSync(filePath);
  if (stats.size <= offset) {
    return { chunk: '', nextOffset: stats.size };
  }

  const length = stats.size - offset;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, offset);
  } finally {
    fs.closeSync(fd);
  }

  return {
    chunk: buffer.toString('utf-8'),
    nextOffset: stats.size,
  };
}

function inferCompletedFromLogs(state: RunState): boolean {
  return state.logs.some((entry) => entry.phase.toUpperCase() === 'DONE' && entry.message.includes('Total duration:'));
}

function finalizeBackgroundRun(runId: string, state: RunState) {
  if (state.status !== 'running') return;

  state.finishedAt = Date.now();
  if (inferCompletedFromLogs(state)) {
    state.status = 'completed';
    for (const p of PIPELINE_PHASES) {
      if (state.phases[p] === 'active') state.phases[p] = 'completed';
    }
  } else {
    state.status = 'failed';
    for (const p of PIPELINE_PHASES) {
      if (state.phases[p] === 'active') state.phases[p] = 'failed';
    }
  }

  sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
  sendToRenderer(IPC.RUN_DONE, { runId, prUrl: state.prUrl, status: state.status });
  persistRunState(state);
}

function stopPolling(runId: string) {
  const active = activeRuns.get(runId);
  if (!active?.logPoller) return;
  clearInterval(active.logPoller);
  active.logPoller = null;
}

function startBackgroundLogPolling(runId: string, state: RunState) {
  const active = activeRuns.get(runId);
  if (!active || active.logPoller || !state.logFilePath) return;

  const poll = () => {
    const current = activeRuns.get(runId);
    if (!current) return;
    if (state.status !== 'running') {
      stopPolling(runId);
      return;
    }

    try {
      const { chunk, nextOffset } = readNewLogChunk(state.logFilePath!, state.logFileOffset);
      state.logFileOffset = nextOffset;

      if (chunk) {
        const combined = current.logLineBuffer + chunk;
        const lines = combined.split('\n');
        current.logLineBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const entry = parseLine(line);
          if (!entry) continue;
          if (entry.phase === 'INIT' && entry.message.startsWith('Target branch:')) {
            state.branchName = entry.message.replace('Target branch:', '').trim();
          }
          handleLogEntry(runId, entry, state);
        }
      }

      if (!isProcessAlive(state.pid)) {
        if (current.logLineBuffer.trim()) {
          const tailEntry = parseLine(current.logLineBuffer);
          if (tailEntry) handleLogEntry(runId, tailEntry, state);
          current.logLineBuffer = '';
        }
        stopPolling(runId);
        finalizeBackgroundRun(runId, state);
      }
    } catch {
      // Non-fatal: polling will retry in the next tick.
    }
  };

  active.logPoller = setInterval(poll, 1000);
  poll();
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

      loadedRun.runMode = loadedRun.runMode ?? 'foreground';
      loadedRun.background = loadedRun.background ?? loadedRun.runMode === 'background';
      loadedRun.modelOverrides = loadedRun.modelOverrides ?? null;
      loadedRun.planText = loadedRun.planText ?? null;
      loadedRun.logFilePath = loadedRun.logFilePath ?? null;
      loadedRun.logFileOffset = loadedRun.logFileOffset ?? 0;

      if (loadedRun.status === 'running') {
        if (loadedRun.runMode === 'background' && isProcessAlive(loadedRun.pid)) {
          activeRuns.set(loadedRun.id, {
            state: loadedRun,
            process: null,
            logPoller: null,
            logLineBuffer: '',
          });
          if (loadedRun.logFilePath) {
            startBackgroundLogPolling(loadedRun.id, loadedRun);
          }
        } else {
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
  if (entry.phase.toUpperCase() === 'PLAN') {
    const match = entry.message.match(PLAN_FILE_REGEX);
    if (match) {
      const planPath = match[1]?.trim();
      if (planPath && fs.existsSync(planPath)) {
        try {
          const planText = fs.readFileSync(planPath, 'utf-8').trim();
          if (planText) {
            state.planText = planText;
          }
        } catch {
          // Non-fatal: run can proceed without persisted plan text.
        }
      }
    }
  }

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
    OPENCODE_LOOP_AUTO_APPROVE_EXTERNAL_DIRECTORY: String(config.autoApproveExternalDirectory),
  };

  const runMode = options.background ? 'background' : 'foreground';

  // Build args
  const args = [
    runMode === 'background' ? '--bg' : '--fg',
    '--log-opencode',
    '--config',
    path.join(os.homedir(), '.opencode-loop.conf'),
    '--repo-dir',
    options.repoPath,
  ];

  if (options.skipPlan && options.planText) {
    env.OPENCODE_LOOP_PLAN_TEXT = options.planText;
    args.push('--skip-plan');
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
    background: !!options.background,
    modelOverrides: options.modelOverrides ?? null,
    planText: options.skipPlan ? options.planText?.trim() || null : null,
    runMode,
    logFilePath: null,
    logFileOffset: 0,
  };

  const child = spawn('bash', [scriptPath, ...args], {
    env,
    cwd: options.repoPath,
    detached: runMode === 'foreground',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  state.pid = child.pid ?? null;
  activeRuns.set(runId, { state, process: child, logPoller: null, logLineBuffer: '' });
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

      const bgBootstrap = line.match(BG_BOOTSTRAP_REGEX);
      if (bgBootstrap) {
        state.logFilePath = bgBootstrap[1].trim();
        state.pid = Number(bgBootstrap[2]);
        if (!Number.isFinite(state.pid) || state.pid <= 0) {
          state.pid = null;
        }
        persistRunState(state);
        sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
        startBackgroundLogPolling(runId, state);
        continue;
      }

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

    if (state.runMode === 'background') {
      if (code !== 0 && state.status === 'running') {
        state.status = 'failed';
        state.finishedAt = Date.now();
        sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
        sendToRenderer(IPC.RUN_DONE, { runId, prUrl: state.prUrl, status: state.status });
        persistRunState(state);
      }
      return;
    }

    state.finishedAt = Date.now();

    if (state.status === 'stopped') {
      // Already marked as stopped
    } else if (code === 0) {
      state.status = 'completed';
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
      for (const p of PIPELINE_PHASES) {
        if (state.phases[p] === 'active') state.phases[p] = 'failed';
      }
      showNotification('CodeLoop', `Run failed (exit code ${code})`);
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
  const persisted = persistedRuns.get(runId);
  if (!run && (!persisted || persisted.status !== 'running')) return false;

  const targetState = run?.state ?? persisted!;
  if (targetState.status !== 'running') return false;

  targetState.status = 'stopped';
  targetState.finishedAt = Date.now();
  sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...targetState } });
  persistRunState(targetState);

  stopPolling(runId);

  const pid = targetState.pid;

  try {
    if (pid) {
      process.kill(-pid, 'SIGTERM');
      setTimeout(() => {
        const current = activeRuns.get(runId);
        const currentState = current?.state ?? persistedRuns.get(runId);
        if (!currentState || currentState.status !== 'stopped') return;
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
        }
      }, 3000);
      if (run?.process) {
        run.process.kill('SIGTERM');
      } else {
        process.kill(pid, 'SIGTERM');
      }
    }
  } catch {
    if (run?.process) {
      try { run.process.kill('SIGKILL'); } catch { /* ignore */ }
    } else if (pid) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    }
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
