import { spawn, ChildProcess, execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Anser from 'anser';
import { promisify } from 'util';
import { sendToRenderer, showNotification } from './index';
import { loadConfig, addRecentRepo, resolveScriptPath } from './config-manager';
import { shell } from 'electron';
import type {
  RunState,
  RunOptions,
  LogEntry,
  PhaseStatus,
  PipelinePhase,
  PrStatusPayload,
  RunPrActionResult,
} from '../shared/types';
import { PIPELINE_PHASES, IPC } from '../shared/types';

const execFileAsync = promisify(execFile);

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
  sendToRenderer(IPC.RUN_DONE, { runId, prUrl: state.prUrl, status: state.status, finishedAt: state.finishedAt });
  persistRunState(state);

  if (state.status === 'completed' && state.prUrl) {
    void maybeAutoMergeRun(runId, state);
  }
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
      loadedRun.autoMerge = loadedRun.autoMerge ?? false;
      loadedRun.skipPr = loadedRun.skipPr ?? false;
      loadedRun.prTitle = loadedRun.prTitle ?? null;
      loadedRun.prNumber = loadedRun.prNumber ?? null;
      loadedRun.prHeadRef = loadedRun.prHeadRef ?? null;
      loadedRun.prBaseRef = loadedRun.prBaseRef ?? null;
      loadedRun.prMergeStatus = loadedRun.prMergeStatus ?? (loadedRun.prUrl ? 'checking' : 'none');
      loadedRun.prMergeMessage = loadedRun.prMergeMessage ?? null;

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

function createInitialPhases(skipPlan: boolean, skipPr: boolean): Record<string, PhaseStatus> {
  const phases: Record<string, PhaseStatus> = {};
  for (const phase of PIPELINE_PHASES) {
    if (phase === 'PLAN' && skipPlan) {
      phases[phase] = 'skipped';
    } else if ((phase === 'PR' || phase === 'PUSH') && skipPr) {
      phases[phase] = 'skipped';
    } else {
      phases[phase] = 'pending';
    }
  }
  return phases;
}

const LOG_LINE_REGEX = /^\[(.+?)\] \[(.+?)\] (.*)$/;
const PR_URL_REGEX = /PR created:\s*(https:\/\/\S+)/;

type GhPrView = {
  url: string;
  title: string;
  number: number;
  state: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | string;
  headRefName: string;
  baseRefName: string;
};

function toPrPayload(runId: string, state: RunState): PrStatusPayload {
  return {
    runId,
    prUrl: state.prUrl,
    prTitle: state.prTitle,
    prNumber: state.prNumber,
    prHeadRef: state.prHeadRef,
    prBaseRef: state.prBaseRef,
    prMergeStatus: state.prMergeStatus,
    prMergeMessage: state.prMergeMessage,
  };
}

function parseRepoFromPrUrl(prUrl: string): string | null {
  const match = prUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i);
  if (!match) return null;
  return match[1];
}

function updatePrState(state: RunState, partial: Partial<RunState>) {
  Object.assign(state, partial);
}

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
      state.prMergeStatus = 'checking';
      state.prMergeMessage = 'Pull request created. Checking merge status...';
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

async function fetchPrView(state: RunState): Promise<GhPrView> {
  if (!state.prUrl) {
    throw new Error('No pull request URL available for this run.');
  }

  const { stdout } = await execFileAsync(
    'gh',
    [
      'pr',
      'view',
      state.prUrl,
      '--json',
      'url,title,number,state,mergeable,headRefName,baseRefName',
    ],
    { cwd: state.repoPath, timeout: 30000 }
  );

  return JSON.parse(stdout) as GhPrView;
}

function applyPrView(state: RunState, view: GhPrView) {
  const mergeStatus =
    view.state === 'MERGED'
      ? 'merged'
      : view.mergeable === 'CONFLICTING'
        ? 'conflict'
        : view.mergeable === 'MERGEABLE'
          ? 'ready'
          : 'checking';

  const mergeMessage =
    view.state === 'MERGED'
      ? 'Pull request has been merged.'
      : view.mergeable === 'CONFLICTING'
        ? 'Pull request has merge conflicts.'
        : view.mergeable === 'MERGEABLE'
          ? 'Pull request is mergeable.'
          : 'Mergeability is still being calculated by GitHub.';

  updatePrState(state, {
    prUrl: view.url || state.prUrl,
    prTitle: view.title || state.prTitle,
    prNumber: Number.isFinite(view.number) ? view.number : state.prNumber,
    prHeadRef: view.headRefName || state.prHeadRef,
    prBaseRef: view.baseRefName || state.prBaseRef,
    prMergeStatus: mergeStatus,
    prMergeMessage: mergeMessage,
  });
}

