import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ReadFileResult, ToolDefinition } from "../interfaces.js";

// Large enough that a typical source file arrives in one read; the model treats a first page as the whole file.
const READ_LIMIT = 12 * 1024;

export function createReadFileTool(workspaceRoot: string): ToolDefinition {
  const root = realpathSync(workspaceRoot);

  return {
    name: "read_file",
    description:
      "Read UTF-8 text inside the workspace. Returns numbered lines from start_line, as many as fit in " +
      "12 KiB, or through end_line or line_count lines if fewer. Use next_line to continue; null means EOF.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative file path." },
        start_line: { type: "integer", minimum: 1, default: 1 },
        line_count: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1, description: "Last line to read, inclusive; another way to give line_count." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args, context): Promise<ReadFileResult> {
      const path = typeof args.path === "string" ? args.path : "";
      // The 12 KiB content limit bounds a read, so line_count only shortens it. end_line, which edit_file
      // also uses, is accepted as another way to give it.
      const { start_line = 1, line_count = Number.MAX_SAFE_INTEGER, end_line } = args;

      if (!path || isAbsolute(path)) {
        return { ok: false, path, error: "path must be a nonempty relative file path." };
      }
      if (
        typeof start_line !== "number" || !Number.isSafeInteger(start_line) || start_line < 1 ||
        typeof line_count !== "number" || !Number.isSafeInteger(line_count) || line_count < 1
      ) {
        return { ok: false, path, error: "start_line and line_count must be positive integers." };
      }
      if (end_line !== undefined &&
          (typeof end_line !== "number" || !Number.isSafeInteger(end_line) || end_line < start_line)) {
        return { ok: false, path, error: "end_line must be an integer no smaller than start_line." };
      }
      if (end_line !== undefined && args.line_count !== undefined && line_count !== end_line - start_line + 1) {
        return { ok: false, path, error: `end_line ${end_line} and line_count ${line_count} disagree; give one of them.` };
      }
      const count = end_line === undefined ? line_count : end_line - start_line + 1;

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

        // Lines are added until the next would pass the limit, so a large file is not joined repeatedly.
        const content: string[] = [];
        let bytes = 0;
        for (let index = start_line - 1; index < Math.min(lines.length, start_line - 1 + count); index++) {
          const entry = `${index + 1}: ${lines[index]}`;
          bytes += Buffer.byteLength(entry, "utf8") + (content.length ? 1 : 0);
          if (bytes > READ_LIMIT) break;
          content.push(entry);
        }
        if (content.length === 0 && start_line <= lines.length) {
          return { ok: false, path, error: `Line ${start_line} exceeds the 12 KiB content limit.` };
        }

        const endLine = content.length ? start_line + content.length - 1 : null;
        if (endLine !== null || lines.length === 0) {
          const version = createHash("sha256").update(text).digest("hex");
          const previous = context.readRanges.get(file);
          context.readRanges.set(file, {
            version,
            ranges: [
              ...(previous?.version === version ? previous.ranges : []),
              { start: start_line, end: endLine ?? 0, turn: context.turn },
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
          total_lines: lines.length,
          content: content.join("\n"),
          next_line: endLine !== null && endLine < lines.length ? endLine + 1 : null,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { ok: false, path, error: `No such file: ${path}.` };
        }
        return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
