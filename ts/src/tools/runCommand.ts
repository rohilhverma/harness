import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { RunCommandResult, ToolDefinition } from "../interfaces.js";

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024;
const COMMANDS: Record<string, string[]> = {
  npm: ["test", "run"],
  go: ["test", "build", "vet", "fmt"],
  cargo: ["test", "build", "check", "clippy", "fmt"],
  git: ["status", "diff", "log", "show", "ls-files"],
  ruff: ["check", "format"],
  pytest: [], eslint: [], prettier: [], tsc: [],
  pwd: [], ls: [], rg: [], cat: [], head: [], tail: [], wc: [],
};
const NPM_SCRIPTS = new Set([
  "test", "build", "lint", "format", "check", "typecheck", "validate",
]);
const UNSAFE_FLAGS =
  /^(?:--(?:cwd|directory|prefix|git-dir|work-tree|exec-path|config|config-env|script-shell|userconfig|globalconfig|registry|global|pre|hostname-bin|ext-diff|textconv)(?:=|$)|-C|-exec(?:=|$)|-toolexec(?:=|$))/;
const SHELL_OPERATORS = new Set(["|", "||", "&&", ";", "&", ">", ">>", "<"]);

function insideWorkspace(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot !== ".." && !pathFromRoot.startsWith(".." + sep) &&
    !isAbsolute(pathFromRoot);
}

function failure(
  error: string,
  status: "rejected" | "failed" = "rejected",
): RunCommandResult {
  return {
    ok: false, status, exit_code: null, stdout: "", stderr: "",
    output_truncated: false, error: error.slice(0, 2000),
  };
}

// Local process handling stays here; a future container runner can replace it.
function runProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<RunCommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let finished = false;
    let spawnError: string | null = null;

    const capture = (current: Buffer, chunk: Buffer): Buffer => {
      const remaining = MAX_OUTPUT_BYTES - current.length;
      truncated ||= chunk.length > remaining;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = capture(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = capture(stderr, chunk); });
    child.on("error", (error) => { spawnError = error.message.slice(0, 2000); });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish(null, null);
    }, TIMEOUT_MS);

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const decode = (buffer: Buffer): string => {
        const utf8 = Buffer.from(buffer.toString("utf8"), "utf8");
        truncated ||= utf8.length > MAX_OUTPUT_BYTES;
        return new StringDecoder("utf8").write(utf8.subarray(0, MAX_OUTPUT_BYTES));
      };
      const stdoutText = decode(stdout);
      const stderrText = decode(stderr);
      const status = timedOut ? "timeout" : code === 0 && !spawnError ? "success" : "failed";
      resolveResult({
        ok: status === "success",
        status,
        exit_code: code,
        stdout: stdoutText,
        stderr: stderrText,
        output_truncated: truncated,
        error: timedOut ? "Command timed out after 60 seconds." :
          spawnError ?? (code === 0 ? null :
            signal ? "Command terminated by " + signal + "." :
              "Command exited with code " + code + "."),
      });
    };
    child.on("close", finish);
  });
}

