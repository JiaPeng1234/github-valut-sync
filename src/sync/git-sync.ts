import * as git from "isomorphic-git";
import { requestUrl, DataAdapter } from "obsidian";
import { createFsAdapter } from "./fs-adapter";
import {
  GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL,
  DEFAULT_BRANCH,
} from "../constants";
import { ConflictFile, SyncResult } from "../types";

// Custom HTTP client that uses Obsidian's requestUrl (mobile-safe, bypasses CORS)
const gitHttp = {
  async request({ url, method, headers, body }: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: AsyncIterableIterator<Uint8Array>;
  }) {
    let bodyBuffer: ArrayBuffer | undefined;
    if (body) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
      bodyBuffer = merged.buffer;
    }

    const response = await requestUrl({
      url,
      method,
      headers,
      body: bodyBuffer,
      throw: false,
    });

    const arrayBuffer = response.arrayBuffer;
    async function* responseBody() {
      yield new Uint8Array(arrayBuffer);
    }

    return {
      url,
      method,
      statusCode: response.status,
      statusMessage: "OK",
      body: responseBody(),
      headers: response.headers as Record<string, string>,
    };
  },
};

export class GitSync {
  private fs: ReturnType<typeof createFsAdapter>;
  private dir: string;
  private token: string;
  private username: string;
  private remoteUrl: string;

  constructor(
    adapter: DataAdapter,
    vaultPath: string,
    token: string,
    username: string,
    repoName: string
  ) {
    this.fs = createFsAdapter(adapter, vaultPath);
    this.dir = vaultPath;
    this.token = token;
    this.username = username;
    this.remoteUrl = `https://github.com/${username}/${repoName}.git`;
  }

  /** Base options shared by ALL git operations (local and network) */
  private gitOpts() {
    return {
      fs: this.fs,
      http: gitHttp,
      dir: this.dir,
      author: { name: GIT_AUTHOR_NAME, email: GIT_AUTHOR_EMAIL },
    };
  }

  /**
   * Extra options for NETWORK operations (push / fetch / clone).
   *
   * isomorphic-git strips credentials from remote URLs before sending requests.
   * We must supply them via `onAuth` so every push/fetch is authenticated.
   * We also pass `url` directly so the library does not have to read `.git/config`.
   */
  private netOpts() {
    const token = this.token;
    const username = this.username;
    return {
      ...this.gitOpts(),
      url: this.remoteUrl,
      onAuth: () => ({ username, password: token }),
      onAuthFailure: () => {
        throw new Error("GitHub authentication failed. Please reconnect your account in MultiSync settings.");
      },
    };
  }

  /** Returns true if .git exists and HEAD resolves (repo is initialised) */
  async isInitialized(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns true if refs/heads/main exists (at least one commit has been made).
   * Returns false on a fresh git.init with no commits (unborn branch).
   */
  async hasLocalBranch(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.fs, dir: this.dir, ref: DEFAULT_BRANCH });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch from origin. Returns the FETCH_HEAD oid when remote has commits,
   * or null when the remote is empty or unreachable.
   */
  private async safeFetch(): Promise<string | null> {
    try {
      // git.fetch returns the fetched head oid directly. isomorphic-git does not
      // reliably write a FETCH_HEAD ref (especially with a custom fs), so use the
      // return value; fall back to the remote-tracking ref it *does* update.
      const res = await git.fetch({
        ...this.netOpts(),
        ref: DEFAULT_BRANCH,
        singleBranch: true,
      });
      if (res.fetchHead) return res.fetchHead;

      // Fallback: read refs/remotes/origin/main (updated by fetch).
      return await git.resolveRef({
        fs: this.fs,
        dir: this.dir,
        ref: `refs/remotes/origin/${DEFAULT_BRANCH}`,
      });
    } catch (e) {
      // Surface WHY fetch failed instead of silently swallowing it.
      const code = (e as { code?: string })?.code ?? "?";
      const m = e instanceof Error ? e.message : String(e);
      this.lastFetchError = `fetch failed code=${code} msg=${m}`;
      return null;
    }
  }

  /** Set by safeFetch when a fetch attempt throws; read by sync() for logging. */
  private lastFetchError: string | null = null;

  /**
   * Clone the remote into the vault directory.
   * Returns true if the clone produced a usable local branch (non-empty remote).
   */
  async clone(): Promise<boolean> {
    await git.clone({
      ...this.netOpts(),
      singleBranch: true,
      depth: 1,
    });
    return this.hasLocalBranch();
  }

