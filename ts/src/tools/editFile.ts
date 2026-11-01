import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import type { EditFileResult, ToolDefinition } from "../interfaces.js";
import { checkFile, newProblems } from "../checks.js";

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

// How many more brackets lines startLine–endLine open than close, and the line where the file's later
// lines close them. Brackets in strings and // comments do not count; the count is a heuristic, so it
// only refuses an edit together with the syntax check.
export function openBrackets(text: string, startLine: number, endLine: number): { count: number; closes?: number } {
  const lines = text.split(/\r?\n/);
  const balance = (line: string) => {
    let depth = 0;
    let quote = "";
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;
      if (quote) {
        if (char === "\\") i++;
        else if (char === quote) quote = "";
      } else if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "/" && line[i + 1] === "/") break;
      else if ("{([".includes(char)) depth++;
      else if ("})]".includes(char)) depth--;
    }
    return depth;
  };
  let count = 0;
  for (let line = startLine; line <= endLine; line++) count += balance(lines[line - 1] ?? "");
  let depth = count;
  for (let line = endLine + 1; depth > 0 && line <= lines.length; line++) {
    depth += balance(lines[line - 1]!);
    if (depth <= 0) return { count, closes: line };
  }
  return { count };
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
        // A refused edit changes nothing, so it keeps the reads; only a successful one replaces them.
        const coverage = context.readRanges.get(file);
        if (!coverage) {
          throw new Error("Read the target lines with read_file before this edit. After a successful edit_file, " +
            "only the lines it showed you count as read.");
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
        if (updated === text) {
          throw new Error(`Not applied: lines ${startLine}–${endLine} already contain exactly this text, possibly ` +
            "from your own earlier edit. Nothing changed; this does not mean the request is done.");
        }

        // Problems are reported against the file as this request first found it, so one this request
        // introduced keeps being reported until it is fixed, and one the file already had never is.
        if (!context.baselines.has(file)) context.baselines.set(file, checkFile(file, text, root));
        const problems = newProblems(context.baselines.get(file)!, checkFile(file, updated, root));
        // A range that opens brackets it does not close ends inside a block, so the block's old remainder
        // would stay below the new text. When that breaks the file, the edit is refused with the range
        // that covers the whole block.
        const open = openBrackets(text, startLine, endLine);
        if (problems.length && open.count > 0) {
          throw new Error(`Not applied: lines ${startLine}–${endLine} open ${open.count} bracket` +
            `${open.count === 1 ? "" : "s"} that ${open.closes ? `close at line ${open.closes}` : "never close"}, so ` +
            `the rest of that block would stay below your new text (it would cause: ${problems.slice(0, 3).join("; ")}). ` +
            (open.closes ? `Replace lines ${startLine}–${open.closes} instead, or choose lines that close their own brackets.` :
              "Choose lines that close their own brackets."));
        }
        await writeFile(file, updated, "utf8");
        // Show the edited lines and 3 on each side. They count as read, so the next edit of them
        // needs no read_file.
        const lines = updated === "" ? [] : updated.split(/\r?\n/);
        if (/\n$/.test(updated)) lines.pop();
        const total = text === "" ? 0 : text.split(/\r?\n/).length - (/\n$/.test(text) ? 1 : 0);
        const end = endLine + lines.length - total;
        const from = Math.max(1, startLine - 3);
        const to = Math.min(lines.length, end + 3);
        context.readRanges.set(file, {
          version: createHash("sha256").update(updated).digest("hex"),
          ranges: [{ start: from, end: to, turn: context.turn }],
        });

        // Signs of an edit written from guesswork rather than from the file.
        const warnings: string[] = [];
        const replaced = endLine - startLine + 1;
        const added = end - startLine + 1;
        const repeats = (all: string[], first: number, last: number) => all.slice(first - 1, last)
          .filter((line, index, span) => index > 0 && line.trim() !== "" && line.trim() === span[index - 1]!.trim()).length;
        const old = text.split(/\r?\n/);
        if (repeats(lines, from, to) > repeats(old, from, Math.min(old.length, endLine + 3))) {
          warnings.push("The edited lines now contain a line repeated right after itself; check for a duplicate.");
        }
        // Lines retyped without change, matched from the top and the bottom of the range ignoring
        // whitespace: retyping is where tags get dropped and duplicates added.
        const same = (a: string | undefined, b: string | undefined) => a?.trim() === b?.trim();
        let top = 0;
        while (top < Math.min(replaced, added) && same(old[startLine - 1 + top], lines[startLine - 1 + top])) top++;
        let bottom = 0;
        while (bottom < Math.min(replaced, added) - top && same(old[endLine - 1 - bottom], lines[end - 1 - bottom])) bottom++;
        if (top + bottom > 10) {
          const spans = [top ? `${startLine}–${startLine + top - 1}` : "", bottom ? `${end - bottom + 1}–${end}` : ""]
            .filter(Boolean).join(" and ");
          const changed = startLine + top > end - bottom ? "the rest was only removed" :
            startLine + top === end - bottom ? `only line ${startLine + top} changed` :
            `only lines ${startLine + top}–${end - bottom} changed`;
          warnings.push(`This edit retyped ${top + bottom} lines it did not change (${spans}); ${changed}. ` +
            "Edit just the lines that need to change.");
        }
        if (added > replaced && endLine < total && endLine === Math.max(...ranges.map((range) => range.end))) {
          warnings.push(`This edit ends at line ${endLine}, the last line you had read, but the file continued to line ` +
            `${total}. Code after line ${endLine} is still below your new text; read it to check for duplicates.`);
        }
        return {
          ok: true, path, start_line: from, end_line: to, total_lines: lines.length,
          ...(problems.length ? { problems } : {}), ...(warnings.length ? { warnings } : {}),
          content: lines.slice(from - 1, to).map((line, index) => `${from + index}: ${line}`).join("\n"),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { ok: false, path, error: `No such file: ${path}. Use create_file to create a new file.` };
        }
        return {
          ok: false,
          path,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        };
      }
    },
  };
}
