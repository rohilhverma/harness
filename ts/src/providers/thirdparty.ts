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

    if (request.tools) {
      throw new Error("Tool support is not implemented yet");
    }

    const messages = request.messages.map((message) => {
      if (message.role === "tool" || message.toolCalls?.length) {
        throw new Error("Tool support is not implemented yet");
      }

      return {
        role: message.role,
        content: message.content,
      };
    });

    const response = await this.client.chat.completions.create({
      model: request.model,
      messages,
      temperature: request.temperature,
      stream: false,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("The provider returned no response");
    }

    return {
      output: {
        role: "assistant",
        content: choice.message.content ?? "",
      },
      conclusion: choice.finish_reason === "length" ? "length" : "success",
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
