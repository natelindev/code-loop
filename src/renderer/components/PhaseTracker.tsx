import type { PhaseStatus } from '@shared/types';
import { PIPELINE_PHASES } from '@shared/types';
import { CheckCircle2, Circle, Loader2, XCircle, MinusCircle } from 'lucide-react';
import { cn } from '@shared/lib/utils';

interface PhaseTrackerProps {
  phases: Record<string, PhaseStatus>;
}

const PHASE_LABELS: Record<string, string> = {
  CLONE: 'Clone',
  SETUP: 'Setup',
  PLAN: 'Plan',
  IMPLEMENT: 'Implement',
  REVIEW: 'Review',
  FIX: 'Fix',
  COMMIT: 'Commit',
  PUSH: 'Push',
  PR: 'PR',
};

function phaseIcon(status: PhaseStatus) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-4 h-4" />;
    case 'active':
      return <Loader2 className="w-4 h-4 animate-spin" />;
    case 'failed':
      return <XCircle className="w-4 h-4" />;
    case 'skipped':
      return <MinusCircle className="w-4 h-4 opacity-50" />;
    default: // pending
      return <Circle className="w-4 h-4 opacity-30" />;
  }
}

function phaseColor(status: PhaseStatus): string {
  switch (status) {
    case 'completed':
      return 'text-emerald-500 dark:text-emerald-400';
    case 'active':
      return 'text-blue-500 dark:text-blue-400';
    case 'failed':
      return 'text-destructive';
    case 'skipped':
      return 'text-muted-foreground';
    default:
      return 'text-muted-foreground/50';
  }
}

function connectorColor(status: PhaseStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-emerald-500/50 dark:bg-emerald-400/50';
    case 'active':
      return 'bg-blue-500/50 dark:bg-blue-400/50';
    default:
      return 'bg-border';
  }
}

export default function PhaseTracker({ phases }: PhaseTrackerProps) {
  return (
    <div className="flex items-center gap-0 px-4 py-3 overflow-x-auto scrollbar-none">
      {PIPELINE_PHASES.map((phase, i) => {
        const status = phases[phase] || 'pending';
        return (
          <div key={phase} className="flex items-center">
            <div className={cn("flex flex-col items-center gap-1.5 min-w-[60px] transition-colors duration-300", phaseColor(status))}>
              {phaseIcon(status)}
              <span
                className={cn(
                  "text-[10px] font-semibold uppercase tracking-wider transition-colors duration-300",
                  status === 'active' ? 'text-blue-600 dark:text-blue-300' : ''
                )}
              >
                {PHASE_LABELS[phase] || phase}
              </span>
            </div>
            {i < PIPELINE_PHASES.length - 1 && (
              <div className={cn("w-6 h-[2px] flex-shrink-0 transition-colors duration-300 rounded-full", connectorColor(status))} />
            )}
          </div>
        );
      })}
    </div>
  );
}
