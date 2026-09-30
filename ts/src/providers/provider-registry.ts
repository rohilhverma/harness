import type { ModelProvider } from "../interfaces.js";
import { OllamaServer } from "./ollama.js";
import { OpenAIServer } from "./thirdparty.js";

class ProviderRegistry {
  private readonly providers =
    new Map<string, Map<string, ModelProvider<unknown>>>();

  register(
    name: string,
    address: string,
    apiKey?: string,
  ): ModelProvider<unknown> {
    let provider: ModelProvider<unknown>;

    switch (name) {
      case "ollama":
        provider = new OllamaServer(address);
        break;

      case "openrouter":
      case "opencode":
        if (!apiKey) {
          throw new Error(`${name} requires an API key`);
        }
        provider = new OpenAIServer(address, apiKey);
        break;

      default:
        throw new Error(`Unknown provider: ${name}`);
    }

    let connections = this.providers.get(name);

    if (!connections) {
      connections = new Map<string, ModelProvider<unknown>>();
      this.providers.set(name, connections);
    }

    connections.set(address, provider);
    return provider;
  }

  get(
    name: string,
    address: string,
    apiKey?: string,
  ): ModelProvider<unknown> {
    const provider = this.providers.get(name)?.get(address);

    return provider ?? this.register(name, address, apiKey);
  }
}

export const providerRegistry = new ProviderRegistry();
