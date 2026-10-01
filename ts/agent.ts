import { ModelClient } from "./modelClient.js";
import type {
  AgentConfiguration,
  AgentIdentity,
  MemoryConfiguration,
  ModelConfiguration,
  ToolConfiguration,
} from "./src/interfaces.js";
import { providerRegistry } from "./src/providers/provider-registry.js";

export class Agent implements AgentConfiguration {
  identity: AgentIdentity;
  model: ModelConfiguration;
  tools: ToolConfiguration[];
  memory: MemoryConfiguration[];
  private readonly modelClient: ModelClient;

  constructor(
    providerName: string,
    addr: string,
    configuration: AgentConfiguration,
  ) {
    this.identity = configuration.identity;
    this.model = configuration.model;
    this.tools = configuration.tools;
    this.memory = configuration.memory;

    const provider = providerRegistry.get(providerName, addr);
    this.modelClient = new ModelClient(provider, this.model);
  }

  async run(userPrompt: string) {
    const response = await this.modelClient.generate([
      {
        role: "system",
        content: this.identity.systemPrompt,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ]);

    console.log(response.output.content);
    return response;
  }
  


}
