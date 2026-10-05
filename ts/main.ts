import { createInterface } from "node:readline";
import { Agent } from "./agent.js";
import { DEFAULT_SYSTEM_PROMPT } from "./src/prompts.js";
import { providerRegistry } from "./src/providers/provider-registry.js";
import { ConversationMemory } from "./src/interfaces.js";
import { createReadFileTool } from "./src/tools/readFile.js";
import { createSearchTool } from "./src/tools/search.js";
import { createEditFileTool } from "./src/tools/editFile.js";
import { createRunCommandTool } from "./src/tools/runCommand.js";

async function main() {
  const providerName = process.env.MODEL_PROVIDER ?? "llama";
  const address = providerName === "sidecar"
    ? process.env.LLAMA_MODEL_PATH : process.env.LLAMA_SERVER_ADDRESS;
  if (!address) {
    throw new Error("Set " + (providerName === "sidecar" ? "LLAMA_MODEL_PATH" : "LLAMA_SERVER_ADDRESS"));
  }
  const provider = providerRegistry.get(providerName, address);
  try {
    if (!await provider.createClient()) throw new Error("Model provider is not ready.");

    const agent = new Agent(providerName, address, {
      identity: {
        name: "test-agent",
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
      },
      model: {
        model: "bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF:Q4_K_M",
        temperature: 0.2,
        maxTokens: 2048,
      },
      tools: [
        createReadFileTool(process.cwd()),
        createSearchTool(process.cwd()),
        createEditFileTool(process.cwd()),
        createRunCommandTool(process.cwd()),
      ],
      memory: new ConversationMemory(),
    }, provider);

    const input = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      console.log("Enter a task. Type c and press Enter to exit.");
      input.setPrompt("> ");
      input.prompt();
      for await (const line of input) {
        const task = line.trim();
        if (task === "c") break;
        if (task) {
          const response = await agent.run(task);
          console.log("Conclusion:", response.conclusion);
        }
        input.prompt();
      }
    } finally {
      input.close();
    }
  } finally {
    await provider.shutdown?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1
})
