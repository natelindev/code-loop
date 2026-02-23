import { useState, useEffect } from 'react';
import PhaseTracker from './PhaseTracker';
import LogViewer from './LogViewer';
import api from '../lib/ipc';
import type { RunState, RunOptions } from '@shared/types';
import { Button } from '@shared/components/ui/button';
import { Badge } from '@shared/components/ui/badge';
import { Card } from '@shared/components/ui/card';
import { Square, ExternalLink, Copy, CheckCircle2, XCircle, StopCircle, GitBranch, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { cn } from '@shared/lib/utils';

interface RunPanelProps {
  run: RunState;
  onStop: (runId: string) => void;
  onRerun: (options: RunOptions) => void;
}

function formatElapsed(startedAt: number, finishedAt: number | null): string {
  const end = finishedAt || Date.now();
  const seconds = Math.floor((end - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function statusIndicator(status: RunState['status']) {
  switch (status) {
    case 'running':
      return (
        <Badge variant="secondary" className="bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 border-blue-500/20 gap-1.5 py-1">
          <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          Running
        </Badge>
      );
    case 'completed':
      return (
        <Badge variant="secondary" className="bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 border-green-500/20 gap-1.5 py-1">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Completed
        </Badge>
      );
    case 'failed':
      return (
        <Badge variant="destructive" className="bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 border-red-500/20 gap-1.5 py-1">
          <XCircle className="w-3.5 h-3.5" />
          Failed
        </Badge>
      );
    case 'stopped':
      return (
        <Badge variant="secondary" className="bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 hover:bg-yellow-500/20 border-yellow-500/20 gap-1.5 py-1">
          <StopCircle className="w-3.5 h-3.5" />
          Stopped
        </Badge>
      );
  }
}

export default function RunPanel({ run, onStop, onRerun }: RunPanelProps) {
  const [_tick, setTick] = useState(0);
  const [promptExpanded, setPromptExpanded] = useState(false);

  useEffect(() => {
    if (run.status !== 'running') return;
    const interval = setInterval(() => {
      setTick((value) => value + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [run.status, run.startedAt]);

  const elapsed = formatElapsed(
    run.startedAt,
    run.status === 'running' ? null : run.finishedAt,
  );

  const handleCopyLog = () => {
    const text = run.logs.map((l) => l.raw).join('\n');
    navigator.clipboard.writeText(text);
  };

  const handleCopyPrompt = () => {
    navigator.clipboard.writeText(run.prompt);
  };

  const planPhase = run.phases['PLAN'];
  const canRerunWithPlan =
    run.status === 'failed' &&
    !!run.planText?.trim() &&
    (planPhase === 'completed' || planPhase === 'skipped');

  const handleRerun = () => {
    if (!run.planText?.trim()) return;
    onRerun({
      repoPath: run.repoPath,
      prompt: run.prompt,
      skipPlan: true,
      background: run.background,
      planText: run.planText,
      modelOverrides: run.modelOverrides ?? undefined,
    });
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 pt-12 bg-background/50">
      {/* Header */}
      <div className="px-6 py-5 border-b border-border flex-shrink-0 bg-card/30 backdrop-blur-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-bold text-foreground tracking-tight">{run.repoName}</h2>
            {run.branchName && (
              <Badge variant="outline" className="font-mono text-xs bg-muted/50 gap-1">
                <GitBranch className="w-3 h-3" />
                {run.branchName}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-4">
            {run.runMode === 'background' && run.status === 'running' && (
              <Badge variant="outline" className="text-xs">Background</Badge>
            )}
            {statusIndicator(run.status)}
            <span className="text-sm font-medium text-muted-foreground bg-muted/30 px-2.5 py-1 rounded-md">{elapsed}</span>
          </div>
        </div>
        <button
          onClick={() => setPromptExpanded(!promptExpanded)}
          className="flex items-start gap-1.5 text-left group/prompt w-full"
        >
          {promptExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/60 shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 mt-0.5 text-muted-foreground/60 shrink-0" />
          )}
          <p className={cn(
            "text-sm text-muted-foreground/90 max-w-3xl transition-all",
            promptExpanded ? "whitespace-pre-wrap" : "truncate"
          )}>
            {run.prompt}
          </p>
        </button>

        {/* Action bar */}
        <div className="flex items-center gap-2 mt-4">
          {run.status === 'running' && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => onStop(run.id)}
              className="h-8 text-xs shadow-sm hover:shadow-red-500/20 transition-all"
            >
              <Square className="w-3.5 h-3.5 mr-1.5 fill-current" />
              {run.runMode === 'background' ? 'Terminate Run' : 'Stop Run'}
            </Button>
          )}
          {canRerunWithPlan && (
            <Button
              variant="default"
              size="sm"
              onClick={handleRerun}
              className="h-8 text-xs shadow-sm transition-all"
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
              Re-run from Plan
            </Button>
          )}
          {run.prUrl && (
            <Button
              variant="default"
              size="sm"
              onClick={() => api().openUrl(run.prUrl!)}
              className="h-8 text-xs bg-green-600 hover:bg-green-500 text-white shadow-sm hover:shadow-green-500/20 transition-all"
            >
              <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
              Open PR
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyPrompt}
            className="h-8 text-xs shadow-sm transition-all"
          >
            <Copy className="w-3.5 h-3.5 mr-1.5" />
            Copy Prompt
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyLog}
            className="h-8 text-xs shadow-sm transition-all"
          >
            <Copy className="w-3.5 h-3.5 mr-1.5" />
            Copy Logs
          </Button>
        </div>
      </div>

      {/* Phase tracker */}
      <div className="border-b border-border flex-shrink-0 bg-muted/10">
        <PhaseTracker phases={run.phases} />
      </div>

      {/* PR completion banner */}
      {run.prUrl && run.status === 'completed' && (
        <div className="mx-6 mt-4 animate-in slide-in-from-top-2 fade-in duration-500">
          <Card className="p-4 bg-green-500/5 border-green-500/20 flex items-center justify-between shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5 text-green-500" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-green-600 dark:text-green-400">Pull Request Created Successfully</h3>
                <p className="text-xs text-green-600/70 dark:text-green-400/70 mt-0.5 font-mono">{run.prUrl}</p>
              </div>
            </div>
            <Button
              onClick={() => api().openUrl(run.prUrl!)}
              className="bg-green-600 hover:bg-green-500 text-white shadow-sm hover:shadow-green-500/20 transition-all"
            >
              <ExternalLink className="w-4 h-4 mr-2" />
              View in Browser
            </Button>
          </Card>
        </div>
      )}

      {/* Log viewer */}
      <div className="flex-1 min-h-0 p-4">
        <Card className="h-full overflow-hidden border-border/50 shadow-sm bg-card/50 backdrop-blur-sm">
          <LogViewer logs={run.logs} />
        </Card>
      </div>
    </div>
  );
}
