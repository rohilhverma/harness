import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ModelClient } from "./modelClient.js";
import { checkFile, newProblems } from "./src/checks.js";
import { chooseCompaction, compactedView, toolRecord } from "./src/compaction.js";
import { notesMessage } from "./src/notes.js";
import { SUMMARY_INSTRUCTION } from "./src/prompts.js";
import { CONTEXT_TOKENS } from "./src/providers/sidecar.js";
import type {
  AgentConfiguration,
  AgentIdentity,
  Compaction,
  ConversationMemory,
  Message,
  ModelConfiguration,
  ModelProvider,
  ModelResponse,
  RunBudget,
  ToolDefinition,
  ToolExecutionContext,
} from "./src/interfaces.js";
import { commandEnv } from "./src/tools/runCommand.js";

// Top-level argument types and limits from the tool's schema, so a bad value gets a precise message
// before the tool runs.
function argumentProblem(tool: ToolDefinition, args: Record<string, unknown>): string | undefined {
  const properties = (tool.parameters.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const name of (tool.parameters.required ?? []) as string[]) {
    if (!(name in args)) return `Missing argument ${name} for ${tool.name}.`;
  }
  for (const [name, value] of Object.entries(args)) {
    const rule = properties[name];
    if (!rule) continue;
    const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (typeof rule.type === "string" && (rule.type === "integer" ? !Number.isInteger(value) : rule.type !== kind)) {
      return `Argument ${name} for ${tool.name} must be ${rule.type === "integer" ? "an integer" : "a " + rule.type}.`;
    }
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) {
      return `Argument ${name} for ${tool.name} must be one of: ${rule.enum.join(", ")}.`;
    }
    const limits: [unknown, string, number | undefined][] = [
      [rule.minimum, "at least", typeof value === "number" ? value : undefined],
      [rule.maximum, "at most", typeof value === "number" ? value : undefined],
      [rule.minLength, "at least", typeof value === "string" ? value.length : undefined],
      [rule.maxLength, "at most", typeof value === "string" ? value.length : undefined],
      [rule.maxItems, "at most", Array.isArray(value) ? value.length : undefined],
    ];
    for (const [limit, word, actual] of limits) {
      if (typeof limit !== "number" || actual === undefined || (word === "at least" ? actual >= limit : actual <= limit)) continue;
      const unit = typeof value === "string" ? " characters long" : Array.isArray(value) ? " items" : "";
      return `Argument ${name} for ${tool.name} must be ${word} ${limit}${unit}.`;
    }
  }
  return undefined;
}

// The first existing file inside the workspace that a request names, relative to the workspace.
function namedFile(workspace: string, request: string): string | undefined {
  const root = realpathSync(workspace);
  for (const [name] of request.matchAll(/[\w./-]*\w\.\w+/g)) {
    try {
      const file = realpathSync(join(root, name));
      if (file.startsWith(root + "/") && statSync(file).isFile()) return relative(root, file);
    } catch { /* Not a file in the workspace. */ }
  }
  return undefined;
}

// A concrete next step for a call that repeats one whose result is `earlier`, so the model is told
// what to do instead of only that the repeat changes nothing.
function nextStep(tool: ToolDefinition, args: Record<string, unknown>, earlier: string): string {
  let result: Record<string, unknown> = {};
  try { result = JSON.parse(earlier); } catch { /* Give the general advice. */ }
  const call = (name: string, callArgs: object) =>
    "\n```json\n" + JSON.stringify({ name, arguments: callArgs }) + "\n```";
  const accepted = Object.keys((tool.parameters.properties ?? {}) as object);
  if (result.ok === false && Object.keys(args).some((key) => !accepted.includes(key))) {
    const fixed = Object.fromEntries(Object.entries(args).filter(([key]) => accepted.includes(key)));
    return ((tool.parameters.required ?? []) as string[]).every((key) => key in fixed) ?
      "Make this call instead, without the arguments it does not accept:" + call(tool.name, fixed) :
      `Use only the arguments ${tool.name} accepts: ${accepted.join(", ")}.`;
  }
  if (result.ok === false) return "Change what its error names, or use another tool.";
  if (tool.name === "read_file" && typeof result.next_line === "number") {
    return "To read the following lines, make this call:" + call("read_file", { path: args.path, start_line: result.next_line });
  }
  if (tool.name === "read_file") return "You have read to the end of the file; edit it or give your answer.";
  if (tool.name === "search" && Array.isArray(result.files) && !result.files.length) {
    return "search matches literal text, so a description of what you expect finds nothing. Search for a short " +
      "word that appears in the code, such as an id or a function name, or read the file" +
      (typeof args.path === "string" ? ":" + call("read_file", { path: args.path }) : " with read_file.");
  }
  if (tool.name === "edit_file") {
    return "That edit is already in the file; check the lines its result showed, then take the next step or give your final answer.";
  }
  return "Do something different.";
}

