import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../lib/ipc';
import type { RunState, RunOptions, LogEntry } from '@shared/types';

export function useRuns() {
  const [runs, setRuns] = useState<RunState[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const logsRef = useRef<Map<string, LogEntry[]>>(new Map());

  // Load existing runs on mount
  useEffect(() => {
    api().listRuns().then(setRuns);
  }, []);

  // Subscribe to streaming events
  useEffect(() => {
    const unsubLog = api().onRunLog(({ runId, entry }) => {
      const logs = logsRef.current.get(runId) || [];
      logs.push(entry);
      logsRef.current.set(runId, logs);

      // Trigger re-render for the selected run
      setRuns((prev) =>
        prev.map((r) => (r.id === runId ? { ...r, logs: [...logs] } : r))
      );
    });

    const unsubPhase = api().onRunPhase(({ runId, currentPhase, phases }) => {
      setRuns((prev) =>
        prev.map((r) =>
          r.id === runId ? { ...r, currentPhase, phases: phases as RunState['phases'] } : r
        )
      );
    });

    const unsubStatus = api().onRunStatus(({ runId, state }) => {
      setRuns((prev) => {
        const existing = prev.find((r) => r.id === runId);
        if (existing) {
          return prev.map((r) =>
            r.id === runId ? { ...state, logs: logsRef.current.get(runId) || state.logs } : r
          );
        }
        logsRef.current.set(runId, state.logs || []);
        return [...prev, state];
      });
    });

    const unsubDone = api().onRunDone(({ runId, prUrl, status }) => {
      setRuns((prev) =>
        prev.map((r) =>
          r.id === runId
            ? { ...r, prUrl, status: status as RunState['status'], finishedAt: Date.now() }
            : r
        )
      );
    });

    const unsubError = api().onRunError(({ runId, error }) => {
      const entry: LogEntry = {
        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
        phase: 'ERROR',
        message: error,
        raw: `[ERROR] ${error}`,
      };
      const logs = logsRef.current.get(runId) || [];
      logs.push(entry);
      logsRef.current.set(runId, logs);

      setRuns((prev) =>
        prev.map((r) =>
          r.id === runId ? { ...r, status: 'failed' as const, logs: [...logs] } : r
        )
      );
    });

    return () => {
      unsubLog();
      unsubPhase();
      unsubStatus();
      unsubDone();
      unsubError();
    };
  }, []);

  const startRun = useCallback(async (options: RunOptions) => {
    const result = await api().startRun(options);
    if (result.ok && result.runId) {
      logsRef.current.set(result.runId, []);
      setSelectedRunId(result.runId);
    }
    return result;
  }, []);

  const stopRun = useCallback(async (runId: string) => {
    await api().stopRun(runId);
  }, []);

  const selectedRun = runs.find((r) => r.id === selectedRunId) || null;

  return {
    runs,
    selectedRun,
    selectedRunId,
    setSelectedRunId,
    startRun,
    stopRun,
  };
}
