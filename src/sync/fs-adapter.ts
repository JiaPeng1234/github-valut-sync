import { DataAdapter } from "obsidian";

type Stats = {
  type: "file" | "dir";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  // isomorphic-git requires these Node.js-style methods on stat results
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/**
 * Creates a fs-like object for isomorphic-git that wraps Obsidian's DataAdapter.
 * Paths passed by isomorphic-git are ABSOLUTE (prefixed with vaultPath).
 * We strip the vaultPath prefix before calling Obsidian's adapter (which uses relative paths).
 */
export function createFsAdapter(adapter: DataAdapter, vaultPath: string) {
  // DEBUG: capture a bounded sample of adapter calls so we can see, on mobile,
  // exactly what paths stat/readdir receive and what they return/throw.
  const dbg: string[] = [];
  const DBG_MAX = 40;
  const trace = (m: string) => { if (dbg.length < DBG_MAX) dbg.push(m); };
  (createFsAdapter as unknown as { lastTrace?: () => string[] }).lastTrace = () => dbg;

  /** Strip the vault root prefix so Obsidian adapter gets relative paths */
  function rel(absPath: string): string {
    const normalized = absPath.replace(/\\/g, "/");
    const base = vaultPath.replace(/\\/g, "/").replace(/\/$/, "");
    if (normalized.startsWith(base + "/")) {
      return normalized.slice(base.length + 1);
    }
    return normalized;
  }

  const promises = {
    async readFile(path: string, options?: { encoding?: string }): Promise<Buffer | string> {
      try {
        const content = await adapter.readBinary(rel(path));
        if (options?.encoding === "utf8") {
          return Buffer.from(content).toString("utf8");
        }
        return Buffer.from(content);
      } catch {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${path}'`);
        err.code = "ENOENT";
        throw err;
      }
    },

    async writeFile(path: string, data: string | Buffer | Uint8Array): Promise<void> {
      const relativePath = rel(path);
      // Ensure parent directory exists
      const parts = relativePath.split("/");
      if (parts.length > 1) {
        const dir = parts.slice(0, -1).join("/");
        try { await adapter.mkdir(dir); } catch { /* already exists */ }
      }
      if (typeof data === "string") {
        await adapter.write(relativePath, data);
      } else {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        await adapter.writeBinary(relativePath, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
      }
    },

    async unlink(path: string): Promise<void> {
      try {
        await adapter.remove(rel(path));
      } catch {
        /* ignore if not found */
      }
    },

    async readdir(path: string): Promise<string[]> {
      const r = rel(path);
      try {
        const result = await adapter.list(r);
        const files = result.files.map((f) => f.split("/").pop()!);
        const folders = result.folders.map((f) => f.split("/").pop()!);
        trace(`readdir in="${path}" rel="${r}" -> ${folders.length} dirs, ${files.length} files; sampleFile=${result.files[0] ?? "-"}`);
        return [...folders, ...files];
      } catch (e) {
        trace(`readdir ERR in="${path}" rel="${r}" msg=${e instanceof Error ? e.message : String(e)}`);
        const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, scandir '${path}'`);
        err.code = "ENOENT";
        throw err;
      }
    },

    async mkdir(path: string, _options?: unknown): Promise<void> {
      try {
        await adapter.mkdir(rel(path));
      } catch {
        /* already exists — ignore */
      }
    },

    async rmdir(_path: string): Promise<void> {
      /* isomorphic-git calls rmdir on cleanup — safe to no-op for now */
    },

    async stat(path: string): Promise<Stats> {
      const r = rel(path);
      try {
        const s = await adapter.stat(r);
        if (!s) { trace(`stat NULL in="${path}" rel="${r}"`); throw new Error("no stat"); }
        trace(`stat OK   in="${path}" rel="${r}" type=${s.type} size=${s.size}`);
        const isDir = s.type !== "file";
        return {
          type: isDir ? "dir" : "file",
          mode: isDir ? 0o040755 : 0o100644,
          size: s.size ?? 0,
          ino: 0,
          mtimeMs: s.mtime ?? Date.now(),
          ctimeMs: s.ctime ?? Date.now(),
          uid: 1,
          gid: 1,
          dev: 1,
          isFile: () => !isDir,
          isDirectory: () => isDir,
          isSymbolicLink: () => false,
        };
      } catch (e) {
        trace(`stat ERR  in="${path}" rel="${r}" msg=${e instanceof Error ? e.message : String(e)}`);
        const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, stat '${path}'`);
        err.code = "ENOENT";
        throw err;
      }
    },

    async lstat(path: string): Promise<Stats> {
      return promises.stat(path);
    },

    async readlink(path: string): Promise<string> {
      throw Object.assign(new Error(`EINVAL: readlink not supported '${path}'`), { code: "EINVAL" });
    },

    async symlink(): Promise<void> {
      throw Object.assign(new Error("EINVAL: symlink not supported"), { code: "EINVAL" });
    },

    async chmod(): Promise<void> {
      /* chmod is a no-op on mobile — isomorphic-git calls it but we can safely ignore */
    },
  };

  return { promises };
}