// A package.json test script, run once the request changed files. No script, no check.
function testProblems(root: string): Promise<string[]> {
  let script: unknown;
  try { script = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts?.test; } catch { return Promise.resolve([]); }
  if (typeof script !== "string" || /no test specified/.test(script)) return Promise.resolve([]);
  return new Promise((done) => execFile("npm", ["test"], { cwd: root, env: commandEnv(root, root), timeout: 120_000,
    maxBuffer: 10_000_000 }, (error, stdout, stderr) => done(!error ? [] : ["npm test failed" +
      (error.killed ? " (stopped after 120 s)" : "") + ":\n" + (stdout + stderr).slice(-1500)])));
}

export class ModelProviderError extends Error {
  constructor(cause: unknown) {
    super("Model provider failed to generate a response.", { cause });
    this.name = "ModelProviderError";
  }
}

export class AgentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLimitError";
  }
}

export class Agent implements AgentConfiguration {
  
  identity: AgentIdentity;
  model: ModelConfiguration;
  tools: ToolDefinition[];
  memory: ConversationMemory;
  compaction?: Compaction;
  workspace?: string;
  programs?: AgentConfiguration["programs"];
  private readonly modelClient: ModelClient;
  // Exact sidecar count for the view's first `messages` messages, from the latest generation.
  private measured?: { tokens: number; messages: number };

  
  constructor(
    configuration: AgentConfiguration,
    provider: ModelProvider<unknown>,
    private readonly log: (text: string) => void = () => {},
  ) {
    this.identity = configuration.identity;
    this.model = configuration.model;
    this.tools = configuration.tools;
    this.memory = configuration.memory
    this.compaction = configuration.compaction;
    this.workspace = configuration.workspace;
    this.programs = configuration.programs;
    this.modelClient = new ModelClient(provider, this.model);
  }

