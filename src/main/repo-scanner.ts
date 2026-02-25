import { execFile } from 'child_process';
import { promisify } from 'util';
import type { RepoMeta, RepoOpenPr, RepoBranchLookup } from '../shared/types';

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

export async function listRepoBranches(repoPath: string): Promise<{ branches: string[]; current: string | null }> {
  try {
    const isValid = await validateRepo(repoPath);
    if (!isValid) return { branches: [], current: null };

    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    const branches = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    let current: string | null = null;
    try {
      const currentResult = await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = currentResult.stdout.trim();
      if (branch && branch !== 'HEAD') {
        current = branch;
      }
    } catch {
      // Detached HEAD or lookup failure.
    }

    return { branches, current };
  } catch {
    return { branches: [], current: null };
  }
}

export async function listMyOpenPullRequests(repoPath: string): Promise<RepoOpenPr[]> {
  try {
    const isValid = await validateRepo(repoPath);
    if (!isValid) return [];

    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'list',
        '--author',
        '@me',
        '--state',
        'open',
        '--json',
        'number,title,url,headRefName,baseRefName',
      ],
      { cwd: repoPath }
    );

    const parsed = JSON.parse(stdout) as Array<{
      number?: number;
      title?: string;
      url?: string;
      headRefName?: string;
      baseRefName?: string;
    }>;

    return parsed
      .filter((item) =>
        typeof item.number === 'number'
        && !!item.title
        && !!item.url
        && !!item.headRefName
        && !!item.baseRefName
      )
      .map((item) => ({
        number: item.number as number,
        title: item.title as string,
        url: item.url as string,
        headRefName: item.headRefName as string,
        baseRefName: item.baseRefName as string,
      }));
  } catch {
    return [];
  }
}

export async function lookupRepoBranch(repoPath: string, branch: string): Promise<RepoBranchLookup> {
  const trimmedBranch = branch.trim();
  if (!trimmedBranch) {
    return {
      branch: '',
      exists: false,
      local: false,
      remote: false,
      remoteRef: null,
    };
  }

  try {
    const isValid = await validateRepo(repoPath);
    if (!isValid) {
      return {
        branch: trimmedBranch,
        exists: false,
        local: false,
        remote: false,
        remoteRef: null,
      };
    }

    let local = false;
    try {
      await execFileAsync('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${trimmedBranch}`]);
      local = true;
    } catch {
      local = false;
    }

    let remoteRef: string | null = null;
    try {
      const { stdout } = await execFileAsync('git', ['-C', repoPath, 'ls-remote', '--heads', 'origin', trimmedBranch]);
      const line = stdout
        .split('\n')
        .map((entry) => entry.trim())
        .find(Boolean);
      if (line && line.endsWith(`refs/heads/${trimmedBranch}`)) {
        remoteRef = `origin/${trimmedBranch}`;
      }
    } catch {
      remoteRef = null;
    }

    const remote = !!remoteRef;

    return {
      branch: trimmedBranch,
      exists: local || remote,
      local,
      remote,
      remoteRef,
    };
  } catch {
    return {
      branch: trimmedBranch,
      exists: false,
      local: false,
      remote: false,
      remoteRef: null,
    };
  }
}
