import { useState, useEffect } from 'react';
import api from '../lib/ipc';
import type { RepoMeta, AppConfig } from '@shared/types';
import { Button } from '@shared/components/ui/button';
import { Input } from '@shared/components/ui/input';
import { Label } from '@shared/components/ui/label';
import { FolderOpen, CheckCircle2, Loader2, Clock } from 'lucide-react';

interface RepoPickerProps {
  config: AppConfig;
  value: string;
  onChange: (path: string, meta: RepoMeta | null) => void;
}

export default function RepoPicker({ config, value, onChange }: RepoPickerProps) {
  const [repoMeta, setRepoMeta] = useState<RepoMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (value) {
      queueMicrotask(() => {
        if (cancelled) return;
        setLoading(true);
        setError(null);
      });

      api()
        .getRepoMeta(value)
        .then((meta) => {
          if (cancelled) return;
          setRepoMeta(meta);
          setLoading(false);
          if (!meta) setError('Not a valid git repository');
        })
        .catch(() => {
          if (cancelled) return;
          setLoading(false);
          setError('Failed to read repo info');
        });
    } else {
      queueMicrotask(() => {
        if (cancelled) return;
        setRepoMeta(null);
        setLoading(false);
        setError(null);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [value]);

  const handleBrowse = async () => {
    const result = await api().pickFolder();
    if (!result) return;
    if ('error' in result) {
      setError(result.error);
      return;
    }
    onChange(result.path, result.meta);
    if (result.meta) {
      setRepoMeta(result.meta);
      setError(null);
    }
  };

  const handleRecentSelect = (repoPath: string) => {
    onChange(repoPath, null);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="repo-path" className="text-muted-foreground">Repository Path</Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              id="repo-path"
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value, null)}
              placeholder="/path/to/repo"
              className="pr-10 bg-background/50 backdrop-blur-sm"
            />
            {loading && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
            )}
          </div>
          <Button
            variant="secondary"
            onClick={handleBrowse}
            className="bg-secondary/50 hover:bg-secondary/80 backdrop-blur-sm"
          >
            <FolderOpen className="w-4 h-4 mr-2" />
            Browse
          </Button>
        </div>
      </div>

      {error && <p className="text-xs text-destructive animate-in fade-in">{error}</p>}

      {repoMeta && !error && (
        <div className="text-xs text-muted-foreground flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
          <span className="font-medium text-foreground/80">{repoMeta.nameWithOwner}</span>
          <span className="text-muted-foreground/50">•</span>
          <span>branch: <span className="font-mono text-foreground/70">{repoMeta.mainBranch}</span></span>
        </div>
      )}

      {config.recentRepos.length > 0 && !value && (
        <div className="space-y-2 animate-in fade-in">
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            Recent repositories
          </div>
          <div className="flex flex-wrap gap-1.5">
            {config.recentRepos.slice(0, 8).map((repo) => (
              <Button
                key={repo}
                variant="outline"
                size="sm"
                onClick={() => handleRecentSelect(repo)}
                className="h-7 px-2.5 text-xs bg-background/30 hover:bg-accent/50 border-border/50 truncate max-w-[200px] transition-all"
              >
                {repo.split('/').pop()}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
