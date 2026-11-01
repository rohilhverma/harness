import type { Message, ToolDefinition } from "./interfaces.js";

const STATUSES = ["pending", "in_progress", "done"];
const CHANGES = ["create_file", "edit_file", "delete_file"];

// The model keeps its plan, a few facts and the next step here; each call replaces the previous
// notes. The tool only validates: the call itself, saved in history, is the record.
export const UPDATE_NOTES_TOOL: ToolDefinition = {
  name: "update_notes",
  description: "Replace your pinned notes for the user's current request: a short plan with each step's status, " +
    "key facts and the next step. For a request with several steps, call it before the other tools and again " +
    "after each step. The notes are shown at the end of every prompt and survive compaction. " +
    "Keep the whole call under 800 characters.",
  parameters: {
    type: "object",
    properties: {
      plan: { type: "array", maxItems: 8, items: { type: "object", properties: {
        step: { type: "string", minLength: 1, maxLength: 120 },
        status: { type: "string", enum: STATUSES },
      }, required: ["step", "status"], additionalProperties: false } },
      facts: { type: "array", items:{ type: "string", minLength: 1, maxLength: 160 } },
      next: { type: "string", maxLength: 200 },
    },
    required: ["plan", "next"],
    additionalProperties: false,
  },
  async execute(args) {
    const problem = notesProblem(normalizeNotes(args));
    if (problem) throw new Error(problem);
    return { ok: true };
  },
};

// The notes with facts or next that the model put inside a plan item moved to the top level, where
// they belong: facts are added to the top-level ones, and a top-level next wins over an item's.
// Validation and the notes shown both use this.
export function normalizeNotes(args: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(args.plan)) return args;
  const notes: Record<string, unknown> = { ...args };
  notes.plan = args.plan.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const { facts, next, ...kept } = item as Record<string, unknown>;
    if (facts !== undefined) {
      notes.facts = Array.isArray(notes.facts) && Array.isArray(facts) ? [...notes.facts, ...facts] : notes.facts ?? facts;
    }
    if (next !== undefined) notes.next ??= next;
    return kept;
  });
  return notes;
}

// The first thing wrong with the notes, named precisely enough to fix in one try.
function notesProblem(args: Record<string, unknown>): string | undefined {
  const { plan, facts = [], next } = args;
  const text = (value: unknown, limit: number) => typeof value === "string" && value.trim() !== "" && value.length <= limit;
  const extra = Object.keys(args).filter((key) => !["plan", "facts", "next"].includes(key));
  if (extra.length) return `update_notes takes only plan, facts and next; remove ${extra.join(", ")}.`;
  if (!Array.isArray(plan) || plan.length > 8) return "plan must be a list of up to 8 {step, status} items.";
  for (const [index, item] of plan.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return `plan[${index}] must be an object {step, status}.`;
    const keys = Object.keys(item).filter((key) => key !== "step" && key !== "status");
    if (keys.length) {
      return `plan[${index}] has ${keys.join(", ")}; a plan item holds only step and status` +
        (keys.some((key) => key === "facts" || key === "next") ? ", and facts and next go once at the top level." : ".");
    }
    if (!text(item.step, 120)) return `plan[${index}].step must be a nonempty string of up to 120 characters.`;
    if (!STATUSES.includes(item.status)) {
      return `plan[${index}].status must be pending, in_progress or done, not ${JSON.stringify(item.status)}.`;
    }
  }
  if (!Array.isArray(facts)) return "facts must be a list of strings.";
  const fact = facts.findIndex((value) => !text(value, 160));
  if (fact >= 0) return `facts[${fact}] must be a nonempty string of up to 160 characters.`;
  if (typeof next !== "string" || next.length > 200) return "next must be one string of up to 200 characters.";
  const length = JSON.stringify(args).length;
  if (length > 800) return `The notes are ${length} characters; keep the whole call under 800.`;
  return undefined;
}

function short(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? line.slice(0, limit) + "…" : line;
}

// The first line: a read_file or edit_file result's text follows it.
function result(message: Message): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(message.content.split("\n", 1)[0]!);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

