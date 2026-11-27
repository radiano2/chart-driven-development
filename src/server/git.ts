import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { HistoryEntry } from "../shared/types.ts";

const run = promisify(execFile);

const IDENTITY = ["-c", "user.name=Chart Driven Development", "-c", "user.email=cdd@localhost"];

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function hasIdentity(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ["config", "user.email"])).trim().length > 0;
  } catch {
    return false;
  }
}

export async function init(cwd: string): Promise<void> {
  await git(cwd, ["init", "-q", "-b", "main"]);
}

/** Stage everything and commit. Returns false when there was nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(cwd, ["add", "-A"]);
  const status = await git(cwd, ["status", "--porcelain"]);
  if (!status.trim()) return false;
  const id = (await hasIdentity(cwd)) ? [] : IDENTITY;
  await git(cwd, [...id, "commit", "-q", "-m", message]);
  return true;
}

/** Paths with uncommitted changes (including untracked files). */
export async function changedFiles(cwd: string): Promise<string[]> {
  // -z: names come raw (no quoting or escaping of spaces and non-ASCII). A rename is "R  new\0old\0".
  const out = await git(cwd, ["status", "--porcelain", "-z", "-uall"]);
  const parts = out.split("\0");
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++; // skip the old name
  }
  return files;
}

/** Diff of uncommitted changes, untracked files included. */
export async function workingDiff(cwd: string): Promise<string> {
  await git(cwd, ["add", "-A", "--intent-to-add"]);
  return git(cwd, ["diff", "HEAD"]);
}

export async function history(cwd: string, limit = 50): Promise<HistoryEntry[]> {
  try {
    const out = await git(cwd, ["log", `-${limit}`, "--pretty=format:%H%x1f%s%x1f%cI"]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, message, date] = l.split("\x1f");
        return { sha, message, date };
      });
  } catch {
    return [];
  }
}

/**
 * Restore the whole project (code + chart) to how it was at `sha`, as a new commit.
 * History is never rewritten, so a restore can itself be undone.
 */
export async function restore(cwd: string, sha: string, message: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("Invalid version id");
  // Load `sha`'s tree into the index and write it out.
  await git(cwd, ["read-tree", sha]);
  await git(cwd, ["checkout-index", "-a", "-f"]);
  // Files added after `sha` are now untracked: delete them (ignored files are kept).
  await git(cwd, ["clean", "-f", "-d", "-q", "-e", "node_modules"]);
  return commitAll(cwd, message);
}

/** The top folder of the git repo `cwd` is in, or null when it isn't in one. */
export async function topLevel(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

/** Current branch name, or null for a detached HEAD. */
export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["symbolic-ref", "-q", "--short", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

/** True while a merge, rebase, cherry-pick or revert is half done. */
export async function midOperation(cwd: string): Promise<boolean> {
  for (const name of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    try {
      const p = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", name])).trim();
      if (existsSync(p)) return true;
    } catch {
      /* older git: fall through */
    }
  }
  return false;
}

/** Tracked and untracked (not ignored) files, as paths relative to `cwd`. */
export async function listFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  return [...new Set(out.split("\0").filter(Boolean))];
}

/** True when `sha` has `file` in it. */
export async function hasFileAt(cwd: string, sha: string, file: string): Promise<boolean> {
  try {
    await git(cwd, ["cat-file", "-e", `${sha}:${file}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A fingerprint of the committed code (the chart's own .chart folder left out): it changes exactly when a commit
 * changes the code. Uncommitted outside edits count once they're kept or read into the chart (both commit them).
 */
export async function codeFingerprint(cwd: string): Promise<string> {
  let out: string;
  try {
    out = await git(cwd, ["ls-tree", "-r", "-z", "HEAD"]);
  } catch {
    return "empty"; // no commits yet
  }
  const lines = out.split("\0").filter((l) => l && !/\t\.chart\//.test(l));
  return createHash("sha1").update(lines.join("\n")).digest("hex");
}