  /**
   * First-time setup: init locally (if needed), commit everything, push.
   * Safe to call on a partially-initialised repo (retry after failure).
   */
  async initAndPush(vaultFiles: string[]): Promise<void> {
    const alreadyInited = await this.isInitialized();
    if (!alreadyInited) {
      await git.init({ fs: this.fs, dir: this.dir, defaultBranch: DEFAULT_BRANCH });
    }

    // Stage all vault files (skip any that fail)
    for (const file of vaultFiles) {
      try {
        await git.add({ fs: this.fs, dir: this.dir, filepath: file });
      } catch {
        // Skip un-stageable files (binary, permission issues, etc.)
      }
    }

    const localBranchExists = await this.hasLocalBranch();
    if (!localBranchExists) {
      // First-ever commit — create it unconditionally so refs/heads/main is written
      // even when the vault is empty.
      await git.commit({
        ...this.gitOpts(),
        message: "sync: initial vault snapshot",
      });
    } else {
      // Subsequent call (retry) — only commit if something changed
      const status = await git.statusMatrix({ fs: this.fs, dir: this.dir });
      const dirty = status.some(([, h, w, s]) => h !== 1 || w !== 1 || s !== 1);
      if (dirty) {
        await git.commit({
          ...this.gitOpts(),
          message: "sync: initial vault snapshot",
        });
      }
    }

    // Set up remote (delete+re-add to ensure correct fetch refspec)
    try {
      await git.deleteRemote({ fs: this.fs, dir: this.dir, remote: "origin" });
    } catch { /* didn't exist yet */ }
    await git.addRemote({
      fs: this.fs,
      dir: this.dir,
      remote: "origin",
      url: this.remoteUrl,
    });

    await git.push({
      ...this.netOpts(),
      ref: DEFAULT_BRANCH,
      force: false,
    });
  }

