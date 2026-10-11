import { ModelClient } from "./modelClient.js";
import type {
  AgentConfiguration,
  AgentIdentity,
  ConversationMemory,
  ModelConfiguration,
  ModelProvider,
  ModelResponse,
  ToolDefinition,
  ToolExecutionContext,
} from "./src/interfaces.js";


export class Agent implements AgentConfiguration {
  
  identity: AgentIdentity;
  model: ModelConfiguration;
  tools: ToolDefinition[];
  memory: ConversationMemory;
  private readonly modelClient: ModelClient;

  
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

  async run(userPrompt: string) {
    if (this.memory.messages().length === 0) {
      this.memory.add({ role: "system", content: this.identity.systemPrompt });
    }
    this.memory.add({ role: "user", content: userPrompt });

    const context: ToolExecutionContext = {
      turn: 0,
      readRanges: new Map(),
    };

    for (let turn = 0; turn < 20; turn++) {
      context.turn = turn;
      let response: ModelResponse;
      try {
        response = await this.modelClient.generate(this.memory.messages(), this.tools);
      } catch (error) {
        const failure = new Error("Model provider failed to generate a response.", { cause: error });
        failure.name = "ModelProviderError";
        throw failure;
      }
      this.memory.add(response.output);

      const calls = response.output.toolCalls;
      switch (response.conclusion) {
        case "success":
          if (calls?.length) {
            throw new Error("Model returned success with tool calls.");
          }
          console.log(response.output.content);
          return response;
        case "length":
          console.log("Generation interrupted: output length limit reached.");
          return response;
        case "error":
          console.log("Model returned an error outcome.");
          return response;
        case "tool_request":
          if (!calls?.length) {
            throw new Error("Model requested tools without providing tool calls.");
          }
          break;
      }

      for (const call of calls) {
        console.log(`[turn ${turn + 1}] ${call.name} arguments:`, call.arguments);
        let result: unknown;
        try {
          const tool = this.tools.find((tool) => tool.name === call.name);
          if (!tool) throw new Error(`Unknown tool: ${call.name}`);

          const args: unknown = JSON.parse(call.arguments);
          if (args === null || typeof args !== "object" || Array.isArray(args)) {
            throw new Error("Tool arguments must be a JSON object.");
          }
          if (call.name === "run_command") context.readRanges.clear();
          result = await tool.execute(args as Record<string, unknown>, context);
        } catch (error) {
          result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }

        console.log(`[turn ${turn + 1}] ${call.name}`, result);
        this.memory.add({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify(result) ?? "null",
        });
      }
    }

    throw new Error("The demo requires a final answer within six model calls.");
  }
  


}
