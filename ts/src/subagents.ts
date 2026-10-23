import { Agent, ModelProviderError } from "../agent.js";
import { ConversationMemory } from "./interfaces.js";
import type { ModelConfiguration, ModelProvider, ToolDefinition } from "./interfaces.js";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts.js";

// Children evaluate in their own cache sequence so the parent's cached prompt survives delegation.
const CHILD_SEQUENCE = 1;

export const SUBAGENT_TOOL: Omit<ToolDefinition, "execute"> = {
  name: "delegate",
  description: "Run one foreground Reader or Writer on a bounded assignment. The parent waits. Reader searches/reads; Writer also creates/edits/deletes in this workspace. No child commands, tests or further delegation. Partial edits remain on failure; returned claims need verification.",
  parameters: {
    type: "object",
    properties: {
      profile: { type: "string", enum: ["reader", "writer"] },
      task: { type: "string", minLength: 1, maxLength: 2000, description: "Requested outcome and acceptance criteria." },
      context: { type: "string", maxLength: 6000, description: "Relevant constraints, source hints and explicitly labeled assumptions." },
    },
    required: ["profile", "task"],
    additionalProperties: false,
  },
};

type Report = {
  status: "completed" | "blocked" | "failed";
  summary: string;
  evidence: string[];
  unresolvedQuestions: string[];
};

function strings(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum &&
    value.every((item) => typeof item === "string" && item.length <= 240);
}

function parseReport(text: string): Report {
  if (Buffer.byteLength(text) > 4096) throw new Error("Child report exceeds 4 KiB.");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !("status" in value) || typeof value.status !== "string" || !["completed", "blocked", "failed"].includes(value.status) ||
      !("summary" in value) || typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 1600 ||
      !("evidence" in value) || !strings(value.evidence, 6) ||
      !("unresolvedQuestions" in value) || !strings(value.unresolvedQuestions, 4)) {
    throw new Error("Child returned an invalid status/summary/evidence/unresolvedQuestions report.");
  }
  return { status: value.status as Report["status"], summary: value.summary,
    evidence: value.evidence, unresolvedQuestions: value.unresolvedQuestions };
}

export function createSubagentTool(
  provider: ModelProvider<unknown>, model: ModelConfiguration, tools: ToolDefinition[],
): ToolDefinition {
  return {
    ...SUBAGENT_TOOL,
    async execute(args, context) {
      const { profile, task, context: hints = "" } = args;
      if (context.depth !== 0) throw new Error("Only the parent may delegate.");
      if ((profile !== "reader" && profile !== "writer") ||
          typeof task !== "string" || !task.trim() || task.length > 2000 ||
          typeof hints !== "string" || hints.length > 6000 ||
          Object.keys(args).some((key) => !["profile", "task", "context"].includes(key))) {
        throw new Error("Use reader/writer, a nonempty task up to 2000 characters and context up to 6000 characters.");
      }
      const brief = JSON.stringify({ userRequest: context.userTask, assignment: task, context: hints });
      if (Buffer.byteLength(brief) > 12 * 1024) throw new Error("Child brief exceeds 12 KiB; reduce the supplied context.");
      if (context.budget.delegations <= 0 || context.budget.modelCalls <= 2) {
        throw new Error("No delegation budget remains; continue directly.");
      }
      context.budget.delegations--;
      const operations: { tool: string; path?: string; ok: boolean }[] = [];
      let omittedOperations = 0;
      const allowed = profile === "reader" ? ["search", "read_file"] :
        ["search", "read_file", "create_file", "edit_file", "delete_file"];
      const childTools = tools.filter((tool) => allowed.includes(tool.name)).map((tool) => ({
        ...tool,
        async execute(args: Record<string, unknown>, childContext: Parameters<ToolDefinition["execute"]>[1]) {
          let result: unknown;
          try { result = await tool.execute(args, childContext); return result; }
          finally {
            const operation = { tool: tool.name, path: typeof args.path === "string" ? args.path : undefined,
              ok: !!result && typeof result === "object" && "ok" in result && result.ok === true };
            if (Buffer.byteLength(JSON.stringify([...operations, operation])) <= 4096) operations.push(operation);
            else omittedOperations++;
          }
        },
      }));
      const instructions = (profile === "writer" ? DEFAULT_SYSTEM_PROMPT :
        "You are a read-only code investigator. Use search/read_file to discover and inspect relevant files. Check limited search results and page reads when needed.") + `
You are a ${profile} child working on one assignment. Follow the user request and supplied constraints; context may contain assumptions. Discover relevant files and report contrary evidence and unresolved questions. Neither run commands nor delegate. Writer edits are live in the shared workspace; no automatic rollback occurs.
Return only JSON, with status completed, blocked or failed. Example: {"status":"completed","summary":"...","evidence":["path:line and finding"],"unresolvedQuestions":[]}. Summary: at most 1600 characters; evidence: at most 6 strings of 240 characters; questions: at most 4 strings of 240 characters. Entire report: at most 4 KiB. State that checks were not run. Completed means the assignment is prepared, not independently verified.`;
      const childProvider: ModelProvider<unknown> = {
        createClient: () => provider.createClient(),
        generate: (request) => provider.generate({ ...request, sequence: CHILD_SEQUENCE }),
      };
      const child = new Agent({ identity: { name: profile, systemPrompt: instructions },
        model: { ...model, maxTokens: Math.min(model.maxTokens ?? 2048, 1024) },
        tools: childTools, memory: new ConversationMemory() }, childProvider);
      let report: Report;
      try {
        const response = await child.run(brief, context.budget);
        if (response.conclusion !== "success") throw new Error("Child ended with " + response.conclusion + ".");
        report = parseReport(response.output.content);
      } catch (error) {
        if (error instanceof ModelProviderError) throw error;
        report = { status: "failed", summary: (error instanceof Error ? error.message : String(error)).slice(0, 1600),
          evidence: [], unresolvedQuestions: [] };
      } finally {
        if (profile === "writer") context.readRanges.clear();
      }
      try { await provider.release?.(CHILD_SEQUENCE); } catch (error) { throw new ModelProviderError(error); }
      return { ...report, operations, omittedOperations, checks: "not_run" };
    },
  };
}
