import type { LogEntry } from '@shared/types';

export interface SubAgentActivity {
  active: boolean;
  task: string | null;
}

function cleanTaskLabel(message: string): string {
  return message
    .replace(/^•\s*/, '')
    .replace(/\s*Explore Agent\s*$/i, '')
    .trim();
}

function isBulletTask(message: string): boolean {
  return message.trimStart().startsWith('•');
}

function isExploreAgentTask(message: string): boolean {
  return /\bExplore Agent\b/i.test(message);
}

export function getSubAgentActivity(logs: LogEntry[]): SubAgentActivity {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const message = logs[i]?.message ?? '';
    if (!isBulletTask(message)) continue;

    if (isExploreAgentTask(message)) {
      const task = cleanTaskLabel(message);
      return {
        active: true,
        task: task || null,
      };
    }

    return { active: false, task: null };
  }

  return { active: false, task: null };
}