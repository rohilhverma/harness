import { ModelClient } from "./modelClient.js";
import type {
  AgentConfiguration,
  AgentIdentity,
  ConversationMemory,
  ModelConfiguration,
  ModelProvider,
  ModelResponse,
  RunBudget,
  ToolDefinition,
  ToolExecutionContext,
} from "./src/interfaces.js";


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
  private readonly modelClient: ModelClient;
  // Exact sidecar count for the first `messages` messages, from the latest generation.
  private measured?: { tokens: number; messages: number };

  
  constructor(
    configuration: AgentConfiguration,
    provider: ModelProvider<unknown>,
  ) {
    this.identity = configuration.identity;
    this.model = configuration.model;
    this.tools = configuration.tools;
    this.memory = configuration.memory
    this.modelClient = new ModelClient(provider, this.model);
  }

  async run(userPrompt: string, parentBudget?: RunBudget): Promise<ModelResponse> {
    if (this.memory.messages().length === 0) {
      this.memory.add({ role: "system", content: this.identity.systemPrompt });
    }
    this.memory.add({ role: "user", content: userPrompt });

    const child = parentBudget !== undefined;
    const budget = parentBudget ?? {
      modelCalls: 20,
      toolCalls: this.tools.some((tool) => tool.name === "delegate") ? 80 : Infinity,
      delegations: 3,
    };
    const maxCalls = child ? 6 : 20;
    let toolCalls = 0;
    const prefix = child ? `[subagent ${this.identity.name}] ` : "";
    const context: ToolExecutionContext = {
      budget,
      depth: child ? 1 : 0,
      userTask: userPrompt,
      turn: 0,
      readRanges: new Map(),
    };

    for (let turn = 0; turn < maxCalls; turn++) {
      if (budget.modelCalls <= (child ? 2 : 0)) {
        throw new AgentLimitError("Task model-call budget exhausted; children reserve two calls for the parent.");
      }
      budget.modelCalls--;
      context.turn = turn;
      let response: ModelResponse;
      try {
        response = await this.modelClient.generate(this.memory.messages(), this.tools);
      } catch (error) {
        throw new ModelProviderError(error);
      }
      this.memory.add(response.output);
      this.measured = { tokens: response.usage.promptTokens + response.usage.generatedTokens,
        messages: this.memory.messages().length };

      const calls = response.output.toolCalls;
      switch (response.conclusion) {
        case "success":
          if (calls?.length) {
            throw new Error("Model returned success with tool calls.");
          }
          if (!child) console.log(response.output.content);
          return response;
        case "length":
          if (!child) console.log("Generation interrupted: output length limit reached.");
          return response;
        case "error":
          if (!child) console.log("Model returned an error outcome.");
          return response;
        case "tool_request":
          if (!calls?.length) {
            throw new Error("Model requested tools without providing tool calls.");
          }
          break;
      }

      let toolsExhausted = false;
      for (const call of calls) {
        console.log(`${prefix}[turn ${turn + 1}] ${call.name} arguments:`, call.arguments);
        let result: unknown;
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
          if (call.name === "run_command") context.readRanges.clear();
          result = await tool.execute(args as Record<string, unknown>, context);
        } catch (error) {
          if (error instanceof ModelProviderError) throw error;
          result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }

        console.log(`${prefix}[turn ${turn + 1}] ${call.name}`, result);
        this.memory.add({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify(result) ?? "null",
        });
      }
      if (toolsExhausted) throw new AgentLimitError("Tool-call budget exhausted.");
    }

    throw new AgentLimitError(`The model did not return a final answer within ${maxCalls} calls.`);
  }

  // Estimated next prompt: the latest exact count plus newer messages at 3 JSON characters per
  // token, which stays conservative (Qwen measured 3.3–4.4). Before any count, the system prompt
  // (always the first message) and the tool schemas are estimated the same way.
  contextTokens(): number {
    const { tokens, messages } = this.measured ??
      { tokens: Math.ceil(JSON.stringify([this.identity.systemPrompt, this.tools]).length / 3), messages: 1 };
    return tokens + Math.ceil(JSON.stringify(this.memory.messages().slice(messages)).length / 3);
  }
  


}
