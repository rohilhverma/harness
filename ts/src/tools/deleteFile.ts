import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import type { EditFileResult, ToolDefinition } from "../interfaces.js";

export function createDeleteFileTool(workspaceRoot: string): ToolDefinition {
  const root = realpathSync(workspaceRoot);
  return {
    name: "delete_file",
    description: "Delete one existing UTF-8 regular file inside the workspace. Read its entire contents with read_file, including all pages, and wait before deleting. Rejects directories, symbolic links and changes since the read.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative file path." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args, context): Promise<EditFileResult> {
      const path = typeof args.path === "string" ? args.path : "";
      if (!path || isAbsolute(path)) {
        return { ok: false, path, error: "path must be a nonempty relative file path." };
      }
      try {
        const target = resolve(root, path);
        const lexical = relative(root, target);
        if (!lexical || lexical === ".." || lexical.startsWith(".." + sep) || isAbsolute(lexical)) {
          throw new Error("The file must be inside the workspace.");
        }
        const parent = await realpath(dirname(target));
        const resolved = relative(root, parent);
        if (resolved === ".." || resolved.startsWith(".." + sep) || isAbsolute(resolved)) {
          throw new Error("The parent directory is outside the workspace.");
        }
        const entry = join(parent, basename(target));
        if (!(await lstat(entry)).isFile()) throw new Error("The path must be a regular file, not a directory or symbolic link.");
        const file = await realpath(entry);
        const coverage = context.readRanges.get(file);
        context.readRanges.delete(file);
        if (!coverage || !coverage.ranges.some((range) => range.turn < context.turn)) {
          throw new Error("Read the entire file with read_file and wait before deleting.");
        }
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(file));
        if (coverage.version !== createHash("sha256").update(text).digest("hex")) {
          throw new Error("The file changed since it was read. Read it again.");
        }
        const lineCount = (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).length;
        const ranges = coverage.ranges.filter((range) => range.turn < context.turn).sort((a, b) => a.start - b.start);
        let nextUnreadLine = 1;
        for (const range of ranges) {
          if (range.start > nextUnreadLine) break;
          nextUnreadLine = Math.max(nextUnreadLine, range.end + 1);
        }
        if (nextUnreadLine <= lineCount) throw new Error("Read every line, including remaining pages, before deleting.");
        await unlink(file);
        return { ok: true, path };
      } catch (error) {
        return { ok: false, path, error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) };
      }
    },
  };
}
