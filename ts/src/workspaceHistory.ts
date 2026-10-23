import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_BYTES = 16 * 1024 * 1024;
const OMIT = new Set([".git", "node_modules", "build", "dist", ".ds_store"]);
const ROOT_OMIT = new Set(["sessions", "logs", "snapshots.git"]);
const TREE_ID = /^[0-9a-f]{40}$/;

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

// Raw Git objects preserve bytes without an index, attributes, filters or checkout.
export class WorkspaceHistory {
  readonly directory: string;
  private readonly gitDirectory: string;

  private constructor(private readonly catalogue: string, private readonly conversationId: string) {
    this.directory = join(catalogue, "sessions", conversationId, "workspace");
    this.gitDirectory = join(catalogue, "snapshots.git");
  }

  private git(args: string[], input?: Buffer, directory = this.gitDirectory): Promise<Buffer> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1" });
    return new Promise((resolve, reject) => {
      const child = execFile("git", ["--git-dir=" + directory,
        "-c", "core.hooksPath=/dev/null", "-c", "core.fsync=all", "-c", "core.fsyncMethod=fsync",
        "-c", "gc.autoDetach=false", "-c", "gc.auto=256", ...args],
      { cwd: this.catalogue, env, encoding: "buffer", maxBuffer: MAX_BYTES + 1024, timeout: 60_000 },
      (error, stdout, stderr) => error ? reject(new Error("Workspace Git failed: " + stderr.toString().slice(0, 2000), { cause: error })) : resolve(stdout));
      child.stdin?.on("error", () => {}); // The process callback reports a rejected/closed input pipe.
      child.stdin?.end(input);
    });
  }

  private async initialize(): Promise<void> {
    try { await lstat(this.gitDirectory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = this.gitDirectory + ".init-" + randomUUID();
      await mkdir(temporary, { mode: 0o700 });
      try {
        await this.git(["init", "--bare", "--object-format=sha1", "--template="], undefined, temporary);
        try { await rename(temporary, this.gitDirectory); await syncDirectory(this.catalogue); }
        catch (renameError) {
          if (!["EEXIST", "ENOTEMPTY"].includes((renameError as NodeJS.ErrnoException).code ?? "")) throw renameError;
        }
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    if (!(await lstat(this.gitDirectory)).isDirectory() ||
        await realpath(this.gitDirectory) !== this.gitDirectory ||
        (await this.git(["rev-parse", "--is-bare-repository", "--show-object-format"])).toString() !== "true\nsha1\n") {
      throw new Error("snapshots.git must be the harness's local bare SHA-1 repository.");
    }
  }

  static async create(catalogue: string, conversationId: string, sourceTree?: string) {
    const history = new WorkspaceHistory(catalogue, conversationId);
    const session = join(catalogue, "sessions", conversationId);
    if (await realpath(session) !== session) throw new Error("Session storage must use the canonical sessions directory, without links or case aliases.");
    await history.initialize();
    await mkdir(history.directory, { mode: 0o700 });
    const seed = sourceTree ?? await history.tree(catalogue);
    await history.materialize(seed, history.directory);
    if (sourceTree === undefined) {
      try {
        await writeFile(join(history.directory, "AGENT_TEST.md"),
          "# Agent test file\n\nStatus: not tested\nTest word: cobalt\n", { encoding: "utf8", flag: "wx", flush: true });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    await syncDirectory(history.directory);
    const baseline = sourceTree ?? await history.tree(history.directory);
    await history.retain(baseline, "baseline");
    return { history, baseline };
  }

  static async resume(catalogue: string, conversationId: string): Promise<WorkspaceHistory> {
    const history = new WorkspaceHistory(catalogue, conversationId);
    if (!(await lstat(history.directory)).isDirectory() || await realpath(history.directory) !== history.directory ||
        !(await lstat(history.gitDirectory)).isDirectory() || await realpath(history.gitDirectory) !== history.gitDirectory) {
      throw new Error("Saved workspace or snapshot repository is missing or was replaced; existing files were not restored over.");
    }
    return history;
  }

  private async tree(directory: string, root = true): Promise<string> {
    const entries: Buffer[] = [];
    for (const entry of (await readdir(directory, { withFileTypes: true, encoding: "buffer" })).sort((a, b) => a.name.compare(b.name))) {
      const name = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(entry.name);
      if (this.omitted(name, root)) continue;
      const path = join(directory, name);
      let mode: string;
      let type: string;
      let id: string;
      if (entry.isDirectory()) {
        mode = "040000"; type = "tree"; id = await this.tree(path, false);
      } else if (entry.isFile()) {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Unsupported workspace file (16 MiB limit): " + path);
        const bytes = await readFile(path);
        if (bytes.length > MAX_BYTES) throw new Error("Workspace file grew beyond 16 MiB: " + path);
        mode = stat.mode & 0o111 ? "100755" : "100644"; type = "blob";
        id = (await this.git(["hash-object", "-w", "--no-filters", "--stdin"], bytes)).toString().trim();
      } else { throw new Error("Workspace snapshots do not support links or special files: " + path); }
      if (!TREE_ID.test(id)) throw new Error("Invalid Git object identity.");
      entries.push(Buffer.from(mode + " " + type + " " + id + "\t" + name + "\0"));
    }
    return (await this.git(["mktree", "-z"], Buffer.concat(entries))).toString().trim();
  }

  private async object(type: "tree" | "blob", id: string): Promise<Buffer> {
    if (!TREE_ID.test(id)) throw new Error("Invalid saved workspace identity.");
    const bytes = await this.git(["cat-file", type, id]);
    const actual = createHash("sha1").update(type + " " + bytes.length + "\0").update(bytes).digest("hex");
    if (actual !== id) throw new Error("Corrupt saved workspace object: " + id);
    return bytes;
  }

  private async materialize(tree: string, directory: string): Promise<void> {
    const bytes = await this.object("tree", tree);
    let offset = 0;
    while (offset < bytes.length) {
      const space = bytes.indexOf(32, offset);
      const nul = bytes.indexOf(0, space + 1);
      if (space < offset || nul < space || nul + 21 > bytes.length) throw new Error("Invalid saved workspace tree.");
      const mode = bytes.subarray(offset, space).toString();
      const name = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(space + 1, nul));
      const id = bytes.subarray(nul + 1, nul + 21).toString("hex");
      if (!name || name === "." || name === ".." || name.includes("/")) throw new Error("Invalid saved workspace filename.");
      const path = join(directory, name);
      if (mode === "40000") {
        await mkdir(path, { mode: 0o700 });
        await this.materialize(id, path);
      } else if (mode === "100644" || mode === "100755") {
        await writeFile(path, await this.object("blob", id), { flag: "wx", flush: true, mode: mode === "100755" ? 0o755 : 0o644 });
      } else { throw new Error("Unsupported saved workspace mode: " + mode); }
      offset = nul + 21;
    }
    await syncDirectory(directory);
  }

  private omitted(name: string, root: boolean): boolean {
    const reserved = name.toLowerCase();
    return OMIT.has(reserved) || root && (ROOT_OMIT.has(reserved) || reserved.startsWith("snapshots.git.init-"));
  }

  private async containsExcluded(directory: string): Promise<boolean> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (this.omitted(entry.name, false) || entry.isDirectory() && await this.containsExcluded(join(directory, entry.name))) return true;
    }
    return false;
  }

  private async preflight(directory: string, target: string, root = true): Promise<void> {
    const names = await readdir(target);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (this.omitted(entry.name, root) || !entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      let destination;
      try { destination = await lstat(join(target, entry.name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if ((!destination || !destination.isDirectory() || !names.includes(entry.name)) && await this.containsExcluded(path)) {
        throw new Error("Rewind would replace or rename a directory containing excluded data: " + path);
      }
      if (destination?.isDirectory()) await this.preflight(path, join(target, entry.name), false);
    }
  }

  private async clearManaged(directory: string, root = true): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (this.omitted(entry.name, root)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.clearManaged(path, false);
        if (!(await readdir(path)).length) await rmdir(path);
      } else {
        if (!entry.isFile()) throw new Error("Unexpected link or special file during rewind: " + path);
        await rm(path);
      }
    }
    await syncDirectory(directory);
  }

  private async install(source: string, directory: string): Promise<void> {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const from = join(source, entry.name);
      if (entry.isDirectory()) {
        await mkdir(path, { recursive: true, mode: 0o700 });
        await this.install(from, path);
      } else {
        await writeFile(path, await readFile(from), { flag: "wx", flush: true,
          mode: (await lstat(from)).mode & 0o111 ? 0o755 : 0o644 });
      }
    }
    await syncDirectory(directory);
  }

  // Verify all target objects and exclusion conflicts before the caller publishes its journal.
  async restore(tree: string, beforeReplace?: () => Promise<void>): Promise<void> {
    const stage = join(this.catalogue, "sessions", this.conversationId, "restore-" + randomUUID());
    await mkdir(stage, { mode: 0o700 });
    try {
      await this.materialize(tree, stage);
      await this.preflight(this.directory, stage);
      await beforeReplace?.();
      await this.clearManaged(this.directory);
      await this.install(stage, this.directory);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }

  async capture(reason: "checkpoint" | "before-rewind" | "interrupted-rewind"): Promise<string> {
    const tree = await this.tree(this.directory);
    await this.retain(tree, reason);
    return tree;
  }

  private async retain(tree: string, reason: string): Promise<void> {
    const reference = "refs/harness/" + this.conversationId + "/" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + reason + "-" + randomUUID();
    await this.git(["update-ref", reference, tree]);
    // This readable index is a convenience; Git refs retain the authoritative snapshots.
    try {
      await appendFile(join(this.catalogue, "sessions", this.conversationId, "file-snapshots.md"),
        "- " + reason + " · " + new Date().toISOString() + " · tree `" + tree + "` · ref `" + reference + "`\n");
    } catch (error) { console.error("Could not update readable file snapshots:", error); }
    try { await this.git(["gc", "--auto", "--no-prune"]); }
    catch (error) { console.error("Snapshot packing failed; the saved snapshot remains retained:", error); }
  }
}
