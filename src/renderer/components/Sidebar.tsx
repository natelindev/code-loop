import type { RunState } from '@shared/types';
import { Button } from '@shared/components/ui/button';
import { ScrollArea } from '@shared/components/ui/scroll-area';
import { Separator } from '@shared/components/ui/separator';
import { Badge } from '@shared/components/ui/badge';
import { Settings, Play, Plus, RefreshCw, CheckCircle2, XCircle, StopCircle } from 'lucide-react';
import { cn } from '@shared/lib/utils';
import { getSubAgentActivity } from '../lib/sub-agent';

interface SidebarProps {
  runs: RunState[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  onNewRun: () => void;
  view: 'runs' | 'config';
  onViewChange: (view: 'runs' | 'config') => void;
}

function formatElapsed(startedAt: number, finishedAt: number | null): string {
  const end = finishedAt || Date.now();
  const seconds = Math.floor((end - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function statusBadge(status: RunState['status']) {
  switch (status) {
    case 'running':
      return (
        <Badge variant="secondary" className="bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 border-blue-500/20 gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
          Running
        </Badge>
      );
    case 'completed':
      return (
        <Badge variant="secondary" className="bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 border-green-500/20 gap-1">
          <CheckCircle2 className="w-3 h-3" />
          Done
        </Badge>
      );
    case 'failed':
      return (
        <Badge variant="destructive" className="bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 border-red-500/20 gap-1">
          <XCircle className="w-3 h-3" />
          Failed
        </Badge>
      );
    case 'stopped':
      return (
        <Badge variant="secondary" className="bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 hover:bg-yellow-500/20 border-yellow-500/20 gap-1">
          <StopCircle className="w-3 h-3" />
          Stopped
        </Badge>
      );
  }
}

export default function Sidebar({
  runs,
  selectedRunId,
  onSelectRun,
  onNewRun,
  view,
  onViewChange,
}: SidebarProps) {
  const sortedRuns = [...runs].sort((a, b) => b.startedAt - a.startedAt);
  const runningRuns = sortedRuns.filter((r) => r.status === 'running');
  const finishedRuns = sortedRuns.filter((r) => r.status !== 'running');

  return (
    <div className="w-72 bg-background/80 backdrop-blur-xl border-r border-border flex flex-col h-full shadow-2xl z-10">
      {/* Header / drag region spacer */}
      <div className="pt-12 px-4 pb-4 flex items-center justify-between">
        <h1 className="text-sm font-bold text-foreground tracking-wider flex items-center gap-2">
          <RefreshCw className="w-4 h-4 text-primary" />
          CODELOOP
        </h1>
        <Button
          onClick={onNewRun}
          size="icon"
          variant="default"
          className="w-8 h-8 rounded-full shadow-lg hover:shadow-primary/25 transition-all hover:scale-105"
          title="New Run"
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      <div className="px-3 pb-3">
        <div className="flex gap-2 bg-muted/50 p-1 rounded-lg">
          <Button
            variant={view === 'runs' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => onViewChange('runs')}
            className={cn("flex-1 text-xs font-medium transition-all", view === 'runs' && "shadow-sm bg-background")}
          >
            <Play className="w-3.5 h-3.5 mr-1.5" />
            Runs
          </Button>
          <Button
            variant={view === 'config' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => onViewChange('config')}
            className={cn("flex-1 text-xs font-medium transition-all", view === 'config' && "shadow-sm bg-background")}
          >
            <Settings className="w-3.5 h-3.5 mr-1.5" />
            Settings
          </Button>
        </div>
      </div>

      <Separator className="opacity-50" />

      {/* Runs list */}
      <ScrollArea className="flex-1 min-h-0 px-3 py-4">
        {runningRuns.length > 0 && (
          <div className="mb-6 animate-in fade-in slide-in-from-left-2 duration-300">
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
              Active
            </div>
            <div className="space-y-1 mt-1">
              {runningRuns.map((run) => (
                <RunItem
                  key={run.id}
                  run={run}
                  selected={selectedRunId === run.id && view === 'runs'}
                  onClick={() => {
                    onSelectRun(run.id);
                    onViewChange('runs');
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {finishedRuns.length > 0 && (
          <div className="animate-in fade-in slide-in-from-left-2 duration-500">
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              History
            </div>
            <div className="space-y-1 mt-1">
              {finishedRuns.map((run) => (
                <RunItem
                  key={run.id}
                  run={run}
                  selected={selectedRunId === run.id && view === 'runs'}
                  onClick={() => {
                    onSelectRun(run.id);
                    onViewChange('runs');
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {runs.length === 0 && (
          <div className="px-4 py-12 text-center text-muted-foreground text-sm flex flex-col items-center gap-3 animate-in fade-in duration-700">
            <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
              <Play className="w-5 h-5 text-muted-foreground/50 ml-1" />
            </div>
            <p>No runs yet.<br/>Click + to start one.</p>
          </div>
        )}
      </ScrollArea>

    </div>
  );
}

function RunItem({
  run,
  selected,
  onClick,
}: {
  run: RunState;
  selected: boolean;
  onClick: () => void;
}) {
  const subAgentActivity = getSubAgentActivity(run.logs);

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-2 rounded-lg transition-all duration-200 group relative border-b border-border/30 last:border-0",
        selected
          ? "bg-accent"
          : "hover:bg-muted/80"
      )}
    >
      {selected && (
        <div className="absolute left-0 top-1 bottom-1 w-1 bg-primary rounded-full" />
      )}
      <div className="flex items-center justify-between mb-1">
        <span className={cn(
          "text-sm font-semibold truncate flex-1 mr-2 transition-colors",
          selected ? "text-primary" : "text-foreground group-hover:text-primary/80"
        )}>
          {run.repoName}
        </span>
        {statusBadge(run.status)}
      </div>
      <p className="text-xs text-muted-foreground truncate mb-1.5 group-hover:text-foreground/70 transition-colors">
        {run.prompt}
      </p>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {run.currentPhase || 'INIT'}
          </span>
          {run.status === 'running' && subAgentActivity.active && (
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400 truncate"
              title={subAgentActivity.task ?? undefined}
            >
              Agent
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground/70 font-medium">
          {formatElapsed(run.startedAt, run.finishedAt)}
        </span>
      </div>
    </button>
  );
}