  async run(userPrompt: string, parentBudget?: RunBudget): Promise<ModelResponse> {
    if (this.memory.messages().length === 0) {
      this.memory.add({ role: "system", content: this.identity.systemPrompt });
    }
    this.memory.add({ role: "user", content: userPrompt });

    const child = parentBudget !== undefined;
    const budget = parentBudget ?? {
      modelCalls: 30,
      toolCalls: this.tools.some((tool) => tool.name === "delegate") ? 80 : Infinity,
      delegations: 3,
    };
    const maxCalls = child ? 6 : 30;
    let toolCalls = 0;
    let rejected = 0; // Unusable replies in a row.
    const prefix = child ? `[subagent ${this.identity.name}] ` : "";
    const context: ToolExecutionContext = {
      budget,
      depth: child ? 1 : 0,
      userTask: userPrompt,
      turn: 0,
      readRanges: new Map(),
      baselines: new Map(),
    };
    const request = this.memory.messages().length - 1;
    let checked = false; // The check before the final answer runs once per request.
    let noted = false; // So does the note about a code block in an answer.
    let previous: { signature: string; result: string } | undefined;
    let repeats = 0; // Identical calls refused in a row.
    // Calls that must not run again in this request, by signature, with their result: one whose arguments
    // were rejected fails the same way, and a successful edit_file would be applied twice.
    const settled = new Map<string, string>();

    // Grounding: when the request names a workspace file, the harness reads its first page as the
    // request's first step, so the model starts from the file's real contents instead of a guess.
    let first = 0;
    const reader = this.tools.find((tool) => tool.name === "read_file");
    const named = this.workspace && reader ? namedFile(this.workspace, userPrompt) : undefined;
    if (named) {
      const args = { path: named };
      const result = await reader!.execute(args, context).catch(() => undefined) as
        { ok?: boolean; content?: unknown } | undefined;
      if (result?.ok && typeof result.content === "string") {
        const call = { id: "call_" + randomUUID(), name: "read_file", arguments: JSON.stringify(args) };
        console.log(`${prefix}[turn 1] harness read for grounding: read_file arguments:`, call.arguments);
        const summary = JSON.stringify({ ...result, content: undefined });
        this.memory.add({ role: "assistant", content: "", toolCalls: [call] });
        this.memory.add({ role: "tool", toolCallId: call.id, content: summary + "\n" + result.content });
        previous = { signature: "read_file " + call.arguments, result: summary };
        first = 1; // The read is step 0, recorded as turn 0; the model's steps follow.
      }
    }

    for (let turn = first; turn < maxCalls + first; turn++) {
      if (budget.modelCalls <= (child ? 2 : 0)) {
        throw await this.stopped(context, request, child, "Task model-call budget exhausted; children reserve two calls for the parent.");
      }
      budget.modelCalls--;
      context.turn = turn;
      // Compact before the prompt nears its limit, leaving room for a reply and a summary request.
      if (!child && this.contextTokens() > CONTEXT_TOKENS - (this.model.maxTokens ?? 2048) - 2048) {
        await this.compact(context);
      }
      const response = await this.generate(context, !child);
      this.memory.add(response.output);
      this.measured = { tokens: response.usage.promptTokens + response.usage.generatedTokens,
        messages: this.view().length };

      const calls = response.output.toolCalls;
      switch (response.conclusion) {
        case "success":
          if (calls?.length) {
            throw new Error("Model returned success with tool calls.");
          }
          // A code block in an answer is usually a call or an edit the model only wrote out. Nothing ran,
          // so the model is told once per request instead of the task ending.
          if (!noted && /^[ \t]*```/m.test(response.output.content)) {
            noted = true;
            console.log(`${prefix}[turn ${turn + 1}] harness note: answer has a code block but no tool call`);
            this.memory.add({ role: "system", content: "Harness note (from the harness, not the user): your reply " +
              "has a code block but no tool call, so nothing ran and no file changed. To act, make one tool call, " +
              'for example:\n```json\n{"name": "read_file", "arguments": {"path": "app.py"}}\n```\n' +
              "To change a file, call edit_file instead of writing its new contents. If the work is finished, give " +
              "your final answer without code blocks." });
            continue;
          }
          // Before accepting an answer, check what this request changed. The model gets one chance to
          // fix what is found; after that the user is told instead.
          if (!child && this.workspace) {
            const issues = await this.finishingProblems(context, request);
            if (issues.length && !checked) {
              checked = true;
              console.log(`${prefix}[turn ${turn + 1}] harness check before finishing:`, issues);
              this.memory.add({ role: "system", content: "Harness check before your final answer (from the harness, " +
                "not the user):\n- " + issues.join("\n- ") + "\nFix these, then give your final answer. If one cannot " +
                "be fixed, say so in the answer." });
              continue;
            }
            if (issues.length) console.log("Harness checks still report:\n- " + issues.join("\n- "));
          }
          if (!child) console.log(response.output.content);
          return response;
        case "length":
          if (!child) console.log("Generation interrupted: output length limit reached.");
          return response;
        case "error":
          if (response.error) {
            // No call ran, so the error has no call ID to answer; the model sees it as a tool response.
            console.log(`${prefix}[turn ${turn + 1}] reply rejected:`, response.error);
            this.memory.add({ role: "tool", content: JSON.stringify({ ok: false, error: response.error }) });
            // Two retries; a third unusable reply in a row ends the task.
            if (++rejected > 2) throw await this.stopped(context, request, child, `Stopped after ${rejected} unusable replies in a row.`);
            continue;
          }
          if (!child) console.log("Model returned an error outcome.");
          return response;
        case "tool_request":
          if (!calls?.length) {
            throw new Error("Model requested tools without providing tool calls.");
          }
          rejected = 0;
          break;
      }

      let toolsExhausted = false;
      for (const call of calls) {
        console.log(`${prefix}[turn ${turn + 1}] ${call.name} arguments:`, call.arguments);
        let result: unknown;
        let signature: string | undefined;
        let repeated = false;
        let rejectedArgs = false;
        try {
          if (budget.toolCalls <= 0 || (child && toolCalls >= 20)) {
            toolsExhausted = true;
            throw new Error("Tool-call budget exhausted; this tool was not executed.");
          }
          budget.toolCalls--;
          toolCalls++;
          const tool = this.tools.find((tool) => tool.name === call.name);
          if (!tool) throw new Error(`Unknown tool: ${call.name}`);

          const args: unknown = JSON.parse(call.arguments);
          if (args === null || typeof args !== "object" || Array.isArray(args)) {
            throw new Error("Tool arguments must be a JSON object.");
          }
          // The same call again gets the same answer, except when polling a program with process.
          signature = call.name + " " + JSON.stringify(args);
          const earlier = settled.get(signature) ??
            (signature === previous?.signature && call.name !== "process" ? previous.result : undefined);
          if (earlier !== undefined) {
            repeated = true;
            repeats++;
            throw new Error(`Repeated call: you ${settled.has(signature) ? "already" : "just"} made this exact call ` +
              "and got " + earlier.slice(0, 300) + ". Making it again will not change anything. " +
              nextStep(tool, args as Record<string, unknown>, earlier));
          }
          // Tools would ignore an argument their schema does not allow, so name it instead.
          const accepted = Object.keys((tool.parameters.properties ?? {}) as object);
          const unknown = Object.keys(args).filter((key) => !accepted.includes(key));
          rejectedArgs = true;
          if (tool.parameters.additionalProperties === false && unknown.length) {
            throw new Error(`Unknown argument ${unknown.join(", ")} for ${call.name}; it accepts ${accepted.join(", ")}. ` +
              nextStep(tool, args as Record<string, unknown>, '{"ok":false}'));
          }
          const problem = argumentProblem(tool, args as Record<string, unknown>);
          if (problem) throw new Error(problem);
          rejectedArgs = false;
          // Reads survive exec: edit_file and delete_file still refuse a file whose hash changed since
          // the read. Saved conversations' run_command keeps clearing them, as before.
          if (call.name === "run_command") context.readRanges.clear();
          result = await tool.execute(args as Record<string, unknown>, context);
        } catch (error) {
          if (error instanceof ModelProviderError) throw error;
          result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }

        console.log(`${prefix}[turn ${turn + 1}] ${call.name}`, result);
        if (signature && (rejectedArgs || (call.name === "edit_file" && (result as { ok?: unknown }).ok === true))) {
          settled.set(signature, JSON.stringify({ ...(result as object), content: undefined }));
        }
        if (!repeated) {
          previous = signature === undefined ? undefined :
            { signature, result: JSON.stringify({ ...(result as object), content: undefined }) };
          repeats = 0;
        }
        // A read_file or edit_file result's text follows its JSON line as-is, so the model sees the file's own quotes.
        const text = call.name === "read_file" || call.name === "edit_file" ?
          (result as { content?: unknown } | undefined)?.content : undefined;
        this.memory.add({
          role: "tool",
          toolCallId: call.id,
          content: typeof text === "string" ?
            JSON.stringify({ ...(result as object), content: undefined }) + "\n" + text :
            JSON.stringify(result) ?? "null",
        });
        if (repeats >= 3) throw await this.stopped(context, request, child, "Stopped after the same tool call was repeated 3 times in a row.");
      }
      if (toolsExhausted) throw await this.stopped(context, request, child, "Tool-call budget exhausted.");
    }

    throw await this.stopped(context, request, child, `The model did not return a final answer within ${maxCalls} calls.`);
  }

  // A stopped task gets no final answer and so no final check; the user is shown what it would report.
  private async stopped(context: ToolExecutionContext, request: number, child: boolean, message: string) {
    if (!child && this.workspace) {
      const issues = await this.finishingProblems(context, request);
      if (issues.length) console.log("Harness checks report:\n- " + issues.join("\n- "));
    }
    return new AgentLimitError(message);
  }

  // Before a final answer: new check problems in the files this request changed, changes whose
  // latest attempt failed, and a failing project test command.
  private async finishingProblems(context: ToolExecutionContext, request: number): Promise<string[]> {
    const root = realpathSync(this.workspace!);
    const messages = this.memory.messages().slice(request);
    const calls = new Map(messages.flatMap((message) => message.toolCalls ?? []).map((call) => [call.id, call]));
    const latest = new Map<string, string | undefined>(); // Path -> error of its latest change attempt.
    for (const message of messages) {
      const made = message.role === "tool" ? calls.get(message.toolCallId ?? "") : undefined;
      if (!made || (made.name !== "create_file" && made.name !== "edit_file")) continue;
      try {
        const { path } = JSON.parse(made.arguments) as { path?: unknown };
        const outcome = JSON.parse(message.content.split("\n", 1)[0]!) as { ok?: boolean; error?: string };
        if (typeof path === "string") latest.set(path, outcome.ok === true ? undefined : String(outcome.error));
      } catch {}
    }
    const issues = [...latest].flatMap(([path, error]) =>
      error === undefined ? [] : [`Your latest change to ${path} failed, so it was not made: ${error}`]);
    const files = [...context.baselines].filter(([file]) => existsSync(file));
    for (const [file, baseline] of files) {
      const problems = newProblems(baseline, checkFile(file, readFileSync(file, "utf8"), root));
      issues.push(...problems.map((problem) => relative(root, file) + ": " + problem));
    }
    return files.length ? [...issues, ...await testProblems(root)] : issues;
  }

  // A capacity rejection leaves the sidecar usable: compact and retry once, then end the turn.
  private async generate(context: ToolExecutionContext, compactable: boolean): Promise<ModelResponse> {
    try {
      return await this.modelClient.generate(this.prompt(), this.tools);
    } catch (error) {
      if (!(error instanceof Error && error.name === "ContextOverflowError")) throw new ModelProviderError(error);
      if (!compactable || !await this.compact(context)) {
        throw new AgentLimitError("The conversation no longer fits the context window.");
      }
      return this.generate(context, false);
    }
  }

  // Replaces older history in the prompt with a model-written summary. Memory keeps every
  // message; main.ts saves this.compaction with the next checkpoint.
  private async compact(context: ToolExecutionContext): Promise<boolean> {
    const before = this.contextTokens();
    let response: ModelResponse | undefined;
    try {
      // The prompt as last sent plus one instruction, so the cached prefix is reused. As a user
      // message, Qwen took the instruction for the user's request; a system message avoids that.
      response = await this.modelClient.generate([...this.prompt(), { role: "system",
        content: toolRecord(this.memory.messages()) + SUMMARY_INSTRUCTION }], this.tools, 1024);
    } catch (error) {
      if (!(error instanceof Error && error.name === "ContextOverflowError")) throw new ModelProviderError(error);
    }
    const summary = response?.conclusion === "success" ? response.output.content.trim() : "";
    if (!summary) {
      this.note("Compaction failed (" + (!response ? "capacity error" : response.conclusion === "success" ?
        "empty summary" : response.conclusion) + "); the prompt is unchanged.");
      return false;
    }
    this.compaction = chooseCompaction(this.memory.messages(), summary, this.compaction,
      (view) => this.estimate(view) <= CONTEXT_TOKENS / 2);
    this.measured = undefined;
    // Keep only reads from steps whose messages the view still shows in full. Step N of this request
    // is its Nth assistant message and records reads as turn N; other reads may have left the prompt
    // or been cut, so edits there need a fresh read.
    const messages = this.memory.messages();
    const shown = new Set(this.view());
    const visible = new Set<number>();
    let step = -1;
    let whole = false;
    for (const message of messages.slice(messages.map((message) => message.role).lastIndexOf("user") + 1)) {
      if (message.role === "assistant") {
        if (whole) visible.add(step);
        step++;
        whole = shown.has(message);
      } else whole &&= shown.has(message);
    }
    if (whole) visible.add(step);
    for (const [file, read] of context.readRanges) {
      const ranges = read.ranges.filter((range) => visible.has(range.turn));
      if (ranges.length) context.readRanges.set(file, { ...read, ranges });
      else context.readRanges.delete(file);
    }
    const k = (tokens: number) => (tokens / 1000).toFixed(1) + "K";
    this.note(`Compacted context: about ${k(before)} -> ${k(this.contextTokens())} tokens; kept messages ` +
      `${this.compaction.boundary + 1}-${this.compaction.messageCount} and a ${summary.length}-character summary.`);
    return true;
  }

  private note(text: string): void {
    console.log(text);
    this.log("[compaction] " + text + "\n");
  }

  // The messages sent to the model: the full history, or its compacted form.
  view(): Message[] {
    return compactedView(this.memory.messages(), this.compaction);
  }

  // The view plus, in conversations with update_notes, the notes block. At the end of the prompt a
  // changed block re-prefills only itself and the latest reply, never the history before them.
  private prompt(): Message[] {
    const notes = this.tools.some((tool) => tool.name === "update_notes") ? notesMessage(this.memory.messages(), this.workspace, this.programs?.()) : undefined;
    return notes ? [...this.view(), notes] : this.view();
  }

  // Records an exact count of the view's first `messages` messages, such as a preparation result.
  measure(tokens: number, messages: number): void {
    this.measured = { tokens, messages };
  }

  contextTokens(): number {
    return this.estimate(this.view(), this.measured);
  }

  // Estimated prompt: an exact count of the view's first messages, if known, plus the rest at 3 JSON
  // characters per token, which stays conservative (Qwen measured 3.3–4.4). Without a count, the
  // system prompt (always the first message) and the tool schemas are estimated the same way.
  private estimate(view: Message[], measured?: { tokens: number; messages: number }): number {
    const { tokens, messages } = measured ??
      { tokens: Math.ceil(JSON.stringify([this.identity.systemPrompt, this.tools]).length / 3), messages: 1 };
    return tokens + Math.ceil(JSON.stringify(view.slice(messages)).length / 3);
  }
  


}
