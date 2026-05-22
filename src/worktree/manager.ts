import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

export interface WorktreeOptions {
  baseRef?: string;
  setupCommand?: string;
  archiveOnTeardown?: boolean;
}

export class WorktreeManager {
  private active: Map<string, string> = new Map();

  /**
   * Create a git worktree for a meeting. Returns the absolute path.
   * Throws if not in a git repo or if creation fails.
   */
  create(meetingId: string, baseDir: string, options?: WorktreeOptions): string {
    const dir = resolve(baseDir, 'worktrees', meetingId);

    // Verify we're in a git repo
    try {
      execSync('git rev-parse --git-dir', { stdio: 'ignore' });
    } catch {
      throw new Error('Cannot create worktree: not inside a git repository');
    }

    // Check if the worktree already exists on disk from a previous crashed run
    if (existsSync(dir)) {
      try {
        execSync(`git worktree remove --force "${dir}"`, { stdio: 'ignore' });
      } catch {
        // If it can't be removed via git, just rm it
        execSync(`rm -rf "${dir}"`, { stdio: 'ignore' });
      }
    }

    const baseRef = options?.baseRef ?? 'HEAD';
    execSync(`git worktree add "${dir}" "${baseRef}"`, { stdio: 'ignore' });

    this.active.set(meetingId, dir);
    return dir;
  }

  /** Run an optional setup command inside the worktree. */
  setup(worktreePath: string, setupCommand?: string): void {
    if (!setupCommand) return;
    execSync(setupCommand, { cwd: worktreePath, stdio: 'inherit' });
  }

  /**
   * Teardown: either archive changes to a branch, then remove the worktree.
   * Always removes the worktree entry from git.
   */
  teardown(meetingId: string, worktreePath: string, options?: WorktreeOptions): void {
    if (options?.archiveOnTeardown && this.hasChanges(worktreePath)) {
      this.archive(worktreePath, meetingId);
    }

    try {
      execSync(`git worktree remove --force "${worktreePath}"`, { stdio: 'ignore' });
    } catch {
      // If git can't remove it, force-delete
      execSync(`rm -rf "${worktreePath}"`, { stdio: 'ignore' });
      // Then prune the worktree reference
      try {
        execSync('git worktree prune', { stdio: 'ignore' });
      } catch { /* best effort */ }
    }

    this.active.delete(meetingId);
  }

  /** Commit worktree changes to a meeting/<id> branch and push. */
  private archive(worktreePath: string, meetingId: string): void {
    const branch = `meeting/${meetingId}`;
    try {
      execSync(`git -C "${worktreePath}" add -A`, { stdio: 'ignore' });
      execSync(
        `git -C "${worktreePath}" commit -m "meeting: archive worktree for ${meetingId}" --allow-empty`,
        { stdio: 'ignore' }
      );
      // Push the branch from the worktree
      execSync(`git -C "${worktreePath}" push origin "${branch}"`, { stdio: 'ignore' });
    } catch {
      // Archive is best-effort — don't block teardown
    }
  }

  /** Check if the worktree has uncommitted changes. */
  private hasChanges(worktreePath: string): boolean {
    try {
      const out = execSync(`git -C "${worktreePath}" status --porcelain`, { encoding: 'utf-8' });
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Get the worktree path for an active meeting, if any. */
  get(meetingId: string): string | undefined {
    return this.active.get(meetingId);
  }

  /** Clean up all active worktrees (on server shutdown). */
  shutdown(): void {
    for (const [meetingId, path] of this.active) {
      this.teardown(meetingId, path);
    }
    this.active.clear();
  }
}