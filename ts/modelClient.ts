import type {
  Message,
  ModelConfiguration,
  ModelProvider,
  ModelResponse,
} from "./src/interfaces.js";

export class ModelClient {
  constructor(
    private readonly provider: ModelProvider<unknown>,
    private readonly configuration: ModelConfiguration,
  ) {}

  generate(messages: Message[]): Promise<ModelResponse> {
    return this.provider.generate({
      messages,
      model: this.configuration.model,
      temperature: this.configuration.temperature,
    });
  }
}
