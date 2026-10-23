import { realpathSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EditFileResult, ToolDefinition } from "../interfaces.js";

export function createCreateFileTool(workspaceRoot: string): ToolDefinition {
  const root = realpathSync(workspaceRoot);
  return {
    name: "create_file",
    description: "Create one UTF-8 file inside the workspace. Creates missing parent directories. Never overwrites an existing path. Read the new file to verify it.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative new file path." },
        content: { type: "string", description: "Complete UTF-8 file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(args, context): Promise<EditFileResult> {
      const path = typeof args.path === "string" ? args.path : "";
      if (!path || isAbsolute(path) || path.includes("\0") || typeof args.content !== "string") {
        return { ok: false, path, error: "Use a nonempty relative path and string content." };
      }
      try {
        const target = resolve(root, path);
        const lexical = relative(root, target);
        if (!lexical || lexical === ".." || lexical.startsWith(".." + sep) || isAbsolute(lexical)) {
          throw new Error("The new file must be inside the workspace.");
        }
        const parts = lexical.split(sep);
        let parent = root;
        for (const part of parts.slice(0, -1)) {
          const directory = join(parent, part);
          try { await mkdir(directory); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
          parent = await realpath(directory);
          const resolved = relative(root, parent);
          if (resolved === ".." || resolved.startsWith(".." + sep) || isAbsolute(resolved)) {
            throw new Error("The parent directory is outside the workspace.");
          }
        }
        const file = join(parent, parts.at(-1)!);
        await writeFile(file, args.content, { encoding: "utf8", flag: "wx" });
        context.readRanges.delete(file);
        return { ok: true, path };
      } catch (error) {
        return { ok: false, path, error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) };
      }
    },
  };
}
