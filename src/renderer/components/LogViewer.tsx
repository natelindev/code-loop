import { useEffect, useRef, useState } from 'react';
import Anser from 'anser';
import type { LogEntry } from '@shared/types';
import { Button } from '@shared/components/ui/button';
import { ArrowDownToLine, Terminal } from 'lucide-react';
import { cn } from '@shared/lib/utils';

interface LogViewerProps {
  logs: LogEntry[];
}

function phaseTagColor(phase: string): string {
  switch (phase.toUpperCase()) {
    case 'CLONE':
    case 'SETUP':
      return 'text-cyan-500 dark:text-cyan-400';
    case 'PLAN':
      return 'text-purple-500 dark:text-purple-400';
    case 'IMPLEMENT':
      return 'text-blue-500 dark:text-blue-400';
    case 'REVIEW':
      return 'text-yellow-500 dark:text-yellow-400';
    case 'FIX':
      return 'text-orange-500 dark:text-orange-400';
    case 'COMMIT':
    case 'PUSH':
      return 'text-green-500 dark:text-green-400';
    case 'PR':
    case 'DONE':
      return 'text-emerald-500 dark:text-emerald-400';
    case 'COST':
      return 'text-muted-foreground';
    case 'ERROR':
      return 'text-destructive';
    case 'RETRY':
      return 'text-amber-500 dark:text-amber-400';
    case 'INIT':
      return 'text-muted-foreground';
    default:
      return 'text-muted-foreground';
  }
}

function LogLine({ entry }: { entry: LogEntry }) {
  const html = Anser.ansiToHtml(entry.raw, { use_classes: false });

  return (
    <div className="flex gap-3 py-1 px-4 hover:bg-muted/50 font-mono text-[11px] leading-relaxed transition-colors">
      <span className="text-muted-foreground/50 flex-shrink-0 select-none w-16">
        {entry.timestamp.substring(11, 19)}
      </span>
      <span className={cn("flex-shrink-0 w-24 font-semibold select-none", phaseTagColor(entry.phase))}>
        [{entry.phase}]
      </span>
      <span
        className="text-foreground/90 break-all whitespace-pre-wrap"
        dangerouslySetInnerHTML={{ __html: html.replace(/^\[.*?\] \[.*?\] /, '') }}
      />
    </div>
  );
}

export default function LogViewer({ logs }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs.length, autoScroll]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoScroll(atBottom);
  };

  // Only show last 5000 lines for performance
  const visibleLogs = logs.length > 5000 ? logs.slice(-5000) : logs;

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full bg-background/50">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          <Terminal className="w-4 h-4" />
          Terminal Output
        </div>
        <div className="flex items-center gap-3">
          {logs.length > 5000 && (
            <span className="text-xs text-muted-foreground/70">
              Showing last 5000 of {logs.length} lines
            </span>
          )}
          {!autoScroll && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setAutoScroll(true);
                if (containerRef.current) {
                  containerRef.current.scrollTop = containerRef.current.scrollHeight;
                }
              }}
              className="h-7 text-xs bg-primary/10 text-primary hover:bg-primary/20 border-primary/20 animate-in fade-in slide-in-from-top-1"
            >
              <ArrowDownToLine className="w-3.5 h-3.5 mr-1.5" />
              Resume Auto-scroll
            </Button>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto py-2 scroll-smooth"
      >
        {visibleLogs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground/50 font-mono italic">
            Waiting for logs...
          </div>
        ) : (
          visibleLogs.map((log, i) => <LogLine key={i} entry={log} />)
        )}
      </div>
    </div>
  );
}
