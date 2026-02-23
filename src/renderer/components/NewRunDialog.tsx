import { useState, useEffect } from 'react';
import RepoPicker from './RepoPicker';
import api from '../lib/ipc';
import type { AppConfig, RunOptions, ModelConfig, RepoMeta } from '@shared/types';
import { Button } from '@shared/components/ui/button';
import { Input } from '@shared/components/ui/input';
import { Label } from '@shared/components/ui/label';
import { Switch } from '@shared/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@shared/components/ui/dialog';
import { ChevronRight, Play, Loader2 } from 'lucide-react';
import { cn } from '@shared/lib/utils';

interface NewRunDialogProps {
  config: AppConfig;
  initialOptions?: Partial<RunOptions> | null;
  onStart: (options: RunOptions) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}

const MODEL_FIELDS: { key: keyof ModelConfig; label: string }[] = [
  { key: 'modelPlan', label: 'Plan' },
  { key: 'modelImplement', label: 'Implement' },
  { key: 'modelReview', label: 'Review' },
  { key: 'modelFix', label: 'Fix' },
  { key: 'modelCommit', label: 'Commit' },
  { key: 'modelPr', label: 'PR' },
  { key: 'modelBranch', label: 'Branch' },
];

export default function NewRunDialog({ config, initialOptions, onStart, onClose }: NewRunDialogProps) {
  const [repoPath, setRepoPath] = useState(initialOptions?.repoPath ?? '');
  const [prompt, setPrompt] = useState(initialOptions?.prompt ?? '');
  const [skipPlan, setSkipPlan] = useState(initialOptions?.skipPlan ?? false);
  const [background, setBackground] = useState(initialOptions?.background ?? false);
  const [planText, setPlanText] = useState(initialOptions?.planText ?? '');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [modelOverrides, setModelOverrides] = useState<Partial<ModelConfig>>({
    ...config.lastModelOverrides,
    ...(initialOptions?.modelOverrides ?? {}),
  });
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api().listModels().then(setAvailableModels);
  }, []);

  useEffect(() => {
    setRepoPath(initialOptions?.repoPath ?? '');
    setPrompt(initialOptions?.prompt ?? '');
    setSkipPlan(initialOptions?.skipPlan ?? false);
    setBackground(initialOptions?.background ?? false);
    setPlanText(initialOptions?.planText ?? '');
    setModelOverrides({
      ...config.lastModelOverrides,
      ...(initialOptions?.modelOverrides ?? {}),
    });
    setError(null);
  }, [config.lastModelOverrides, initialOptions]);

  const handleRepoChange = (path: string, _meta: RepoMeta | null) => {
    setRepoPath(path);
    setError(null);
  };

  const setOverride = (key: keyof ModelConfig, value: string) => {
    setModelOverrides((prev) => {
      const next = { ...prev };
      if (value === config.models[key]) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  const handleStart = async () => {
    if (!repoPath.trim()) {
      setError('Please select a repository');
      return;
    }
    if (!prompt.trim()) {
      setError('Please enter a prompt');
      return;
    }
    if (skipPlan && !planText.trim()) {
      setError('Please provide a plan when skipping the plan phase');
      return;
    }

    setStarting(true);
    setError(null);

    const options: RunOptions = {
      repoPath: repoPath.trim(),
      prompt: prompt.trim(),
      skipPlan,
      background,
      planText: skipPlan ? planText.trim() : undefined,
      modelOverrides: Object.keys(modelOverrides).length > 0 ? modelOverrides : undefined,
    };

    const result = await onStart(options);
    setStarting(false);

    if (!result.ok) {
      setError(result.error || 'Failed to start run');
    }
  };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[600px] bg-background/95 backdrop-blur-xl border-border shadow-2xl p-0 overflow-hidden">
        <DialogHeader className="px-6 py-4 border-b border-border bg-muted/30">
          <DialogTitle className="text-xl font-bold flex items-center gap-2">
            <Play className="w-5 h-5 text-primary" />
            New Run
          </DialogTitle>
        </DialogHeader>

        <div className="px-6 py-5 space-y-6 max-h-[65vh] overflow-y-auto">
          {/* Repo picker */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Repository</Label>
            <RepoPicker config={config} value={repoPath} onChange={handleRepoChange} />
          </div>

          {/* Skip plan toggle */}
          <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium">Skip Plan Phase</Label>
              <p className="text-xs text-muted-foreground">Provide your own implementation plan</p>
            </div>
            <Switch checked={skipPlan} onCheckedChange={setSkipPlan} />
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium">Run in Background</Label>
              <p className="text-xs text-muted-foreground">Keeps running even after app quit; logs still stream while app is open</p>
            </div>
            <Switch checked={background} onCheckedChange={setBackground} />
          </div>

          {/* Plan text area */}
          {skipPlan && (
            <div className="space-y-2 animate-in slide-in-from-top-2 fade-in duration-300">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Custom Plan</Label>
              <textarea
                value={planText}
                onChange={(e) => setPlanText(e.target.value)}
                placeholder="Paste your implementation plan here..."
                rows={6}
                className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono resize-y"
              />
            </div>
          )}

          {/* Prompt */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {skipPlan ? 'Task Description' : 'Prompt'}
            </Label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the task you want to accomplish..."
              rows={4}
              className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
            />
          </div>

          {/* Advanced: model overrides */}
          <div className="pt-2 border-t border-border/50">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors w-full py-2"
            >
              <ChevronRight className={cn("w-4 h-4 transition-transform duration-200", showAdvanced && "rotate-90")} />
              Advanced: Model Overrides
            </button>

            {showAdvanced && (
              <div className="mt-4 space-y-3 animate-in slide-in-from-top-2 fade-in duration-300 p-4 rounded-lg bg-muted/20 border border-border/50">
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setModelOverrides({})}
                  >
                    Reset to defaults
                  </Button>
                </div>
                {MODEL_FIELDS.map(({ key, label }) => (
                  <div key={key} className="flex items-center justify-between gap-3">
                    <Label className="text-xs text-muted-foreground w-20 shrink-0">{label}</Label>
                    <Select
                      value={modelOverrides[key] || config.models[key]}
                      onValueChange={(value) => setOverride(key, value)}
                    >
                      <SelectTrigger className="h-8 text-xs bg-background flex-1">
                        <SelectValue placeholder="Select model" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={config.models[key]}>{config.models[key]} (Default)</SelectItem>
                        {availableModels
                          .filter((m) => m !== config.models[key])
                          .map((m) => (
                            <SelectItem key={m} value={m}>{m}</SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t border-border bg-muted/30 flex items-center justify-between sm:justify-between">
          <div className="flex-1">
            {error && <p className="text-sm text-destructive font-medium animate-in fade-in">{error}</p>}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={starting}>
              Cancel
            </Button>
            <Button onClick={handleStart} disabled={starting} className="min-w-[100px]">
              {starting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Starting
                </>
              ) : (
                'Start Run'
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
