import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SearchResult, ToolDefinition } from "../interfaces.js";
import { saveOutput } from "./outputs.js";

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

// Literal patterns are alternatives: a line matching any of them matches.
function runSearch(
  root: string,
  target: string,
  patterns: string[],
  suggest = false,
  maxBytes = 16 * 1024,
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
        ...(suggest ? ["-e", "[A-Za-z_][A-Za-z0-9_]*"] : patterns.flatMap((pattern) => ["-e", pattern])),
        "--", target,
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
            const query = patterns[0]!.toLowerCase();

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
              Buffer.byteLength(JSON.stringify(result), "utf8") > maxBytes
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
              maxBytes
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

// Every matching line as path:line:text (up to 1 MiB), for results too long to return inline.
function listMatches(root: string, target: string, patterns: string[]): Promise<string> {
  return new Promise((resolveList) => {
    execFile("rg", ["--no-config", "--ignore-case", "--fixed-strings", "--line-number", "--with-filename",
      "--no-heading", "--sort", "path", ...patterns.flatMap((pattern) => ["-e", pattern]), "--", relative(root, target) || "."],
    { cwd: root, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
    (error, stdout) => {
      const lines = stdout.replace(/^\.\//gm, "");
      resolveList(error && error.code !== 1 ? lines + "\n[listing stopped: " + error.message.slice(0, 200) + "]\n" : lines);
    });
  });
}

// Names declared in a file, in order: element ids, functions and variables. An empty search of the
// file returns them, so a search for a description of the code is followed by one for a real name.
async function declaredNames(file: string): Promise<string[]> {
  const names = new Set<string>();
  const declaration = /\bid\s*=\s*["']([^"']+)["']|\b(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)|\bdef\s+([A-Za-z_]\w*)/g;
  for (const match of (await readFile(file, "utf8")).matchAll(declaration)) {
    names.add((match[1] ?? match[2] ?? match[3])!);
    if (names.size >= 20) break;
  }
  return [...names];
}

// saveOutputs is off only for conversations saved before .harness/outputs, which keep their tool descriptions.
export function createSearchTool(workspaceRoot: string, saveOutputs = false): ToolDefinition {
  const root = realpathSync(workspaceRoot);

  return {
    name: "search",
    description:
      "Search for literal, case-insensitive text inside the workspace. " +
      "Returns up to 15 matching lines across 6 files, with at most 5 " +
      "matches per file and 3 surrounding lines on each side. " +
      (saveOutputs ? "Results are capped at 8 KiB; limited means results were restricted, and then every " +
        "matching line is saved to a file under .harness/outputs, named in full_results, for read_file. " :
        "Results are capped at 16 KiB; limited means results were restricted. ") +
      "A complete empty search for a 4–64 character ASCII identifier also " +
      "checks up to 2,000 distinct tokens for one-edit spelling suggestions. " +
      "Returns up to 3 suggestions with line excerpts; these are not literal matches. " +
      "If text with | is not found, each |-separated part is searched. An empty search of one file also " +
      "returns names: ids, functions and variables declared in it.",
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

        const maxBytes = saveOutputs ? 8 * 1024 : 16 * 1024;
        let patterns = [pattern];
        let result = await runSearch(root, target, patterns, false, maxBytes);
        // Models join alternatives with | as in a regex; when that literal text is absent, each part is searched.
        const parts = pattern.split("|").map((part) => part.trim()).filter(Boolean);
        if (result.ok && result.files.length === 0 && !result.limited && parts.length > 1) {
          patterns = parts;
          result = await runSearch(root, target, patterns, false, maxBytes);
        }
        if (
          result.ok && result.files.length === 0 && !result.limited &&
          /^[A-Za-z_][A-Za-z0-9_]{3,63}$/.test(pattern)
        ) {
          result = await runSearch(root, target, patterns, true, maxBytes);
        }
        if (result.ok && result.files.length === 0 && (await stat(target)).isFile()) {
          const names = await declaredNames(target);
          if (names.length) {
            return { ...result, names, note: "Nothing matched. names lists ids, functions and variables declared in " +
              "this file; search for one of them, or read the file." };
          }
        }
        if (saveOutputs && result.ok && result.limited) {
          const listing = await listMatches(root, target, patterns);
          const full_results = await saveOutput(root, "search", listing)
            .catch((error: unknown) => "(not saved: " + (error instanceof Error ? error.message : String(error)) + ")");
          // A live test answered from the shown matches only, so the count and a reminder are explicit.
          // They come before the matches, so they survive when compaction cuts older tool results.
          return { ok: true, full_results, total_matches: listing.split("\n").filter((line) => line && !line.startsWith("[listing stopped")).length,
            note: "Only the first matches are shown. Read full_results with read_file to see every matching line.",
            files: result.files, limited: true };
        }
        return result;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000) };
      }
    },
  };
}
