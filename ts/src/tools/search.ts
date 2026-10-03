import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SearchResult, ToolDefinition } from "../interfaces.js";

const MAX_MATCHES = 15;
const MAX_FILES = 6;
const MAX_MATCHES_PER_FILE = 5;
const CONTEXT_LINES = 3;

function withinOneEdit(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;

  let index = 0;
  while (
    index < left.length && index < right.length &&
    left[index] === right[index]
  ) index++;

  if (index === Math.min(left.length, right.length)) return true;
  if (left.length !== right.length) {
    return left.length > right.length
      ? left.slice(index + 1) === right.slice(index)
      : left.slice(index) === right.slice(index + 1);
  }

  return left.slice(index + 1) === right.slice(index + 1) ||
    (
      left[index] === right[index + 1] &&
      left[index + 1] === right[index] &&
      left.slice(index + 2) === right.slice(index + 2)
    );
}

function runSearch(
  root: string,
  target: string,
  pattern: string,
  suggest = false,
): Promise<SearchResult> {
  return new Promise<SearchResult>((resolveResult) => {
    execFile(
      "rg",
      [
        "--no-config",
        "--json",
        "--ignore-case",
        "--sort", "path",
        ...(suggest
          ? ["--word-regexp"]
          : [
              "--fixed-strings",
              "--context", String(CONTEXT_LINES),
              // One extra match lets us detect the per-file limit.
              "--max-count", String(MAX_MATCHES_PER_FILE + 1),
            ]),
        "--", suggest ? "[A-Za-z_][A-Za-z0-9_]*" : pattern, target,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      },
      (error, stdout, stderr) => {
        const bufferLimited =
          error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
          error.message.startsWith("stdout ");

        if (error && error.code !== 1 && !bufferLimited) {
          resolveResult({
            ok: false,
            error: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? error.message.slice(0, 2000)
              : error.killed
                ? "Search timed out after 10 seconds."
                : (stderr.trim() || error.message).slice(0, 2000),
          });
          return;
        }

        try {
          const result: SearchResult = {
            ok: true,
            files: [],
            limited: bufferLimited,
          };

          // A buffer limit may cut the final JSON record in half.
          const events = stdout.slice(0, stdout.lastIndexOf("\n") + 1)
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((event) =>
              event.type === "match" || event.type === "context")
            .filter((event) => {
              if (typeof event.data.path.text !== "string") {
                result.limited = true;
                return false;
              }
              return true;
            });

          if (suggest) {
            result.suggestions = [];
            const seen = new Set<string>();
            const query = pattern.toLowerCase();

            collect: for (const event of events) {
              if (event.type !== "match") continue;
              for (const match of event.data.submatches) {
                const term: string = match.match.text;
                const normalized = term.toLowerCase();
                if (seen.has(normalized)) continue;
                if (seen.size >= 2000) {
                  result.limited = true;
                  break collect;
                }
                seen.add(normalized);
                if (!withinOneEdit(query, normalized)) continue;

                const line: string = (event.data.lines.text ??
                  Buffer.from(event.data.lines.bytes, "base64").toString("utf8"))
                  .replace(/\r?\n$/, "");
                const start = Math.max(0, line.indexOf(term) - 60);
                result.suggestions.push({
                  term,
                  path: relative(root, event.data.path.text),
                  line: event.data.line_number,
                  text: line.slice(start, start + 200),
                });
              }
            }

            result.suggestions.sort((left, right) => {
              if (left.path !== right.path) return left.path < right.path ? -1 : 1;
              if (left.line !== right.line) return left.line - right.line;
              return left.term.toLowerCase() < right.term.toLowerCase() ? -1 : 1;
            });
            while (
              result.suggestions.length > 3 ||
              Buffer.byteLength(JSON.stringify(result), "utf8") > 16 * 1024
            ) {
              result.suggestions.pop();
              result.limited = true;
            }
            resolveResult(result);
            return;
          }

          const rows = events
            .map((event) => ({
              type: event.type,
              path: relative(root, event.data.path.text),
              line: event.data.line_number,
              text: (event.data.lines.text ??
                Buffer.from(event.data.lines.bytes, "base64")
                  .toString("utf8"))
                .replace(/\r?\n$/, ""),
            }));

          let totalMatches = 0;

          for (const row of rows) {
            if (row.type !== "match") continue;

            let file = result.files.find(
              (candidate) => candidate.path === row.path,
            );

            if (
              totalMatches >= MAX_MATCHES ||
              (file && file.matches.length >= MAX_MATCHES_PER_FILE) ||
              (!file && result.files.length >= MAX_FILES)
            ) {
              result.limited = true;
              continue;
            }

            if (!file) {
              file = { path: row.path, matches: [] };
              result.files.push(file);
            }

            file.matches.push({
              line: row.line,
              text: row.text,
              context: rows
                .filter((context) =>
                  context.path === row.path &&
                  context.line >= row.line - CONTEXT_LINES &&
                  context.line <= row.line + CONTEXT_LINES)
                .map((context) => `${context.line}: ${context.text}`)
                .join("\n"),
            });

            if (
              Buffer.byteLength(JSON.stringify(result), "utf8") >
              16 * 1024
            ) {
              file.matches.pop();
              if (file.matches.length === 0) result.files.pop();
              result.limited = true;
              continue;
            }

            totalMatches++;
            console.log(`MATCH FOUND THIS LINE: ${row.path}:${row.line}`);
          }

          resolveResult(result);
        } catch (error) {
          resolveResult({
            ok: false,
            error: error instanceof Error
              ? error.message.slice(0, 2000)
              : String(error).slice(0, 2000),
          });
        }
      },
    );
  });
}

export function createSearchTool(workspaceRoot: string): ToolDefinition {
  const root = realpathSync(workspaceRoot);

  return {
    name: "search",
    description:
      "Search for literal, case-insensitive text inside the workspace. " +
      "Returns up to 15 matching lines across 6 files, with at most 5 " +
      "matches per file and 3 surrounding lines on each side. " +
      "Results are capped at 16 KiB; limited means results were restricted. " +
      "A complete empty search for a 4–64 character ASCII identifier also " +
      "checks up to 2,000 distinct tokens for one-edit spelling suggestions. " +
      "Returns up to 3 suggestions with line excerpts; these are not literal matches.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1, default: ".", description: "Workspace-relative file or directory." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute({ pattern, path = "." }): Promise<SearchResult> {
      if (typeof pattern !== "string" || pattern.length === 0 || /[\r\n]/.test(pattern)) {
        return { ok: false, error: "pattern must be a nonempty, single-line string." };
      }
      if (typeof path !== "string" || !path || isAbsolute(path)) {
        return { ok: false, error: "path must be a nonempty relative path." };
      }

      try {
        const target = await realpath(resolve(root, path));
        const relativePath = relative(root, target);
        if (
          relativePath === ".." || relativePath.startsWith(`..${sep}`) ||
          isAbsolute(relativePath)
        ) {
          return { ok: false, error: "The search path is outside the workspace." };
        }

        const result = await runSearch(root, target, pattern);
        if (
          result.ok && result.files.length === 0 && !result.limited &&
          /^[A-Za-z_][A-Za-z0-9_]{3,63}$/.test(pattern)
        ) {
          return await runSearch(root, target, pattern, true);
        }
        return result;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000) };
      }
    },
  };
}
