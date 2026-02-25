import { useState, useEffect } from 'react';
import api from '../lib/ipc';
import type { AppConfig, ModelConfig } from '@shared/types';
import { Button } from '@shared/components/ui/button';
import { Input } from '@shared/components/ui/input';
import { Label } from '@shared/components/ui/label';
import { Switch } from '@shared/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@shared/components/ui/card';
import { Separator } from '@shared/components/ui/separator';
import { Save, FolderOpen, Plus, X, CheckCircle2 } from 'lucide-react';

interface ConfigEditorProps {
  config: AppConfig;
  onSave: (config: AppConfig) => Promise<void>;
}

const MODEL_FIELDS: { key: keyof ModelConfig; label: string; description: string }[] = [
  { key: 'modelPlan', label: 'Plan', description: 'Used for analyzing codebase and creating implementation plans' },
  { key: 'modelImplement', label: 'Implement', description: 'Used for making actual code changes' },
  { key: 'modelReview', label: 'Review', description: 'Used for critically reviewing code changes' },
  { key: 'modelFix', label: 'Fix', description: 'Used for fixing issues found during review' },
  { key: 'modelCommit', label: 'Commit Message', description: 'Used for generating conventional commit messages' },
  { key: 'modelPr', label: 'PR Description', description: 'Used for generating PR title and body' },
  { key: 'modelBranch', label: 'Branch Name', description: 'Used for generating branch name slugs' },
];

