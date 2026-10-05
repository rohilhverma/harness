import type {
  Message,
  ModelConfiguration,
  ModelProvider,
  ModelResponse,
  ToolDefinition,
} from "./src/interfaces.js";

export class ModelClient {
  constructor(
    private readonly provider: ModelProvider<unknown>,
    private readonly configuration: ModelConfiguration,
  ) {}

  generate(messages: Message[], tools: ToolDefinition[] = []): Promise<ModelResponse> {
    return this.provider.generate({
      messages, 
      model: this.configuration.model,
      temperature: this.configuration.temperature,
      maxTokens: this.configuration.maxTokens,
      seed: this.configuration.seed,
      tools: tools.length ? tools : undefined,
      });
  }
}