// The notes block: the workspace, the harness's objective, changed files, last error and exec programs
// around the model's plan. It is built from the full history, so resume, rewind and fork show the same
// notes; it is sent at the end of the prompt and never stored.
export function notesMessage(messages: Message[], workspace?: string,
    programs: { process_id: string; command: string; state: string }[] = []): Message | undefined {
  const calls = new Map(messages.flatMap((message) => message.toolCalls ?? []).map((call) => [call.id, call]));
  const call = (message: Message) => message.role === "tool" ? calls.get(message.toolCallId ?? "") : undefined;
  const requests = messages.flatMap((message, index) => message.role === "user" ? [index] : []);
  const request = requests.at(-1);
  if (request === undefined) return undefined;
  // A request that ended without a final answer is still the task, so a follow-up such as "go ahead"
  // does not replace it as the objective. A final answer is a reply with no tool call, not followed by a
  // rejection or the harness check sending it back.
  const answered = (start: number, end: number) => messages.slice(start + 1, end).some((message, index, span) =>
    message.role === "assistant" && !message.toolCalls?.length && !["tool", "system"].includes(span[index + 1]?.role ?? ""));
  let first = requests.length - 1;
  while (first > 0 && !answered(requests[first - 1]!, requests[first]!)) first--;
  const objective = requests[first]!;
  const lines = ["Notes (shown every turn; keep the plan current with update_notes):",
    // Tools only take relative paths, so without this the model cannot tell the user where files are.
    ...(workspace ? ["Workspace: " + workspace + " (a folder on the user's computer; tool paths are relative " +
      "to it, and the user can open or run files there)"] : []),
    "Objective: " + short(messages[objective]!.content, 250),
    ...(objective !== request ? ["Latest message: " + short(messages[request]!.content, 250)] : [])];
  const saved = messages.slice().reverse().find((message) => call(message)?.name === "update_notes" && result(message)?.ok === true);
  if (saved) {
    const { plan, facts = [], next } = normalizeNotes(JSON.parse(call(saved)!.arguments)) as
      { plan: { step: string; status: string }[]; facts?: string[]; next: string };
    lines.push("Plan:", ...plan.map((item, index) => (index + 1) + ". [" + item.status.replace("_", " ") + "] " + item.step));
    if (facts.length) lines.push("Facts:", ...facts.map((fact) => "- " + fact));
    if (next) lines.push("Next: " + next);
  }
  const changed = messages.flatMap((message) => {
    const made = call(message);
    if (!made || !CHANGES.includes(made.name) || result(message)?.ok !== true) return [];
    try { return [String(JSON.parse(made.arguments).path)]; } catch { return []; }
  });
  const files = changed.filter((path, index) => changed.lastIndexOf(path) === index).slice(-8);
  if (files.length) lines.push("Files changed: " + short(files.join(", "), 250));
  // Only this task's latest failure, and only until a later call of the same tool on the same path
  // succeeds (any later success, for a rejected reply): a resolved error would keep steering the model.
  const task = messages.slice(objective);
  const target = (message: Message) => {
    const made = call(message);
    if (!made) return undefined;
    try { return made.name + " " + JSON.parse(made.arguments).path; } catch { return made.name; }
  };
  const failed = task.map((message) => message.role === "tool" && result(message)?.ok !== true).lastIndexOf(true);
  const failure = failed < 0 ? undefined : task[failed]!;
  if (failure && !task.slice(failed + 1).some((message) => message.role === "tool" && result(message)?.ok === true &&
      (target(failure) === undefined || target(message) === target(failure)))) {
    const error = result(failure)?.error;
    lines.push("Last tool error: " + (call(failure)?.name ?? "tool") + ": " + short(typeof error === "string" ? error : failure.content, 150));
  }
  // Live rather than from history, but programs stop when the conversation changes, so resume, rewind
  // and fork start without any.
  if (programs.length) {
    const running = programs.find((program) => program.state === "running");
    lines.push("Programs from exec: " + short(programs.map((program) => program.process_id + " " + program.state + ": " +
      program.command).join("; "), 250) + "." + (running ? " The user can use a running terminal program in this " +
      "terminal by typing /attach and its id, such as /attach " + running.process_id + ". Stop a program you started " +
      "only to test it." : ""));
  }
  return { role: "system", content: lines.join("\n") };
}
