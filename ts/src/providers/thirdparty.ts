import OpenAI from "openai";

import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "../interfaces.js";

export class OpenAIServer implements ModelProvider<OpenAI> {
  private readonly client: OpenAI;

  constructor(
    private readonly address: string,
    private readonly apiKey: string,
    private readonly headers?: Record<string, string>,
  ) {
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.address,
      defaultHeaders: this.headers,
    });
  }

  async createClient(): Promise<OpenAI | null> {
    const serverOnline = await this.serverStatus();
    if (serverOnline) {
      return this.client;
    }

    return null;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (!request.model) {
      throw new Error("A model is required");
    }

    const messages = request.messages.map(
      (message): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
        if (message.role === "tool") {
          if (!message.toolCallId) throw new Error("A tool result requires a tool-call ID.");
          return {
            role: "tool",
            content: message.content,
            tool_call_id: message.toolCallId,
          };
        }

        if (message.role === "assistant") {
          return {
            role: "assistant",
            content: message.content || null,
            tool_calls: message.toolCalls?.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          };
        }

        return { role: message.role, content: message.content };
      },
    );

    const response = await this.client.chat.completions.create({
      model: request.model,
      messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      seed: request.seed,
      stream: false,
      parallel_tool_calls: true,
      tools: request.tools?.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("The provider returned no response");
    }

    return {
      output: {
        role: "assistant",
        content: choice.message.content ?? "",
        toolCalls: choice.message.tool_calls?.map((call) => {
          if (call.type !== "function") throw new Error("Unsupported tool-call type.");
          return {
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          };
        }),
      },
      conclusion:
        choice.finish_reason === "tool_calls" ? "tool_request" :
        choice.finish_reason === "length" ? "length" :
        choice.finish_reason === "stop" ? "success" : "error",
    };
  }

  async serverStatus(): Promise<boolean> {
    try {
      const response = await fetch(`${this.address}/models`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...this.headers,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