export function createRunCommandTool(workspaceRoot: string): ToolDefinition {
  const root = realpathSync(workspaceRoot);

  return {
    name: "run_command",
    description:
      "Run allowlisted project inspection, build, test, lint, and format commands " +
      "locally on macOS/Linux. No shell. Timeout: 60 seconds. Captures up to " +
      "8 KiB each of stdout and stderr. Project scripts are trusted code; " +
      "this does not provide filesystem or network isolation.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", enum: Object.keys(COMMANDS), description: "Executable name only." },
        args: { type: "array", items: { type: "string" }, default: [], description: "Separate arguments; no shell operators. rg supports common search flags, -e/-f/-g, -A/-B/-C/-m, their long forms, and --; unsupported flags are rejected." },
        cwd: { type: "string", minLength: 1, default: ".", description: "Workspace-relative working directory." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute({ command, args = [], cwd = "." }): Promise<RunCommandResult> {
      if (
        typeof command !== "string" || !Object.hasOwn(COMMANDS, command) ||
        !Array.isArray(args) || args.some((arg) =>
          typeof arg !== "string" || /[\0\r\n]/.test(arg)) ||
        typeof cwd !== "string" || !cwd || isAbsolute(cwd) || /[\0\r\n]/.test(cwd)
      ) {
        return failure("Use an allowed executable, string arguments, and a relative cwd.");
      }
      const subcommands = COMMANDS[command]!;
      if (subcommands.length && !subcommands.includes(args[0] ?? "")) {
        return failure("Subcommand is not allowed.");
      }
      if (command === "npm" && args[0] === "run" && !NPM_SCRIPTS.has(args[1] ?? "")) {
        return failure("Only test/build/lint/format/check/typecheck/validate scripts are allowed.");
      }
      if (args.some((arg) => SHELL_OPERATORS.has(arg) ||
        (command !== "rg" && UNSAFE_FLAGS.test(arg))) ||
        (command === "npm" && args.some((arg) => /^(?:-g|-w|--workspaces?(?:=|$))/.test(arg))) ||
        (command === "git" && args.some((arg) => /^(?:--output(?:=|$)|-o|-c|-O)/.test(arg)))) {
        return failure("Shell operators and directory/configuration/execution overrides are not allowed.");
      }

      try {
        const directory = await realpath(resolve(root, cwd));
        if (!insideWorkspace(root, directory)) return failure("cwd is outside the workspace.");
        if (!(await stat(directory)).isDirectory()) return failure("cwd must be a directory.");
        let pathArgs: string[] = args;
        if (command === "rg") {
          const paths: string[] = [];
          const positionals: string[] = [];
          let explicitPattern = false;
          let literal = false;
          for (let index = 0; index < args.length; index++) {
            const arg = args[index]!;
            if (!literal && arg === "--") { literal = true; continue; }
            if (literal || !arg.startsWith("-") || arg === "-") {
              positionals.push(arg);
              continue;
            }
            if (arg === "--files") { explicitPattern = true; continue; }
            if (/^(?:-[niSsFwxlHovqc]+|--(?:line-number|ignore-case|smart-case|case-sensitive|fixed-strings|word-regexp|line-regexp|files-with-matches|with-filename|only-matching|invert-match|quiet|count|hidden|no-ignore|no-config))$/.test(arg)) continue;
            const option = arg.startsWith("--") ? arg.split("=", 1)[0]! : arg.slice(0, 2);
            if (!["-e", "--regexp", "-f", "--file", "-g", "--glob", "--iglob",
              "-A", "--after-context", "-B", "--before-context", "-C", "--context",
              "-m", "--max-count"].includes(option)) {
              return failure("Unsupported rg option: " + arg);
            }
            const attached = arg.startsWith("--")
              ? (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined)
              : (arg.length > 2 ? arg.slice(2) : undefined);
            const value = attached ?? args[++index];
            if (value === undefined) return failure("Missing value for " + option + ".");
            if (["-e", "--regexp", "-f", "--file"].includes(option)) explicitPattern = true;
            if (option === "-f" || option === "--file") paths.push(value);
          }
          pathArgs = [...paths, ...positionals.slice(explicitPattern ? 0 : 1)];
        }
        for (const arg of pathArgs) {
          const value = command !== "rg" && arg.startsWith("-") && arg.includes("=")
            ? arg.slice(arg.indexOf("=") + 1) : arg;
          if (isAbsolute(value) || !insideWorkspace(root, resolve(directory, value))) {
            return failure("Use argument paths relative to cwd, inside the workspace.");
          }
          // Preserve symlink/.. semantics until realpath resolves the path.
          let ancestor = directory + sep + value;
          while (true) {
            try {
              await lstat(ancestor);
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              const parent = dirname(ancestor);
              if (parent === ancestor) throw error;
              ancestor = parent;
            }
          }
          if (!insideWorkspace(root, await realpath(ancestor))) {
            return failure("Argument path resolves outside the workspace.");
          }
        }

        let executable = command;
        if (["tsc", "eslint", "prettier"].includes(command)) {
          try {
            executable = await realpath(resolve(directory, "node_modules", ".bin", command));
            if (!insideWorkspace(root, executable)) return failure("Local executable is outside the workspace.");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        let processArgs: string[] = [...args];
        if (command === "git") {
          processArgs = ["--no-pager", "--no-optional-locks", args[0],
            ...(["diff", "log", "show"].includes(args[0]) ? ["--no-ext-diff", "--no-textconv"] : []),
            ...args.slice(1)];
        }
        if (command === "rg") processArgs.unshift("--no-config");

        console.log("[run_command] " + command + " (cwd: " + (relative(root, directory) || ".") + ")");
        return await runProcess(executable, processArgs, directory);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error), "failed");
      }
    },
  };
}
