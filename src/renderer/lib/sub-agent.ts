import type { LogEntry } from '@shared/types';

export interface SubAgentActivity {
  active: boolean;
  task: string | null;
}

function normalizeTaskLabel(message: string): string {
  return message
    .trim()
    .replace(/^[•✓]\s*/, '')
    .trim();
}

export function getSubAgentActivity(logs: LogEntry[]): SubAgentActivity {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const message = (logs[i]?.message ?? '').trim();
    if (!/\bExplore Agent\b/i.test(message)) continue;

    if (message.startsWith('✓')) {
      return { active: false, task: null };
    }

    if (message.startsWith('•')) {
      const task = normalizeTaskLabel(message);
      return {
        active: true,
        task: task || null,
      };
    }
  }

  return { active: false, task: null };
}