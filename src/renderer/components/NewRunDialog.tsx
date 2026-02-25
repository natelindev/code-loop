import { useState, useEffect } from 'react';
import RepoPicker from './RepoPicker';
import api from '../lib/ipc';
import { PREDEFINED_WORKFLOWS } from '@shared/types';
import type { AppConfig, RunOptions, ModelConfig, RepoMeta } from '@shared/types';
import { Button } from '@shared/components/ui/button';
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
  const [workflowId, setWorkflowId] = useState(initialOptions?.workflowId ?? config.defaultWorkflowId ?? PREDEFINED_WORKFLOWS[0].id);
  const [repoPath, setRepoPath] = useState(initialOptions?.repoPath ?? '');
  const [targetBranch, setTargetBranch] = useState(initialOptions?.targetBranch ?? '');
  const [repoBranches, setRepoBranches] = useState<string[]>([]);
  const [currentRepoBranch, setCurrentRepoBranch] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(initialOptions?.prompt ?? '');
  const [skipPlan, setSkipPlan] = useState(initialOptions?.skipPlan ?? false);
  const [background, setBackground] = useState(initialOptions?.background ?? false);
  const [autoMerge, setAutoMerge] = useState(initialOptions?.autoMerge ?? false);
  const [skipPr, setSkipPr] = useState(initialOptions?.skipPr ?? config.skipPr ?? false);
  const [planText, setPlanText] = useState(initialOptions?.planText ?? '');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [modelOverrides, setModelOverrides] = useState<Partial<ModelConfig>>({
    ...config.lastModelOverrides,
    ...(initialOptions?.modelOverrides ?? {}),
  });
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedWorkflow = PREDEFINED_WORKFLOWS.find((workflow) => workflow.id === workflowId) ?? PREDEFINED_WORKFLOWS[0];
  const supportsPrompt = selectedWorkflow.requiresPrompt;
  const supportsBackground = selectedWorkflow.id === 'development-auto-pr';
  const supportsSkipPr = selectedWorkflow.id === 'development-auto-pr';
  const supportsTargetBranch = selectedWorkflow.id === 'pr-autofix';
  const modelFields = supportsTargetBranch ? MODEL_FIELDS.filter((field) => field.key === 'modelFix') : MODEL_FIELDS;

  useEffect(() => {
    api().listModels().then(setAvailableModels);
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!repoPath.trim()) {
      setRepoBranches([]);
      setCurrentRepoBranch(null);
      if (!supportsTargetBranch) {
        setTargetBranch('');
      }
      return;
    }

    api()
      .listRepoBranches(repoPath.trim())
      .then(({ branches, current }) => {
        if (cancelled) return;
        setRepoBranches(branches);
        setCurrentRepoBranch(current);
        if (!supportsTargetBranch) {
          setTargetBranch('');
          return;
        }

        const preferred = targetBranch || initialOptions?.targetBranch || current || branches[0] || '';
        if (preferred) {
          setTargetBranch(preferred);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setRepoBranches([]);
        setCurrentRepoBranch(null);
      });

    return () => {
      cancelled = true;
    };
  }, [repoPath, supportsTargetBranch]);

  const handleRepoChange = (path: string, _meta: RepoMeta | null) => {
    setRepoPath(path);
    setError(null);
    if (!path.trim()) {
      setTargetBranch('');
    }
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
    if (supportsPrompt && skipPlan && !planText.trim()) {
      setError('Please provide a plan when skipping the plan phase');
      return;
    }
    if (supportsPrompt && !skipPlan && !prompt.trim()) {
      setError('Please enter a prompt');
      return;
    }
    if (supportsTargetBranch && !targetBranch.trim()) {
      setError('Please select a target branch for PR Autofix');
      return;
    }

    setStarting(true);
    setError(null);

    const options: RunOptions = {
      repoPath: repoPath.trim(),
      workflowId,
      targetBranch: supportsTargetBranch ? targetBranch.trim() : undefined,
      prompt: supportsPrompt ? prompt.trim() : undefined,
      skipPlan: supportsPrompt ? skipPlan : false,
      background: supportsBackground ? background : false,
      autoMerge,
      skipPr: supportsSkipPr ? skipPr : false,
      planText: supportsPrompt && skipPlan ? planText.trim() : undefined,
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

          <div className="space-y-2">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Workflow</Label>
            <Select
              value={workflowId}
              onValueChange={(value) => {
                setWorkflowId(value);
                setError(null);
                const selected = PREDEFINED_WORKFLOWS.find((workflow) => workflow.id === value);
                if (selected?.id !== 'development-auto-pr') {
                  setBackground(false);
                  setSkipPr(false);
                  setSkipPlan(false);
                }
                if (selected?.id !== 'pr-autofix') {
                  setTargetBranch('');
                }
              }}
            >
              <SelectTrigger className="h-9 bg-background">
                <SelectValue placeholder="Select workflow" />
              </SelectTrigger>
              <SelectContent>
                {PREDEFINED_WORKFLOWS.map((workflow) => (
                  <SelectItem key={workflow.id} value={workflow.id}>{workflow.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{selectedWorkflow.description}</p>
          </div>

          {supportsTargetBranch && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">PR Branch</Label>
              <Select value={targetBranch} onValueChange={setTargetBranch}>
                <SelectTrigger className="h-9 bg-background">
                  <SelectValue placeholder="Select branch with open PR" />
                </SelectTrigger>
                <SelectContent>
                  {repoBranches.map((branch) => (
                    <SelectItem key={branch} value={branch}>
                      {branch}{currentRepoBranch === branch ? ' (current)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                PR Autofix runs against the selected local branch and expects an open PR for that branch.
              </p>
            </div>
          )}

          {/* Skip plan toggle */}
          {supportsPrompt && (
            <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">Skip Plan Phase</Label>
                <p className="text-xs text-muted-foreground">Provide your own implementation plan</p>
              </div>
              <Switch checked={skipPlan} onCheckedChange={setSkipPlan} />
            </div>
          )}

          <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium">Run in Background</Label>
              <p className="text-xs text-muted-foreground">
                {supportsBackground
                  ? 'Keeps running even after app quit; logs still stream while app is open'
                  : 'This workflow currently runs in foreground only'}
              </p>
            </div>
            <Switch checked={supportsBackground ? background : false} onCheckedChange={setBackground} disabled={!supportsBackground} />
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium">Auto Merge PR</Label>
              <p className="text-xs text-muted-foreground">After PR creation, automatically merge when mergeable (default off)</p>
            </div>
            <Switch checked={autoMerge} onCheckedChange={setAutoMerge} disabled={skipPr} />
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium">Skip PR (Commit Only)</Label>
              <p className="text-xs text-muted-foreground">
                {supportsSkipPr
                  ? 'Only commit changes locally — do not push or create a pull request'
                  : 'This option is only available for Development + Auto PR'}
              </p>
            </div>
            <Switch
              checked={supportsSkipPr ? skipPr : false}
              onCheckedChange={(checked) => { setSkipPr(checked); if (checked) setAutoMerge(false); }}
              disabled={!supportsSkipPr}
            />
          </div>

          {/* Plan text area */}
          {supportsPrompt && skipPlan && (
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
          {supportsPrompt && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {skipPlan ? 'Task Description (Optional)' : 'Prompt'}
              </Label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={skipPlan
                  ? 'Optional: add extra context beyond your plan...'
                  : 'Describe the task you want to accomplish...'}
                rows={4}
                className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
              />
            </div>
          )}

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
                {modelFields.map(({ key, label }) => (
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
