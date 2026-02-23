import { useCallback, useEffect, useState } from 'react';
import Sidebar from './components/Sidebar';
import RunPanel from './components/RunPanel';
import NewRunDialog from './components/NewRunDialog';
import ConfigEditor from './components/ConfigEditor';
import LaunchRequirementsDialog from './components/LaunchRequirementsDialog';
import { useRuns } from './hooks/useRuns';
import { useConfig } from './hooks/useConfig';
import api from './lib/ipc';
import type { RunOptions, LaunchRequirements } from '@shared/types';
import { Button } from '@shared/components/ui/button';
import { ModeToggle } from './components/theme/mode-toggle';
import { RefreshCw } from 'lucide-react';

type View = 'runs' | 'config';

export default function App() {
  const { runs, selectedRun, selectedRunId, setSelectedRunId, startRun, stopRun } = useRuns();
  const { config, loading: configLoading, save: saveConfig } = useConfig();
  const [view, setView] = useState<View>('runs');
  const [showNewRun, setShowNewRun] = useState(false);
  const [newRunPreset, setNewRunPreset] = useState<Partial<RunOptions> | null>(null);
  const [checkingLaunchRequirements, setCheckingLaunchRequirements] = useState(false);
  const [launchRequirements, setLaunchRequirements] = useState<LaunchRequirements | null>(null);

  const refreshLaunchRequirements = useCallback(async () => {
    if (!config || config.launchChecksPassed) {
      setCheckingLaunchRequirements(false);
      setLaunchRequirements(null);
      return;
    }

    setCheckingLaunchRequirements(true);
    try {
      const status = await api().checkLaunchRequirements();
      setLaunchRequirements(status);
      if (status.ready && !config.launchChecksPassed) {
        await saveConfig({
          ...config,
          launchChecksPassed: true,
        });
      }
    } catch {
      setLaunchRequirements({
        ready: false,
        checkedAt: Date.now(),
        opencode: {
          installed: false,
          authenticated: false,
          hint: 'Unable to verify OpenCode CLI status',
          details: 'Failed to run startup checks. Please ensure terminal commands are available and try again.',
        },
        gh: {
          installed: false,
          authenticated: false,
          hint: 'Unable to verify GitHub CLI status',
          details: 'Failed to run startup checks. Please ensure terminal commands are available and try again.',
        },
      });
    } finally {
      setCheckingLaunchRequirements(false);
    }
  }, [config, saveConfig]);

  useEffect(() => {
    if (!config) return;
    if (config.launchChecksPassed) {
      setCheckingLaunchRequirements(false);
      setLaunchRequirements(null);
      return;
    }

    void refreshLaunchRequirements();
  }, [config, refreshLaunchRequirements]);

  if (configLoading || !config) {
    return (
      <div className="h-screen flex items-center justify-center bg-background text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span>Loading configuration...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-background text-foreground transition-colors duration-300">
      {/* Draggable title bar area */}
      <div className="fixed top-0 left-0 right-0 h-12 z-50 flex justify-end items-center px-4" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <ModeToggle />
        </div>
      </div>

      <Sidebar
        runs={runs}
        selectedRunId={selectedRunId}
        onSelectRun={setSelectedRunId}
        onNewRun={() => {
          setNewRunPreset(null);
          setShowNewRun(true);
        }}
        view={view}
        onViewChange={setView}
      />

      <main className="flex-1 flex flex-col overflow-hidden bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        {view === 'config' ? (
          <ConfigEditor key={JSON.stringify(config)} config={config} onSave={saveConfig} />
        ) : selectedRun ? (
          <RunPanel
            run={selectedRun}
            onStop={stopRun}
            onRerun={(options) => {
              setNewRunPreset(options);
              setShowNewRun(true);
            }}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center animate-in fade-in zoom-in duration-500">
              <div className="mb-4 flex justify-center">
                <RefreshCw className="w-14 h-14 text-muted-foreground/40" />
              </div>
              <h2 className="text-xl font-medium mb-2 text-foreground">No run selected</h2>
              <p className="text-sm mb-6">Start a new run or select one from the sidebar</p>
              <Button
                onClick={() => {
                  setNewRunPreset(null);
                  setShowNewRun(true);
                }}
                size="lg"
                className="transition-all hover:scale-105"
              >
                New Run
              </Button>
            </div>
          </div>
        )}
      </main>

      {showNewRun && (
        <NewRunDialog
          initialOptions={newRunPreset}
          config={config}
          onStart={async (options) => {
            const result = await startRun(options);
            if (result.ok) {
              await saveConfig({
                ...config,
                lastModelOverrides: options.modelOverrides ?? {},
              });
              setNewRunPreset(null);
              setShowNewRun(false);
              setView('runs');
            }
            return result;
          }}
          onClose={() => {
            setShowNewRun(false);
            setNewRunPreset(null);
          }}
        />
      )}

      <LaunchRequirementsDialog
        requirements={launchRequirements}
        checking={checkingLaunchRequirements}
        onRecheck={refreshLaunchRequirements}
      />
    </div>
  );
}