export default function ConfigEditor({ config, onSave }: ConfigEditorProps) {
  const [draft, setDraft] = useState<AppConfig>({ ...config });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [newCommand, setNewCommand] = useState('');

  useEffect(() => {
    api()
      .listModels()
      .then((models) => {
        setAvailableModels(models);
        setLoadingModels(false);
      })
      .catch(() => setLoadingModels(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    await onSave(draft);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const updateModel = (key: keyof ModelConfig, value: string) => {
    setDraft((prev) => ({
      ...prev,
      models: { ...prev.models, [key]: value },
    }));
  };

  const addCommand = () => {
    if (!newCommand.trim()) return;
    setDraft((prev) => ({
      ...prev,
      postCloneCommands: [...prev.postCloneCommands, newCommand.trim()],
    }));
    setNewCommand('');
  };

  const removeCommand = (index: number) => {
    setDraft((prev) => ({
      ...prev,
      postCloneCommands: prev.postCloneCommands.filter((_, i) => i !== index),
    }));
  };

  const handlePickWorkspaceRoot = async () => {
    const result = await api().pickFolder();
    if (result && 'path' in result) {
      setDraft((prev) => ({ ...prev, workspaceRoot: result.path }));
    }
  };

  return (
    <div className="flex-1 overflow-y-auto pt-12 bg-background/50">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">
        <div className="flex items-center justify-between sticky top-0 z-10 bg-background/80 backdrop-blur-xl py-4 -mx-6 px-6 border-b border-border/50 shadow-sm">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Configure the CodeLoop pipeline defaults
            </p>
          </div>
          <Button
            onClick={handleSave}
            disabled={saving}
            variant={saved ? "secondary" : "default"}
            className="min-w-[120px] transition-all duration-300"
          >
            {saving ? (
              <span className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Saving...
              </span>
            ) : saved ? (
              <span className="flex items-center gap-2 text-green-600 dark:text-green-400">
                <CheckCircle2 className="w-4 h-4" />
                Saved
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Save className="w-4 h-4" />
                Save Changes
              </span>
            )}
          </Button>
        </div>

        <div className="space-y-8 pb-12">
          {/* General */}
          <Card className="bg-card/50 backdrop-blur-sm border-border/50 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">General</CardTitle>
              <CardDescription>Basic configuration for the pipeline</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label>Workspace Root</Label>
                <p className="text-xs text-muted-foreground">Directory where cloned repos are stored</p>
                <div className="flex gap-2">
                  <Input
                    value={draft.workspaceRoot}
                    onChange={(e) => setDraft((prev) => ({ ...prev, workspaceRoot: e.target.value }))}
                    className="font-mono text-sm bg-background/50"
                  />
                  <Button variant="outline" onClick={handlePickWorkspaceRoot} className="shrink-0">
                    <FolderOpen className="w-4 h-4 mr-2" />
                    Browse
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label>Max Retries</Label>
                  <p className="text-xs text-muted-foreground">Maximum retry attempts (1-3)</p>
                  <Input
                    type="number"
                    min={1}
                    max={3}
                    value={draft.maxRetries}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        maxRetries: Math.max(1, Math.min(3, parseInt(e.target.value) || 1)),
                      }))
                    }
                    className="w-24 bg-background/50"
                  />
                </div>

                <div className="space-y-3">
                  <Label>Notifications</Label>
                  <p className="text-xs text-muted-foreground">Play sound on completion</p>
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={draft.notificationSound}
                      onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, notificationSound: checked }))}
                    />
                    <span className="text-sm font-medium">{draft.notificationSound ? 'Enabled' : 'Disabled'}</span>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <Label>External Directory Access</Label>
                <p className="text-xs text-muted-foreground">Automatically approve OpenCode file access outside the current working folder</p>
                <div className="flex items-center gap-3">
                  <Switch
                    checked={draft.autoApproveExternalDirectory}
                    onCheckedChange={(checked) =>
                      setDraft((prev) => ({ ...prev, autoApproveExternalDirectory: checked }))
                    }
                  />
                  <span className="text-sm font-medium">{draft.autoApproveExternalDirectory ? 'Auto-approve enabled' : 'Auto-approve disabled'}</span>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Branch Name Prefix</Label>
                <p className="text-xs text-muted-foreground">Prefix used for generated branch names (e.g. prefix/task-slug)</p>
                <Input
                  value={draft.branchPrefix}
                  onChange={(e) => setDraft((prev) => ({ ...prev, branchPrefix: e.target.value }))}
                  placeholder="codeloop"
                  className="w-48 font-mono text-sm bg-background/50"
                />
              </div>

              <div className="space-y-3">
                <Label>Skip PR Creation</Label>
                <p className="text-xs text-muted-foreground">Commit only — do not push or create a pull request (can be overridden per run)</p>
                <div className="flex items-center gap-3">
                  <Switch
                    checked={draft.skipPr}
                    onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, skipPr: checked }))}
                  />
                  <span className="text-sm font-medium">{draft.skipPr ? 'Commit only' : 'Push + PR'}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Models */}
          <Card className="bg-card/50 backdrop-blur-sm border-border/50 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">AI Models</CardTitle>
              <CardDescription>Select which models to use for different phases</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingModels ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin mr-3" />
                  Loading available models...
                </div>
              ) : (
                <div className="space-y-4">
                  {MODEL_FIELDS.map(({ key, label, description }) => (
                    <div key={key} className="flex items-center justify-between gap-4 py-2 border-b border-border/30 last:border-0">
                      <div className="flex-1 min-w-0">
                        <Label className="text-sm">{label}</Label>
                        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                      </div>
                      <Select
                        value={draft.models[key]}
                        onValueChange={(value) => updateModel(key, value)}
                      >
                        <SelectTrigger className="w-[240px] bg-background/50">
                          <SelectValue placeholder="Select model" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={draft.models[key]}>{draft.models[key]}</SelectItem>
                          {availableModels
                            .filter((m) => m !== draft.models[key])
                            .map((m) => (
                              <SelectItem key={m} value={m}>{m}</SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Post-Clone Commands */}
          <Card className="bg-card/50 backdrop-blur-sm border-border/50 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Post-Clone Commands</CardTitle>
              <CardDescription>Commands to run after cloning the repo (e.g., install dependencies)</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                {draft.postCloneCommands.map((cmd, i) => (
                  <div key={i} className="flex items-center gap-2 group">
                    <div className="flex-1 bg-muted/50 border border-border rounded-md px-3 py-2 text-sm font-mono">
                      {cmd}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeCommand(i)}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
                {draft.postCloneCommands.length === 0 && (
                  <div className="text-sm text-muted-foreground italic py-2">No commands configured</div>
                )}
              </div>
              
              <Separator className="my-4" />
              
              <div className="flex gap-2">
                <Input
                  value={newCommand}
                  onChange={(e) => setNewCommand(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addCommand()}
                  placeholder="e.g., npm install"
                  className="font-mono text-sm bg-background/50"
                />
                <Button variant="secondary" onClick={addCommand} className="shrink-0">
                  <Plus className="w-4 h-4 mr-2" />
                  Add Command
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Retry Delays */}
          <Card className="bg-card/50 backdrop-blur-sm border-border/50 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Retry Delays</CardTitle>
              <CardDescription>Seconds to wait between retry attempts</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4">
                {draft.retryDelays.map((delay, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-sm font-medium text-muted-foreground">Attempt {i + 1}:</span>
                    <Input
                      type="number"
                      min={1}
                      value={delay}
                      onChange={(e) => {
                        const newDelays = [...draft.retryDelays];
                        newDelays[i] = parseInt(e.target.value) || 1;
                        setDraft((prev) => ({ ...prev, retryDelays: newDelays }));
                      }}
                      className="w-20 text-center bg-background/50"
                    />
                  </div>
                ))}
                <span className="text-sm text-muted-foreground ml-2">seconds</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