function getRunById(runId: string): RunState | null {
  const active = activeRuns.get(runId)?.state;
  if (active) return active;
  return persistedRuns.get(runId) ?? null;
}

export async function refreshRunPrStatus(runId: string): Promise<RunPrActionResult> {
  const state = getRunById(runId);
  if (!state) return { ok: false, error: 'Run not found.' };
  if (!state.prUrl) return { ok: false, error: 'No pull request exists for this run yet.' };

  updatePrState(state, {
    prMergeStatus: 'checking',
    prMergeMessage: 'Checking pull request status...',
  });
  sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
  persistRunState(state);

  try {
    const view = await fetchPrView(state);
    applyPrView(state, view);
    sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
    persistRunState(state);
    return { ok: true, payload: toPrPayload(runId, state) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updatePrState(state, {
      prMergeStatus: 'failed',
      prMergeMessage: `Failed to refresh PR status: ${message}`,
    });
    sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
    persistRunState(state);
    return { ok: false, error: message, payload: toPrPayload(runId, state) };
  }
}

async function executeMerge(state: RunState, runId: string): Promise<RunPrActionResult> {
  if (!state.prUrl) return { ok: false, error: 'No pull request exists for this run yet.' };

  updatePrState(state, {
    prMergeStatus: 'auto-merging',
    prMergeMessage: 'Submitting merge request...',
  });
  sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
  persistRunState(state);

  try {
    await execFileAsync(
      'gh',
      ['pr', 'merge', state.prUrl, '--auto', '--merge', '--delete-branch'],
      { cwd: state.repoPath, timeout: 60000 }
    );

    const refreshed = await refreshRunPrStatus(runId);
    if (!refreshed.ok) {
      updatePrState(state, {
        prMergeStatus: 'auto-merging',
        prMergeMessage: 'Auto-merge enabled. Waiting for checks and merge.',
      });
      sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
      persistRunState(state);
      return { ok: true, payload: toPrPayload(runId, state) };
    }

    if (state.prMergeStatus !== 'merged') {
      updatePrState(state, {
        prMergeStatus: 'auto-merging',
        prMergeMessage: 'Auto-merge enabled. Waiting for checks and merge.',
      });
      sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
      persistRunState(state);
    }

    return { ok: true, payload: toPrPayload(runId, state) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updatePrState(state, {
      prMergeStatus: 'failed',
      prMergeMessage: `Failed to merge PR: ${message}`,
    });
    sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
    persistRunState(state);
    return { ok: false, error: message, payload: toPrPayload(runId, state) };
  }
}

export async function mergeRunPr(runId: string): Promise<RunPrActionResult> {
  const state = getRunById(runId);
  if (!state) return { ok: false, error: 'Run not found.' };
  if (!state.prUrl) return { ok: false, error: 'No pull request exists for this run yet.' };

  await refreshRunPrStatus(runId);
  if (state.prMergeStatus === 'conflict') {
    return {
      ok: false,
      error: 'Pull request has merge conflicts. Use Resolve & Merge.',
      payload: toPrPayload(runId, state),
    };
  }

  return executeMerge(state, runId);
}

async function resolvePrConflictsInTempClone(state: RunState): Promise<void> {
  if (!state.prUrl) throw new Error('No pull request URL available.');
  if (!state.prHeadRef || !state.prBaseRef) {
    throw new Error('PR branch metadata is unavailable. Refresh PR status first.');
  }

  const config = loadConfig();
  const conflictModel = config.models.modelFix || config.models.modelReview;

  const repo = parseRepoFromPrUrl(state.prUrl);
  if (!repo) throw new Error('Could not determine repository from PR URL.');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-loop-merge-'));
  const cloneDir = path.join(tempRoot, 'repo');

  try {
    await execFileAsync('gh', ['repo', 'clone', repo, cloneDir], {
      cwd: state.repoPath,
      timeout: 120000,
    });
    await execFileAsync('git', ['-C', cloneDir, 'config', 'user.name', 'CodeLoop'], { timeout: 15000 });
    await execFileAsync('git', ['-C', cloneDir, 'config', 'user.email', 'codeloop@local'], { timeout: 15000 });
    await execFileAsync('git', ['-C', cloneDir, 'fetch', 'origin', state.prBaseRef, state.prHeadRef], { timeout: 30000 });
    await execFileAsync('git', ['-C', cloneDir, 'checkout', state.prHeadRef], { timeout: 30000 });

    try {
      await execFileAsync('git', ['-C', cloneDir, 'merge', '--no-edit', `origin/${state.prBaseRef}`], {
        timeout: 60000,
      });
    } catch {
      // Expected when merge conflicts are present; conflicts are resolved in the next step.
    }

    const { stdout: conflictStdout } = await execFileAsync(
      'git',
      ['-C', cloneDir, 'diff', '--name-only', '--diff-filter=U'],
      { timeout: 15000 }
    );
    const conflictedFiles = conflictStdout
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);

    if (conflictedFiles.length > 0) {
      const resolvePrompt = [
        'Resolve all current git merge conflicts in this repository.',
        'Requirements:',
        '- Preserve the intent of the PR branch while safely incorporating upstream changes.',
        '- Remove all conflict markers.',
        '- Keep code compiling and coherent.',
        '',
        'Conflicted files:',
        ...conflictedFiles.map((file) => `- ${file}`),
      ].join('\n');

      await execFileAsync('opencode', ['run', '-m', conflictModel, '--', resolvePrompt], {
        cwd: cloneDir,
        timeout: 240000,
      });
    }

    const { stdout: remainingConflictsStdout } = await execFileAsync(
      'git',
      ['-C', cloneDir, 'diff', '--name-only', '--diff-filter=U'],
      { timeout: 15000 }
    );
    const remainingConflicts = remainingConflictsStdout
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);

    if (remainingConflicts.length > 0) {
      throw new Error(`Conflicts remain unresolved: ${remainingConflicts.join(', ')}`);
    }

    await execFileAsync('git', ['-C', cloneDir, 'add', '-A'], { timeout: 15000 });

    const conflictCommitMessage = state.prNumber
      ? `fix: resolve merge conflicts for #${state.prNumber}`
      : 'fix: resolve merge conflicts';

    try {
      await execFileAsync(
        'git',
        ['-C', cloneDir, 'commit', '-m', conflictCommitMessage],
        { timeout: 30000 }
      );
    } catch {
      // If merge resolved without requiring a new commit, continue.
    }

    await execFileAsync('git', ['-C', cloneDir, 'push', 'origin', `HEAD:${state.prHeadRef}`], { timeout: 60000 });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function resolveAndMergeRunPr(runId: string): Promise<RunPrActionResult> {
  const state = getRunById(runId);
  if (!state) return { ok: false, error: 'Run not found.' };
  if (!state.prUrl) return { ok: false, error: 'No pull request exists for this run yet.' };

  const refreshed = await refreshRunPrStatus(runId);
  if (!refreshed.ok && state.prMergeStatus === 'failed') {
    return refreshed;
  }

  if (state.prMergeStatus !== 'conflict') {
    return executeMerge(state, runId);
  }

  updatePrState(state, {
    prMergeStatus: 'checking',
    prMergeMessage: 'Resolving conflicts with AI and preparing merge...',
  });
  sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
  persistRunState(state);

  try {
    await resolvePrConflictsInTempClone(state);
    await refreshRunPrStatus(runId);
    if (state.prMergeStatus === 'conflict') {
      throw new Error('Conflicts remain after auto-resolution attempt.');
    }
    return executeMerge(state, runId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updatePrState(state, {
      prMergeStatus: 'failed',
      prMergeMessage: `Resolve & merge failed: ${message}`,
    });
    sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
    persistRunState(state);
    return { ok: false, error: message, payload: toPrPayload(runId, state) };
  }
}

async function maybeAutoMergeRun(runId: string, state: RunState) {
  if (!state.autoMerge || !state.prUrl || state.status !== 'completed') return;

  const refreshed = await refreshRunPrStatus(runId);
  if (!refreshed.ok && state.prMergeStatus === 'failed') return;

  if (state.prMergeStatus === 'conflict') {
    updatePrState(state, {
      prMergeMessage: 'Auto-merge skipped because this PR has merge conflicts. Use Resolve & Merge.',
    });
    sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
    persistRunState(state);
    return;
  }

  if (state.prMergeStatus === 'ready' || state.prMergeStatus === 'checking') {
    await executeMerge(state, runId);
  }
}

export function startRun(options: RunOptions): string {
  const runId = uuidv4();
  const config = loadConfig();
  const prompt = options.prompt?.trim() ?? '';
  const planText = options.planText?.trim() ?? '';

  if (options.skipPlan && !planText) {
    throw new Error('Plan text is required when skipping the plan phase');
  }

  if (!options.skipPlan && !prompt) {
    throw new Error('Prompt is required');
  }

  const executionPrompt = prompt || 'Use the provided implementation plan.';

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
    OPENCODE_LOOP_BRANCH_PREFIX: config.branchPrefix || 'codeloop',
    OPENCODE_LOOP_SKIP_PR: String(options.skipPr ?? config.skipPr ?? false),
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

  if (options.skipPlan && planText) {
    env.OPENCODE_LOOP_PLAN_TEXT = planText;
    args.push('--skip-plan');
  }

  if (options.skipPr) {
    args.push('--skip-pr');
  }

  // Add the prompt
  args.push(executionPrompt);

  const repoName = options.repoPath.split('/').pop() || 'repo';

  const state: RunState = {
    id: runId,
    repoPath: options.repoPath,
    repoName,
    prompt,
    branchName: '',
    status: 'running',
    currentPhase: 'INIT',
    phases: createInitialPhases(options.skipPlan, !!options.skipPr),
    logs: [],
    prUrl: null,
    prTitle: null,
    prNumber: null,
    prHeadRef: null,
    prBaseRef: null,
    prMergeStatus: 'none',
    prMergeMessage: null,
    startedAt: Date.now(),
    finishedAt: null,
    pid: null,
    skipPlan: options.skipPlan,
    background: !!options.background,
    modelOverrides: options.modelOverrides ?? null,
    planText: options.skipPlan ? planText || null : null,
    runMode,
    logFilePath: null,
    logFileOffset: 0,
    autoMerge: !!options.autoMerge,
    skipPr: !!options.skipPr,
  };

  const child = spawn('bash', [scriptPath, ...args], {
    env,
    cwd: options.repoPath,
    detached: runMode === 'foreground',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  state.pid = child.pid ?? null;
  activeRuns.set(runId, { state, process: child, logPoller: null, logLineBuffer: '' });

  // Add to recent repos once run has been successfully created.
  addRecentRepo(config, options.repoPath);

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
      if (code === 0 && state.status === 'running' && !state.logFilePath) {
        state.status = 'failed';
        state.finishedAt = Date.now();
        state.prMergeStatus = state.prUrl ? 'checking' : 'none';
        state.prMergeMessage = 'Background run exited before streaming started.';
        sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
        sendToRenderer(IPC.RUN_DONE, { runId, prUrl: state.prUrl, status: state.status, finishedAt: state.finishedAt });
        persistRunState(state);
      }
      if (code !== 0 && state.status === 'running') {
        state.status = 'failed';
        state.finishedAt = Date.now();
        sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
        sendToRenderer(IPC.RUN_DONE, { runId, prUrl: state.prUrl, status: state.status, finishedAt: state.finishedAt });
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
    sendToRenderer(IPC.RUN_DONE, { runId, prUrl: state.prUrl, status: state.status, finishedAt: state.finishedAt });
    persistRunState(state);

    if (state.status === 'completed' && state.prUrl) {
      void maybeAutoMergeRun(runId, state);
    }
  });

  child.on('error', (err) => {
    state.status = 'failed';
    state.finishedAt = Date.now();
    sendToRenderer(IPC.RUN_ERROR, { runId, error: err.message });
    sendToRenderer(IPC.RUN_STATUS, { runId, state: { ...state } });
    sendToRenderer(IPC.RUN_DONE, { runId, prUrl: state.prUrl, status: state.status, finishedAt: state.finishedAt });
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
  sendToRenderer(IPC.RUN_DONE, { runId, prUrl: targetState.prUrl, status: targetState.status, finishedAt: targetState.finishedAt });
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

/**
 * Kill all child processes, clear all pollers/timers, and persist final state.
 * Called during app shutdown to ensure a clean exit.
 */
export function cleanupAllRuns() {
  // Clear the persist timer
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }

  for (const [runId, run] of activeRuns) {
    // Stop log polling
    if (run.logPoller) {
      clearInterval(run.logPoller);
      run.logPoller = null;
    }

    // Kill the child process
    if (run.process) {
      try { run.process.kill('SIGTERM'); } catch { /* already dead */ }
      try { run.process.kill('SIGKILL'); } catch { /* already dead */ }
    }

    // Also kill by PID (covers detached / background processes)
    const pid = run.state.pid;
    if (pid && pid > 0) {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* ignore */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    }

    // Mark running runs as stopped
    if (run.state.status === 'running') {
      run.state.status = 'stopped';
      run.state.finishedAt = Date.now();
      persistedRuns.set(runId, { ...run.state, phases: { ...run.state.phases }, logs: [...run.state.logs] });
    }
  }

  activeRuns.clear();

  // Persist synchronously so data isn't lost
  try {
    persistRunsNow();
  } catch { /* non-fatal */ }
}
