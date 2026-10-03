import { Agent } from "./agent.js";
import { DEFAULT_SYSTEM_PROMPT } from "./src/prompts.js";
import { providerRegistry } from "./src/providers/provider-registry.js";
import { ConversationMemory } from "./src/interfaces.js";
import { createReadFileTool } from "./src/tools/readFile.js";
import { createSearchTool } from "./src/tools/search.js";
import { createEditFileTool } from "./src/tools/editFile.js";
import { createRunCommandTool } from "./src/tools/runCommand.js";

async function main() {
  const address = process.env.LLAMA_SERVER_ADDRESS;
  if (!address) {
    throw new Error("Set LLAMA_SERVER_ADDRESS before running");
  }

  const agent = new Agent("llama", address, {
    identity: {
      name: "test-agent",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    },
    model: {
      model: "bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF:Q4_K_M",
      temperature: 0.2,
    },
    tools: [
      createReadFileTool(process.cwd()),
      createSearchTool(process.cwd()),
      createEditFileTool(process.cwd()),
      createRunCommandTool(process.cwd()),
    ],
    memory: new ConversationMemory(),
  });

  const response = await agent.run(
    ``,
  );
  console.log("Conclusion:", response.conclusion);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1
})
