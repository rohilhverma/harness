import { Agent } from "./agent.js";
import { DEFAULT_SYSTEM_PROMPT } from "./src/prompts.js";
import { providerRegistry } from "./src/providers/provider-registry.js";

async function main() {
  process.loadEnvFile(".env");

  const address = process.env.LLAMA_SERVER_ADDRESS;
  if (!address) {
    throw new Error("Set LLAMA_SERVER_ADDRESS before running");
  }

  providerRegistry.get("llama", address);

  const agent = new Agent("llama", address, {
    identity: {
      name: "test-agent",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    },
    model: {
      model: "bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF:Q4_K_M",
      temperature: 0.2,
    },
    tools: [],
    memory: [],
  });

  const response = await agent.run(
    "Hello! Please reply with a short goodbye. Then talk to me about how to tie a shoelace",
  );

  console.log("Conclusion:", response.conclusion);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
