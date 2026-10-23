import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Agent, AgentLimitError } from "./agent.js";
import { DEFAULT_SYSTEM_PROMPT, LEGACY_SYSTEM_PROMPT, DELEGATING_SYSTEM_PROMPT } from "./src/prompts.js";
import { CONTEXT_TOKENS, SidecarProvider } from "./src/providers/sidecar.js";
import { ConversationMemory } from "./src/interfaces.js";
import type { ToolDefinition } from "./src/interfaces.js";
import { createSubagentTool, SUBAGENT_TOOL } from "./src/subagents.js";
import { ConversationStore } from "./src/conversationStore.js";
import { createReadFileTool } from "./src/tools/readFile.js";
import { createSearchTool } from "./src/tools/search.js";
import { createEditFileTool } from "./src/tools/editFile.js";
import { createRunCommandTool } from "./src/tools/runCommand.js";
import { createCreateFileTool } from "./src/tools/createFile.js";
import { createDeleteFileTool } from "./src/tools/deleteFile.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--resume")) {
    throw new Error("Usage: runner [--resume <conversation-id>]");
  }
  const modelPath = process.env.LLAMA_MODEL_PATH;
  if (!modelPath) throw new Error("Set LLAMA_MODEL_PATH");
  const workspace = process.cwd();
  const diagnosticsPath = resolve(process.env.HARNESS_MODEL_LOG ?? resolve(workspace, "logs",
    "model-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + process.pid + ".log"));
  mkdirSync(dirname(diagnosticsPath), { recursive: true });
  appendFileSync(diagnosticsPath, "");
  let diagnosticsFailed = false;
  function diagnostics(text: string) {
    if (!diagnosticsFailed) {
      try { appendFileSync(diagnosticsPath, text); return; }
      catch (error) {
        diagnosticsFailed = true;
        console.error("Model log failed; diagnostics will appear here:", error);
      }
    }
    process.stderr.write(text);
  }
  console.log("Model diagnostics:", diagnosticsPath);
  const tools = [createReadFileTool(workspace), createSearchTool(workspace),
    createEditFileTool(workspace), createRunCommandTool(workspace),
    createCreateFileTool(workspace), createDeleteFileTool(workspace)];
  const configuration = {
    workspace, modelPath, generation: { temperature: 0.2, maxTokens: 2048 },
    tools: [...tools.map(({ name, description, parameters }) => ({ name, description, parameters })), SUBAGENT_TOOL],
  };
  type Opened = Awaited<ReturnType<typeof ConversationStore.open>>;

  function selectTools<T extends Pick<ToolDefinition, "name" | "description" | "parameters">>(
    available: T[], descriptors: typeof configuration.tools,
  ): T[] {
    return descriptors.map((descriptor) => {
      const tool = available.find((candidate) => candidate.name === descriptor.name);
      if (!tool || JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }) !== JSON.stringify(descriptor)) {
        throw new Error("Saved tool is unavailable or changed: " + descriptor.name);
      }
      return tool;
    });
  }

  async function openConversation(selection: Parameters<typeof ConversationStore.open>[0]) {
    const selected = selection.mode === "create" ? configuration : {
      ...configuration,
      tools: (await ConversationStore.inspect(workspace, selection.conversationId)).header.configuration.tools,
    };
    selectTools([...tools, SUBAGENT_TOOL], selected.tools);
    return ConversationStore.open(selection, selected);
  }

  function owner(opened: Opened) {
    const toolRoot = opened.store.workingDirectory;
    const provider = new SidecarProvider(opened.configuration.modelPath, undefined, undefined, diagnostics);
    const available = [createReadFileTool(toolRoot), createSearchTool(toolRoot),
      createEditFileTool(toolRoot), createRunCommandTool(toolRoot, opened.store.header.v === 2),
      createCreateFileTool(toolRoot), createDeleteFileTool(toolRoot)];
    const ownerTools = selectTools([...available,
      createSubagentTool(provider, opened.configuration.generation, available)], opened.configuration.tools);
    const defaultPrompt = ownerTools.some((tool) => tool.name === SUBAGENT_TOOL.name) ? DELEGATING_SYSTEM_PROMPT : ownerTools.some((tool) => tool.name === "create_file") &&
      ownerTools.some((tool) => tool.name === "delete_file") ? DEFAULT_SYSTEM_PROMPT : LEGACY_SYSTEM_PROMPT;
    const memory = new ConversationMemory();
    for (const message of opened.messages) memory.add(message);
    diagnostics("\n[conversation] " + opened.store.conversationId + "\n");
    const agent = new Agent({ identity: { name: "main agent",
      systemPrompt: opened.messages[0]?.content ?? defaultPrompt },
      model: opened.configuration.generation, tools: ownerTools, memory }, provider);
    return { ...opened, memory, provider, agent, tools: ownerTools, stopping: false, closed: false,
      preparationFailure: undefined as unknown };
  }
  type Owner = ReturnType<typeof owner>;

  async function close(current: Owner) {
    if (current.closed) return;
    current.stopping = true;
    current.closed = true;
    try { await current.provider.shutdown(); } finally { await current.store.close(); }
  }

  async function start(opened: Opened) {
    const current = owner(opened);
    try {
      if (opened.messages.length && opened.messages[0]?.role !== "system") {
        throw new Error("Saved conversation is missing its initial system message.");
      }
      await current.provider.createClient();
      return current;
    } catch (error) { await close(current); throw error; }
  }

  let active = await start(await openConversation(
    args.length ? { mode: "resume", conversationId: args[1]! } : { mode: "create" }));
  let input: ReturnType<typeof createInterface> | undefined;
  function prepare(current: Owner) {
    if (!current.messages.length) return;
    console.log("Preparing context… You can type your next message.");
    void current.provider.prepare({ messages: current.memory.messages(), tools: current.tools }).catch((error: unknown) => {
      if (current.stopping) return;
      current.preparationFailure = error;
      current.stopping = true;
      process.exitCode = 1;
      console.error("Conversation preparation failed:", current.store.conversationId, error);
      input?.close();
    });
  }
  function label(current: Owner) {
    return current.store.header.label ??
      (current.store.conversationId === current.store.rootConversationId ? "main" : current.store.conversationId.slice(0, 8));
  }
  function prompt() {
    // Estimated next prompt / prompt limit (context minus the output allowance, plus one).
    const limit = CONTEXT_TOKENS - active.configuration.generation.maxTokens + 1;
    const k = (tokens: number) => (tokens / 1000).toFixed(1) + "K";
    input?.setPrompt(label(active) + " " + k(active.agent.contextTokens()) + "/" + k(limit) + " >> ");
    input?.prompt();
  }
  function showActive() {
    console.log("Conversation:", label(active), active.store.conversationId);
    const coding = active.store.header.v === 2;
    console.log(coding ? "Coding workspace:" : "Legacy shared workspace:", active.store.workingDirectory);
    const testFile = coding ? "AGENT_TEST.md" : "sessions/" + active.store.conversationId + "/AGENT_TEST.md";
    if (existsSync(resolve(active.store.workingDirectory, testFile))) console.log("Test file:", testFile);
  }
  function help() {
    console.log("/checkpoints | /show N | /rewind N | /fork N NAME | /conversations | /switch NAME_OR_UUID");
    console.log("Transitions accept --discard-unsaved. Names use lowercase letters/digits/hyphens/underscores (1–64), excluding main/UUIDs.");
    console.log("Select unnamed conversations by the full UUID shown beside their short display label.");
    console.log("Use // to send a prompt beginning /. c and Enter exits. Coding rewind restores this workspace; fork creates an independent workspace. #0 is the initial state. Legacy conversations change history only.");
  }

  async function transition(selection: Parameters<typeof ConversationStore.open>[0], discard: boolean) {
    if (selection.mode === "resume" && selection.conversationId === active.store.conversationId) {
      console.log("Already active:", active.store.conversationId);
      return;
    }
    if (!discard && active.store.hasUnsavedMessages(active.memory.messages())) {
      throw new Error("Unsaved attempts would be dropped. Add --discard-unsaved to this transition to discard them.");
    }
    // Acquire/validate the target before closing the original. No target inference starts yet.
    const target = await openConversation(selection);
    if ((target.messages.length ? target.messages[0]?.role !== "system" : target.store.header.v !== 2) || active.stopping) {
      if (active.stopping) console.log(selection.mode === "branch" ?
        "Created " + target.store.conversationId + ", but did not switch because preparation failed." :
        "Did not switch to " + target.store.conversationId + " because preparation failed.");
      await target.store.close();
      if (active.stopping) return;
      throw new Error("Saved conversation is missing its initial system message.");
    }
    const originalId = active.store.conversationId;
    try {
      await close(active);
      active = await start(target);
    } catch (error) {
      try { await target.store.close(); } catch (cleanupError) {
        console.error("Target cleanup failed:", target.store.conversationId, cleanupError);
      }
      throw new Error("Transition stopped. Saved original " + originalId + "; target " + target.store.conversationId + ".", { cause: error });
    }
    showActive();
    if (target.sourceCheckpoint) console.log((target.messages.length ? "Child checkpoint #1" : "Child baseline #0") + " from source checkpoint #" + target.sourceCheckpoint.ordinal,
      target.sourceCheckpoint.id);
    prepare(active);
  }

  async function rewind(ordinal: number, discard: boolean) {
    if (active.store.header.v === 1) {
      await transition({ mode: "branch", conversationId: active.store.conversationId, checkpointOrdinal: ordinal }, discard);
      return;
    }
    if (!discard && active.store.hasUnsavedMessages(active.memory.messages())) {
      throw new Error("Unsaved attempts would be dropped. Add --discard-unsaved to discard their messages; current files will be captured before rewind.");
    }
    await ConversationStore.inspect(workspace, active.store.conversationId, ordinal);
    const store = active.store;
    active.stopping = true;
    try {
      await active.provider.shutdown(); // Keep the store and its writer lock throughout restoration.
      const messages = await store.rewind(ordinal);
      active = await start({ store, messages, configuration: store.header.configuration });
    } catch (error) {
      await close(active);
      throw error;
    }
    showActive();
    console.log("Rewound to checkpoint #" + ordinal + " in the same workspace. Later checkpoints remain saved.");
    prepare(active);
  }

  try {
    input = createInterface({ input: process.stdin, output: process.stdout });
    prepare(active);
    showActive();
    console.log("Enter a task or /help. Type c and press Enter to exit.");
    prompt();
    for await (const line of input) {
      if (active.stopping) break;
      let task = line.trim();
      if (task === "c") break;
      if (!task) { prompt(); continue; }
      if (task.startsWith("//")) {
        task = task.slice(1);
      } else if (task.startsWith("/")) {
        try {
          const parts = task.split(/\s+/);
          const command = parts.shift();
          const discard = parts.at(-1) === "--discard-unsaved";
          if (discard) parts.pop();
          if (discard && !["/rewind", "/fork", "/switch"].includes(command!)) {
            throw new Error("--discard-unsaved applies only to transitions.");
          }
          if (command === "/help" && !parts.length) {
            help();
          } else if (command === "/conversations" && !parts.length) {
            for (const row of await ConversationStore.list(workspace)) {
              const label = row.header?.label ?? (row.conversationId === active.store.rootConversationId ? "main" : row.conversationId.slice(0, 8));
              console.log(label, row.conversationId, row.unavailable ? "unavailable: " + row.unavailable : row.checkpoints + " checkpoints",
                row.conversationId === active.store.conversationId ? "(active)" : "");
            }
          } else if (command === "/checkpoints" && !parts.length) {
            const view = await ConversationStore.inspect(workspace, active.store.conversationId);
            if (view.header.origin) {
              const origin = view.header.origin;
              try {
                const source = await ConversationStore.inspect(workspace, origin.conversationId);
                const from = source.checkpoints.find((checkpoint) => checkpoint.id === origin.checkpointId);
                console.log("From source checkpoint", from ? "#" + from.ordinal : origin.checkpointId, origin.conversationId);
              } catch { console.log("Origin source unavailable:", origin.conversationId, origin.checkpointId); }
            }
            for (const checkpoint of view.checkpoints) {
              const after = (checkpoint.messages ?? view.messages.slice(0, checkpoint.messageCount)).slice().reverse()
                .find((message) => message.role === "user")?.content;
              console.log("#" + checkpoint.ordinal, "messages=" + checkpoint.messageCount, checkpoint.id,
                checkpoint.tree ? "files=" + checkpoint.tree.slice(0, 12) : "history only",
                checkpoint.id === view.checkpoint.id ? "(active)" : "",
                "saved after: " + (after === undefined ? "(no user message)" : after.replace(/\s+/g, " ").trim().slice(0, 120)));
            }
          } else if (["/show", "/rewind", "/fork"].includes(command!) &&
              parts.length === (command === "/fork" ? 2 : 1) && /^(?:0|[1-9][0-9]*)$/.test(parts[0]!)) {
            const ordinal = Number(parts[0]);
            if (command === "/show") {
              const view = await ConversationStore.inspect(workspace, active.store.conversationId, ordinal);
              console.log("Checkpoint #" + ordinal + " (" + view.checkpoint.messageCount + " messages)");
              for (const message of view.messages) {
                console.log("\n" + message.role.toUpperCase());
                console.log(message.content);
                if (message.toolCallId !== undefined) console.log("Tool result ID:", message.toolCallId);
                for (const call of message.toolCalls ?? []) {
                  console.log("Tool call:", call.name, "ID:", call.id);
                  console.log("Arguments:\n" + call.arguments);
                }
              }
            } else if (command === "/rewind") {
              await rewind(ordinal, discard);
            } else {
              await transition({ mode: "branch", conversationId: active.store.conversationId,
                checkpointOrdinal: ordinal, ...(command === "/fork" ? { label: parts[1]! } : {}) }, discard);
            }
          } else if (command === "/switch" && parts.length === 1) {
            const name = parts[0]!;
            let id = name === "main" ? active.store.rootConversationId : name;
            if (name !== "main" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)) {
              const matches = (await ConversationStore.list(workspace)).filter((row) => !row.unavailable && row.header?.label === name);
              if (matches.length !== 1) throw new Error(matches.length ?
                "Ambiguous name; use a UUID: " + matches.map((row) => row.conversationId).join(", ") : "No saved conversation named " + name);
              id = matches[0]!.conversationId;
            }
            await transition({ mode: "resume", conversationId: id }, discard);
          } else {
            throw new Error("Unknown command or usage. Enter /help.");
          }
        } catch (error) {
          if (active.closed) throw error; // Once original owners stopped, a transition failure is fatal.
          console.error("Command failed:", error);
        }
      }
      if (line.trim().startsWith("/") && !line.trim().startsWith("//")) {
        if (!active.stopping) prompt();
        continue;
      }
      let response;
      try { response = await active.agent.run(task); } catch (error) {
        if (active.preparationFailure !== undefined && error instanceof Error &&
            error.name === "ModelProviderError" && error.cause === active.preparationFailure) break;
        if (!(error instanceof AgentLimitError)) throw error;
        console.log("Task stopped:", error.message);
      }
      const conclusion = response?.conclusion ?? "stopped";
      console.log("Conclusion:", conclusion);
      if (active.store.header.v === 2 || conclusion === "success") {
        try { console.log("Saved checkpoint:", await active.store.checkpoint(active.memory.messages())); }
        catch (error) { throw new Error("Turn completed, but checkpoint save failed. Stopping before another task.", { cause: error }); }
      } else {
        console.log("No checkpoint saved for this attempt.");
      }
      prompt();
    }
  } finally {
    active.stopping = true;
    input?.close();
    await close(active);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1
})