  /**
   * Full sync cycle — runs on every file change and manual sync trigger.
   *
   * Steps (each individually guarded to prevent one failure cascading):
   *   1. Stage all changed files
   *   2. Commit if dirty  (creates refs/heads/main on first run)
   *   3. Fetch from remote
   *   4. Merge FETCH_HEAD into local branch  (skipped if remote is empty)
   *   5. Detect conflicts
   *   6. Push  (skipped if conflicts or no local branch yet)
   */
  async sync(changedFiles: string[]): Promise<SyncResult> {
    const conflicts: ConflictFile[] = [];
    const logs: string[] = [];
    // Collect logs into an array (shown in a modal on mobile) AND console.log.
    const log = (m: string) => { logs.push(m); console.log(`[git-sync] ${m}`); };
    const short = (oid: string | null) => (oid ? oid.slice(0, 7) : String(oid));

    log(`sync() start — ${changedFiles.length} changed files`);

    try {
      // ── 1. Stage ─────────────────────────────────────────────────────────────
      for (const file of changedFiles) {
        try {
          await git.add({ fs: this.fs, dir: this.dir, filepath: file });
        } catch {
          try {
            await git.remove({ fs: this.fs, dir: this.dir, filepath: file });
          } catch { /* skip */ }
        }
      }
      log(`step1 stage done`);

      // ── 2. Commit if dirty ───────────────────────────────────────────────────
      // Wrap statusMatrix: some isomorphic-git versions throw on an unborn branch.
      let hasDirty: boolean;
      try {
        const matrix = await git.statusMatrix({ fs: this.fs, dir: this.dir });
        const dirtyRows = matrix.filter(([, h, w, s]) => h !== 1 || w !== 1 || s !== 1);
        hasDirty = dirtyRows.length > 0;
        // Show exactly WHICH files are dirty and their H/W/S codes (first 20).
        log(`step2 dirty=${dirtyRows.length}/${matrix.length}`);
        for (const [fp, h, w, s] of dirtyRows.slice(0, 20)) {
          log(`step2   ${fp} H=${h} W=${w} S=${s}`);
        }
        if (dirtyRows.length > 20) log(`step2   ...+${dirtyRows.length - 20} more`);
      } catch (e) {
        // Fall back: assume dirty when files were changed
        hasDirty = changedFiles.length > 0;
        log(`step2 statusMatrix THREW: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (hasDirty) {
        // Record the tree BEFORE committing so we can tell if the commit is a
        // phantom (identical tree = nothing really changed).
        let treeBefore = "?";
        try {
          const cur = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: DEFAULT_BRANCH });
          const c = await git.readCommit({ fs: this.fs, dir: this.dir, oid: cur });
          treeBefore = c.commit.tree;
        } catch { /* unborn branch */ }

        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        const oid = await git.commit({
          ...this.gitOpts(),
          message: `sync: ${now}`,
        });
        const newCommit = await git.readCommit({ fs: this.fs, dir: this.dir, oid });
        const treeAfter = newCommit.commit.tree;
        log(`step2 committed local=${short(oid)} treeBefore=${short(treeBefore)} treeAfter=${short(treeAfter)} phantom=${treeBefore === treeAfter}`);
        // refs/heads/main is now guaranteed to exist
      }

      // ── 3. Fetch ─────────────────────────────────────────────────────────────
      this.lastFetchError = null;
      const fetchHead = await this.safeFetch();
      log(`step3 fetchHead=${short(fetchHead)}`);
      if (fetchHead === null && this.lastFetchError) {
        log(`step3 ${this.lastFetchError}`);
      }

      // ── 4. Merge ─────────────────────────────────────────────────────────────
      if (fetchHead && (await this.hasLocalBranch())) {
        const localHead = await git.resolveRef({
          fs: this.fs,
          dir: this.dir,
          ref: DEFAULT_BRANCH,
        });
        log(`step4 localHead=${short(localHead)} fetchHead=${short(fetchHead)} equal=${localHead === fetchHead}`);

        if (fetchHead !== localHead) {
          try {
            const mergeRes = await git.merge({
              fs: this.fs,
              dir: this.dir,
              ours: DEFAULT_BRANCH,
              theirs: fetchHead,
              author: { name: GIT_AUTHOR_NAME, email: GIT_AUTHOR_EMAIL },
              message: "sync: merge remote changes",
              fastForwardOnly: false,
            });
            log(`step4 mergeRes=${JSON.stringify(mergeRes)}`);
            const headAfterMerge = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: DEFAULT_BRANCH });
            log(`step4 main-after-merge=${short(headAfterMerge)}`);
          } catch (mergeErr) {
            const code = (mergeErr as { code?: string })?.code ?? "?";
            const m = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
            log(`step4 MERGE THREW code=${code} msg=${m}`);
            throw mergeErr;
          }
        }
      }

      // ── 5. Detect conflicts ──────────────────────────────────────────────────
      if (await this.hasLocalBranch()) {
        const statusAfter = await git.statusMatrix({ fs: this.fs, dir: this.dir });
        for (const [filepath, head, workdir, stage] of statusAfter) {
          if (stage === 2 || (head === 0 && workdir === 2 && stage === 0)) {
            const ours   = await this.readFileContent(filepath);
            const theirs = await this.readRemoteFileContent(filepath);
            conflicts.push({ path: filepath, ours, theirs });
          }
        }
      }
      log(`step5 conflicts=${conflicts.length}`);

      // ── 6. Push ──────────────────────────────────────────────────────────────
      if (conflicts.length === 0 && (await this.hasLocalBranch())) {
        const pushRef = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: DEFAULT_BRANCH });
        log(`step6 pushing main=${short(pushRef)}`);
        try {
          const pushRes = await git.push({
            ...this.netOpts(),
            ref: DEFAULT_BRANCH,
          });
          log(`step6 pushRes=${JSON.stringify(pushRes?.ok ?? pushRes)}`);
        } catch (pushErr) {
          const code = (pushErr as { code?: string })?.code ?? "?";
          const m = pushErr instanceof Error ? pushErr.message : String(pushErr);
          log(`step6 PUSH THREW code=${code} msg=${m}`);
          throw pushErr;
        }
      }

      log(`sync() OK conflicts=${conflicts.length}`);
      return { success: conflicts.length === 0, conflictFiles: conflicts, logs };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log(`sync() FAILED: ${msg}`);
      return { success: false, conflictFiles: [], error: msg, logs };
    }
  }

  /** Resolve a conflict by writing resolved content, committing, and pushing */
  async resolveConflict(filepath: string, resolvedContent: string): Promise<void> {
    const fullPath = `${this.dir}/${filepath}`;
    await this.fs.promises.writeFile(fullPath, resolvedContent);
    await git.add({ fs: this.fs, dir: this.dir, filepath });
    await git.commit({
      ...this.gitOpts(),
      message: `sync: resolve conflict in ${filepath}`,
    });
    await git.push({
      ...this.netOpts(),
      ref: DEFAULT_BRANCH,
    });
  }

  /**
   * Pull-only — used on vault open to get latest without pushing.
   * Uses explicit fetch + merge (not git.pull) for consistent error handling.
   */
  async pull(): Promise<void> {
    if (!(await this.hasLocalBranch())) return;

    const fetchHead = await this.safeFetch();
    if (!fetchHead) return;

    const localHead = await git.resolveRef({
      fs: this.fs,
      dir: this.dir,
      ref: DEFAULT_BRANCH,
    });

    if (fetchHead !== localHead) {
      await git.merge({
        fs: this.fs,
        dir: this.dir,
        ours: DEFAULT_BRANCH,
        theirs: fetchHead,
        author: { name: GIT_AUTHOR_NAME, email: GIT_AUTHOR_EMAIL },
        message: "sync: merge remote changes",
        fastForwardOnly: false,
      });
    }
  }

  private async readFileContent(filepath: string): Promise<string> {
    try {
      const buf = await this.fs.promises.readFile(
        `${this.dir}/${filepath}`,
        { encoding: "utf8" }
      );
      return buf as string;
    } catch {
      return "";
    }
  }

  private async readRemoteFileContent(filepath: string): Promise<string> {
    try {
      const remoteCommit = await git.resolveRef({
        fs: this.fs,
        dir: this.dir,
        ref: `refs/remotes/origin/${DEFAULT_BRANCH}`,
      });
      const { blob } = await git.readBlob({
        fs: this.fs,
        dir: this.dir,
        oid: remoteCommit,
        filepath,
      });
      return new TextDecoder().decode(blob);
    } catch {
      return "";
    }
  }
}
