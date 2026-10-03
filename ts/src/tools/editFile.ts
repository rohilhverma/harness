import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import type { EditFileResult, ToolDefinition } from "../interfaces.js";

export function replaceLines(
  text: string,
  startLine: number,
  endLine: number,
  newText: string,
): string {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (startLine < 1 || endLine < startLine || endLine > lines.length) {
    throw new Error(`The line range must be within the file's ${lines.length} lines.`);
  }

  let replacement = newText;
  const lastLine = lines[endLine - 1];
  if (replacement && !replacement.endsWith("\n") && lastLine?.endsWith("\n")) {
    replacement += lastLine.endsWith("\r\n") ? "\r\n" : "\n";
  }

  return lines.slice(0, startLine - 1).join("") +
    replacement + lines.slice(endLine).join("");
}

export function createEditFileTool(workspaceRoot: string): ToolDefinition {
  const root = realpathSync(workspaceRoot);

  return {
    name: "edit_file",
    description:
      "Replace an inclusive range of whole lines in an existing UTF-8 file " +
      "inside the workspace. Read all target lines first and wait for the result. " +
      "Use its 1-based line numbers. A missing trailing newline is supplied " +
      "when the selected range originally ended with one.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Workspace-relative file path." },
        start_line: {
          type: "integer", minimum: 1,
          description: "First line to replace, inclusive.",
        },
        end_line: {
          type: "integer", minimum: 1,
          description: "Last line to replace, inclusive.",
        },
        newText: {
          type: "string",
          description: "Replacement text without line-number prefixes; empty deletes the selected lines.",
        },
      },
      required: ["path", "start_line", "end_line", "newText"],
      additionalProperties: false,
    },
    async execute(args, context): Promise<EditFileResult> {
      const path = typeof args.path === "string" ? args.path : "";
      const { start_line: startLine, end_line: endLine, newText } = args;

      if (!path || isAbsolute(path)) {
        return { ok: false, path, error: "path must be a nonempty relative file path." };
      }
      if (
        typeof startLine !== "number" || !Number.isSafeInteger(startLine) || startLine < 1 ||
        typeof endLine !== "number" || !Number.isSafeInteger(endLine) || endLine < startLine ||
        typeof newText !== "string"
      ) {
        return {
          ok: false, path,
          error: "start_line and end_line must be positive integers with start_line <= end_line; newText must be a string.",
        };
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
        const coverage = context.readRanges.get(file);
        context.readRanges.delete(file);
        if (!coverage) {
          throw new Error("Read the target content with read_file before editing.");
        }
        if (!(await stat(file)).isFile()) {
          return { ok: false, path, error: "The path is not a regular file." };
        }

        // Strict decoding preserves a UTF-8 BOM and rejects invalid UTF-8.
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
          .decode(await readFile(file));
        if (coverage.version !== createHash("sha256").update(text).digest("hex")) {
          throw new Error("The file changed since it was read. Read the target content again.");
        }

        const updated = replaceLines(text, startLine, endLine, newText);
        const ranges = coverage.ranges
          .filter((range) => range.turn < context.turn)
          .sort((a, b) => a.start - b.start);

        let nextUnreadLine = startLine;
        for (const range of ranges) {
          if (range.start > nextUnreadLine) break;
          nextUnreadLine = Math.max(nextUnreadLine, range.end + 1);
          if (nextUnreadLine > endLine) break;
        }
        if (nextUnreadLine <= endLine) {
          throw new Error(
            `Read lines ${startLine}–${endLine} with read_file and wait for its result before editing. ` +
            "Earlier read results do not cover the entire target.",
          );
        }

        await writeFile(file, updated, "utf8");
        return { ok: true, path };
      } catch (error) {
        return {
          ok: false,
          path,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        };
      }
    },
  };
}
