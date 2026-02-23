import { spawnSync } from 'child_process';
import type { LaunchRequirements, ToolReadiness } from '../shared/types';

type CommandResult = {
  found: boolean;
  ok: boolean;
  output: string;
};

function runCommand(command: string, args: string[], timeout = 15000): CommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    timeout,
    maxBuffer: 1024 * 1024,
  });

  const err = result.error as NodeJS.ErrnoException | undefined;
  const found = !err || err.code !== 'ENOENT';
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n').trim();

  return {
    found,
    ok: !err && result.status === 0,
    output,
  };
}

function truncateDetails(value: string): string {
  if (!value) return '';
  return value.length > 400 ? `${value.slice(0, 397)}...` : value;
}

function checkGhReadiness(): ToolReadiness {
  const version = runCommand('gh', ['--version']);
  if (!version.found) {
    return {
      installed: false,
      authenticated: false,
      hint: 'Install GitHub CLI, then run: gh auth login',
      details: null,
    };
  }

  const auth = runCommand('gh', ['auth', 'status']);
  const authenticated = auth.ok || /Active account:\s*true/i.test(auth.output);

  return {
    installed: true,
    authenticated,
    hint: authenticated ? 'Ready' : 'Authenticate GitHub CLI: gh auth login',
    details: authenticated ? null : truncateDetails(auth.output) || 'No active GitHub CLI account found.',
  };
}

function checkOpencodeReadiness(): ToolReadiness {
  const version = runCommand('opencode', ['--version']);
  if (!version.found) {
    return {
      installed: false,
      authenticated: false,
      hint: 'Install OpenCode CLI, then authenticate your provider account',
      details: null,
    };
  }

  const models = runCommand('opencode', ['models', 'github-copilot']);
  const authenticated = models.ok && /github-copilot\//i.test(models.output);

  return {
    installed: true,
    authenticated,
    hint: authenticated
      ? 'Ready'
      : 'Authenticate OpenCode CLI so model listing works for github-copilot',
    details:
      authenticated ? null : truncateDetails(models.output) || 'Unable to list OpenCode models for github-copilot.',
  };
}

export function checkLaunchRequirements(): LaunchRequirements {
  const gh = checkGhReadiness();
  const opencode = checkOpencodeReadiness();

  return {
    ready: gh.installed && gh.authenticated && opencode.installed && opencode.authenticated,
    checkedAt: Date.now(),
    gh,
    opencode,
  };
}
