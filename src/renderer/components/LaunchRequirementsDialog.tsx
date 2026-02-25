import { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { LaunchRequirements } from '@shared/types';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@shared/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@shared/components/ui/card';
import { Badge } from '@shared/components/ui/badge';
import { Button } from '@shared/components/ui/button';
import api from '../lib/ipc';

type LaunchRequirementsDialogProps = {
  requirements: LaunchRequirements | null;
  checking: boolean;
  onRecheck: () => Promise<void>;
};

export default function LaunchRequirementsDialog({
  requirements,
  checking,
  onRecheck,
}: LaunchRequirementsDialogProps) {
  const open = checking || (requirements ? !requirements.ready : false);

  const issues = useMemo(() => {
    if (!requirements) return [];

    return [
      {
        key: 'opencode',
        name: 'OpenCode CLI',
        installUrl: 'https://opencode.ai/docs',
        authUrl: 'https://opencode.ai/docs',
        installCommand: 'See installation steps in OpenCode docs',
        authCommand: 'opencode models github-copilot',
        status: requirements.opencode,
      },
      {
        key: 'gh',
        name: 'GitHub CLI',
        installUrl: 'https://cli.github.com/',
        authUrl: 'https://cli.github.com/manual/gh_auth_login',
        installCommand: 'brew install gh',
        authCommand: 'gh auth login',
        status: requirements.gh,
      },
    ];
  }, [requirements]);

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-[700px]"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            Complete setup before using CodeLoop
          </DialogTitle>
        </DialogHeader>

        {checking ? (
          <div className="py-10 flex items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
            Checking CLI installation and authentication...
          </div>
        ) : (
          <div className="space-y-4">
            {issues.map((item) => {
              const installOk = item.status.installed;
              const authOk = item.status.authenticated;

              return (
                <Card key={item.key} className="border-border/60">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center justify-between">
                      <span>{item.name}</span>
                      {installOk && authOk ? (
                        <Badge variant="secondary" className="gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Ready
                        </Badge>
                      ) : (
                        <Badge variant="destructive">Action Required</Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge variant={installOk ? 'secondary' : 'outline'}>
                        {installOk ? 'Installed' : 'Not Installed'}
                      </Badge>
                      {!installOk && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            void api().openUrl(item.installUrl);
                          }}
                        >
                          Install Guide
                        </Button>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <Badge variant={authOk ? 'secondary' : 'outline'}>
                        {authOk ? 'Authenticated' : 'Not Authenticated'}
                      </Badge>
                      {installOk && !authOk && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            void api().openUrl(item.authUrl);
                          }}
                        >
                          Auth Guide
                        </Button>
                      )}
                    </div>

                    {!installOk && (
                      <div className="text-muted-foreground">
                        Command: <span className="font-mono">{item.installCommand}</span>
                      </div>
                    )}
                    {installOk && !authOk && (
                      <div className="text-muted-foreground">
                        Command: <span className="font-mono">{item.authCommand}</span>
                      </div>
                    )}
                    {item.status.details && (
                      <div className="rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground whitespace-pre-wrap break-words">
                        {item.status.details}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button onClick={() => void onRecheck()} disabled={checking}>
            {checking ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Checking
              </>
            ) : (
              'I finished setup, re-check'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
