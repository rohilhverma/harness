import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ReadFileResult, ToolDefinition } from "../interfaces.js";

export function createReadFileTool(workspaceRoot: string): ToolDefinition {
  const root = realpathSync(workspaceRoot);

  return {
    name: "read_file",
    description:
      "Read UTF-8 text inside the workspace. Returns numbered lines, up to " +
      "100 lines and 4 KiB of content. Use next_line to continue; null means EOF.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative file path." },
        start_line: { type: "integer", minimum: 1, default: 1 },
        line_count: { type: "integer", minimum: 1, maximum: 100, default: 100 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args, context): Promise<ReadFileResult> {
      const path = typeof args.path === "string" ? args.path : "";
      const { start_line = 1, line_count = 100 } = args;

      if (!path || isAbsolute(path)) {
        return { ok: false, path, error: "path must be a nonempty relative file path." };
      }
      if (
        typeof start_line !== "number" || !Number.isSafeInteger(start_line) || start_line < 1 ||
        typeof line_count !== "number" || !Number.isSafeInteger(line_count) ||
        line_count < 1 || line_count > 100
      ) {
        return { ok: false, path, error: "start_line must be a positive integer; line_count must be 1–100." };
      }

      try {
        const file = await realpath(resolve(root, path));
        const relativePath = relative(root, file);
        if (
          relativePath === ".." || relativePath.startsWith(`..${sep}`) ||
          isAbsolute(relativePath)
        ) {
          return { ok: false, path, error: "The file is outside the workspace." };
        }
        if (!(await stat(file)).isFile()) {
          return { ok: false, path, error: "The path is not a regular file." };
        }

        const text = await readFile(file, "utf8");
        const lines = text === "" ? [] : text.split(/\r?\n/);
        if (/\n$/.test(text)) lines.pop();

        const content = lines
          .slice(start_line - 1, start_line - 1 + line_count)
          .map((line, index) => `${start_line + index}: ${line}`);

        while (Buffer.byteLength(content.join("\n"), "utf8") > 4096) {
          content.pop();
        }
        if (content.length === 0 && start_line <= lines.length) {
          return { ok: false, path, error: `Line ${start_line} exceeds the 4 KiB content limit.` };
        }

        const endLine = content.length ? start_line + content.length - 1 : null;
        if (endLine !== null) {
          const version = createHash("sha256").update(text).digest("hex");
          const previous = context.readRanges.get(file);
          context.readRanges.set(file, {
            version,
            ranges: [
              ...(previous?.version === version ? previous.ranges : []),
              { start: start_line, end: endLine, turn: context.turn },
            ],
          });
        }
        console.log(`READING THIS FILE: ${path}`);
        console.log(content.join("\n"));
        return {
          ok: true,
          path,
          start_line,
          end_line: endLine,
          content: content.join("\n"),
          next_line: endLine !== null && endLine < lines.length ? endLine + 1 : null,
        };
      } catch (error) {
        return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
