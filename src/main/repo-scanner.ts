import { execFile } from 'child_process';
import { promisify } from 'util';
import type { RepoMeta } from '../shared/types';

const execFileAsync = promisify(execFile);

export async function validateRepo(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function getRepoMeta(repoPath: string): Promise<RepoMeta | null> {
  try {
    const isValid = await validateRepo(repoPath);
    if (!isValid) return null;

    // Get remote URL
    let remoteUrl = '';
    try {
      const { stdout } = await execFileAsync('git', ['-C', repoPath, 'config', '--get', 'remote.origin.url']);
      remoteUrl = stdout.trim();
    } catch {
      // No remote
    }

    // Get nameWithOwner via gh
    let nameWithOwner = '';
    let owner = '';
    let name = '';
    try {
      const { stdout } = await execFileAsync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
        cwd: repoPath,
      });
      nameWithOwner = stdout.trim();
      const parts = nameWithOwner.split('/');
      owner = parts[0] || '';
      name = parts[1] || '';
    } catch {
      // Fallback: extract from remote URL
      const match = remoteUrl.match(/[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
      if (match) {
        owner = match[1];
        name = match[2];
        nameWithOwner = `${owner}/${name}`;
      } else {
        // Use directory name as fallback
        name = repoPath.split('/').pop() || 'unknown';
        nameWithOwner = name;
      }
    }

    // Detect main branch
    let mainBranch = 'main';
    try {
      await execFileAsync('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', 'refs/heads/main']);
    } catch {
      mainBranch = 'master';
    }

    return {
      path: repoPath,
      name,
      owner,
      nameWithOwner,
      remoteUrl,
      mainBranch,
    };
  } catch {
    return null;
  }
}

export async function listSupportedModels(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('opencode', ['models', 'github-copilot'], { timeout: 30000 });
    return stdout
      .split('\n')
      .filter((line) => line.startsWith('github-copilot/'))
      .sort();
  } catch {
    return [];
  }
}
