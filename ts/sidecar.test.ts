import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "./agent.js";
import { ConversationMemory, type ModelProvider, type ModelRequest, type ModelResponse, type ToolDefinition } from "./src/interfaces.js";
import { DEFAULT_SYSTEM_PROMPT } from "./src/prompts.js";
import { providerRegistry } from "./src/providers/provider-registry.js";
import { parseQwen, renderQwen } from "./src/providers/qwen.js";
import { SidecarProvider } from "./src/providers/sidecar.js";
import { createReadFileTool } from "./src/tools/readFile.js";
import { createSearchTool } from "./src/tools/search.js";
import { createEditFileTool } from "./src/tools/editFile.js";
import { createRunCommandTool } from "./src/tools/runCommand.js";

const request: ModelRequest = { messages: [{ role: "user", content: "Hello" }], temperature: 0 };

function fakeSidecar(mode = "normal"): SidecarProvider {
  const script = String.raw`
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", line => {
  const q = JSON.parse(line);
  if (q.method === "ping") {
    process.stdout.write(JSON.stringify({ v:1, id:q.id, ok:true, result:{status:"ready"} }) + "\n");
    return;
  }
  const mode = MODE;
  if (mode === "timeout") return;
  if (mode === "exit") process.exit(7);
  if (mode === "eof") { process.stdout.end(); return; }
  if (mode === "json") { process.stdout.write("{broken\n"); return; }
  let reply = { v:1, id:q.id, ok:true, result:{
    text:q.params.max_tokens === 1 ? "<tool_call>" : "Hello 🌟",
    completion_reason:q.params.max_tokens === 1 ? "length" : "eog",
    prompt_tokens:11, generated_tokens:q.params.max_tokens === 1 ? 1 : 2,
    evaluated_tokens:q.params.max_tokens === 1 ? 11 : 12
  }};
  if (q.params.max_tokens === 0) reply = { v:1, id:q.id, ok:false, error:{code:"invalid_request",message:"bad limit"} };
  if (mode === "id") reply.id = "wrong";
  if (mode === "version") reply.v = 2;
  const bytes = Buffer.from(JSON.stringify(reply) + "\n");
  const cut = bytes.indexOf(Buffer.from("🌟")) + 1;
  process.stdout.write(bytes.subarray(0, cut));
  setTimeout(() => process.stdout.write(bytes.subarray(cut)), 30);
});
`.replace("MODE", JSON.stringify(mode));
  return new SidecarProvider("--eval=" + script, process.execPath, 2000);
}

test("transport handles split UTF-8, errors, overlap, limits, and graceful EOF", async () => {
  const provider = fakeSidecar();
  try {
    const child = await provider.createClient();
    const first = provider.generate(request);
    await assert.rejects(provider.generate(request), /already pending/);
    assert.equal((await first).output.content, "Hello 🌟");
    await assert.rejects(provider.generate({ ...request, maxTokens: 0 }), /invalid_request/);
    assert.equal((await provider.generate(request)).conclusion, "success");
    assert.equal((await provider.generate({ ...request, maxTokens: 1 })).conclusion, "length");
    await assert.rejects(provider.generate({ messages: [{ role: "user", content: "x".repeat(1024 * 1024) }] }), /1 MiB/);
    assert.equal((await provider.generate(request)).output.content, "Hello 🌟");
    await provider.shutdown();
    assert.equal(child.exitCode, 0);
    await assert.rejects(provider.generate(request), /shut down/);
  } finally {
    await provider.shutdown();
  }
});

test("transport rejects broken framing, correlation, version, exit, EOF, timeout, and spawn failure", async () => {
  for (const mode of ["json", "id", "version", "exit", "eof", "timeout"]) {
    const provider = fakeSidecar(mode);
    try {
      await provider.createClient();
      await assert.rejects(provider.generate(request), { name: "SidecarTransportError" });
      await assert.rejects(provider.generate(request), { name: "SidecarTransportError" });
    } finally {
      await provider.shutdown();
    }
  }
  const missing = new SidecarProvider("model.gguf", "/definitely-missing/harness-sidecar", 2000);
  try {
    await assert.rejects(missing.createClient(), { name: "SidecarTransportError" });
  } finally {
    await missing.shutdown();
  }
});

test("Qwen rendering and parsing preserve tool data and group results", () => {
  assert.equal(renderQwen(request), "<|im_start|>user\nHello<|im_end|>\n<|im_start|>assistant\n");
  const parsed = parseQwen('Checking.\n<tool_call>\n{"name":"edit_file","arguments":{"newText":"literal </tool_call> 🌟"}}\n</tool_call>\n<tool_call>{"name":"unknown","arguments":[]}</tool_call>');
  assert.equal(parsed.content, "Checking.");
  assert.equal(parsed.toolCalls?.length, 2);
  assert.notEqual(parsed.toolCalls![0]!.id, parsed.toolCalls![1]!.id);
  assert.equal(JSON.parse(parsed.toolCalls![0]!.arguments).newText, "literal </tool_call> 🌟");
  assert.throws(() => parseQwen("<tool_call>{broken}</tool_call>"), /Invalid Qwen/);
  assert.equal(parseQwen("  plain text\n").content, "  plain text\n");
  const rendered = renderQwen({ messages: [
    { role: "user", content: "Read two files." }, parsed,
    { role: "tool", toolCallId: parsed.toolCalls![0]!.id, content: "A" },
    { role: "tool", toolCallId: parsed.toolCalls![1]!.id, content: "B" },
  ] });
  assert.ok(rendered.includes('<|im_start|>user\n<tool_response>\nA\n</tool_response>\n<tool_response>\nB\n</tool_response><|im_end|>'));
});

test("Qwen tool parsing skips leading reasoning and rejects an unclosed block", () => {
  const example = '<tool_call>{"name":"example","arguments":{}}</tool_call>';
  const actual = '<tool_call>{"name":"actual","arguments":{}}</tool_call>';
  for (const whitespace of ["", "\n", " \t\r\n"]) {
    const reasoning = whitespace + "<think>" + example + "</think>";
    const text = reasoning + "\nAnswer.";
    assert.deepEqual(parseQwen(text), { role: "assistant", content: text });
    assert.deepEqual(
      parseQwen(reasoning + "\n" + actual).toolCalls?.map((call) => call.name),
      ["actual"],
    );
    assert.throws(
      () => parseQwen(whitespace + "<think>" + example),
      /Unclosed Qwen reasoning block/,
    );
    assert.throws(
      () => parseQwen(whitespace + "<think>Still reasoning."),
      /Unclosed Qwen reasoning block/,
    );
  }
});

test("registry creates independent sidecars while retaining HTTP-provider caching", () => {
  const first = providerRegistry.get("sidecar", "test-model.gguf");
  const second = providerRegistry.get("sidecar", "test-model.gguf");
  const registered = providerRegistry.register("sidecar", "test-model.gguf");
  assert.notEqual(first, second);
  assert.notEqual(second, registered);
  assert.notEqual(providerRegistry.get("sidecar", "test-model.gguf"), registered);
  assert.equal(
    providerRegistry.get("llama", "http://127.0.0.1:1/v1"),
    providerRegistry.get("llama", "http://127.0.0.1:1/v1"),
  );
});

test("shutdown before startup prevents later use", async () => {
  const provider = fakeSidecar();
  try {
    await provider.shutdown();
    await provider.shutdown();
    await assert.rejects(provider.createClient(), /shut down/);
    await assert.rejects(provider.generate(request), /shut down/);
    assert.equal(await provider.serverStatus(), false);
  } finally {
    await provider.shutdown();
  }
});

test("unchanged Agent executes sequential calls, recovers tool errors, and retains conversation", async () => {
  const memory = new ConversationMemory();
  const seen: ModelRequest[] = [];
  const executed: number[] = [];
  const tool: ToolDefinition = {
    name: "record", description: "Record a number.", parameters: {},
    execute: async (args) => { executed.push(Number(args.n)); return { ok: true }; },
  };
  const queue: ModelResponse[] = [
    { conclusion: "tool_request", output: { role: "assistant", content: "", toolCalls: [
      { id: "a", name: "record", arguments: '{"n":1}' },
      { id: "b", name: "record", arguments: '{"n":2}' },
      { id: "c", name: "missing", arguments: "{}" },
      { id: "d", name: "record", arguments: "bad JSON" },
    ] } },
    { conclusion: "success", output: { role: "assistant", content: "done" } },
    { conclusion: "success", output: { role: "assistant", content: "remembered" } },
  ];
  const fake: ModelProvider<null> = {
    createClient: async () => null, serverStatus: async () => true,
    generate: async (input) => { seen.push(input); return queue.shift()!; },
  };
  const original = providerRegistry.get;
  providerRegistry.get = () => fake;
  try {
    const agent = new Agent("fake", "", {
      identity: { name: "test", systemPrompt: "Test." },
      model: { model: "test", temperature: 0, maxTokens: 32, seed: 42 }, tools: [tool], memory,
    });
    assert.equal((await agent.run("Start.")).conclusion, "success");
    assert.deepEqual(executed, [1, 2]);
    const results = memory.messages().filter((message) => message.role === "tool");
    assert.deepEqual(results.map((message) => message.toolCallId), ["a", "b", "c", "d"]);
    assert.deepEqual(results.map((message) => JSON.parse(message.content).ok), [true, true, false, false]);
    const history = memory.messages();
    await agent.run("Continue.");
    assert.deepEqual(seen[2]!.messages.slice(0, history.length), history);
    assert.equal(seen[0]!.maxTokens, 32);
    assert.equal(seen[0]!.seed, 42);
    for (const conclusion of ["length", "error"] as const) {
      queue.push({ conclusion, output: { role: "assistant", content: "" } });
      assert.equal((await agent.run("Stop.")).conclusion, conclusion);
    }
    fake.generate = async () => { throw new Error("broken provider"); };
    await assert.rejects(agent.run("Fail."), (error: unknown) =>
      error instanceof Error && error.name === "ModelProviderError" &&
      error.cause instanceof Error && error.cause.message === "broken provider");
  } finally {
    providerRegistry.get = original;
  }
});

test("live sidecar and llama-server complete the same coding task in separate workspaces", {
  skip: !process.env.LLAMA_MODEL_PATH || !process.env.LLAMA_SERVER_ADDRESS,
}, async () => {
  for (const [name, address] of [
    ["sidecar", process.env.LLAMA_MODEL_PATH!], ["llama", process.env.LLAMA_SERVER_ADDRESS!],
  ]) {
    const root = await mkdtemp(join(tmpdir(), "harness-" + name + "-"));
    const memory = new ConversationMemory();
    const provider = providerRegistry.register(name!, address!);
    try {
      await writeFile(join(root, "fixture.txt"), "red\n");
      const agent = new Agent(name!, address!, {
        identity: { name: "test", systemPrompt: DEFAULT_SYSTEM_PROMPT },
        model: { model: "bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF:Q4_K_M", temperature: 0, maxTokens: 2048 },
        tools: [createReadFileTool(root), createSearchTool(root), createEditFileTool(root), createRunCommandTool(root)], memory,
      }, provider);
      const result = await agent.run("Use search to find red in fixture.txt, read that file, replace its contents with blue followed by a newline using edit_file, then verify using run_command with command cat and args [\"fixture.txt\"]. Use all four tools. Finish after verification.");
      assert.equal(result.conclusion, "success");
      assert.equal(await readFile(join(root, "fixture.txt"), "utf8"), "blue\n");
      const calls = memory.messages().flatMap((message) => message.toolCalls ?? []);
      assert.deepEqual(new Set(calls.map((call) => call.name)), new Set(["search", "read_file", "edit_file", "run_command"]));
      const results = memory.messages().filter((message) => message.role === "tool");
      assert.deepEqual(results.map((message) => message.toolCallId), calls.map((call) => call.id));
      assert.ok(results.some((message) => {
        const value = JSON.parse(message.content);
        return value.ok && value.stdout === "blue\n" && value.exit_code === 0;
      }));
      const previous = memory.messages();
      assert.equal((await agent.run("Read fixture.txt again and confirm its current word. Do not edit it.")).conclusion, "success");
      assert.deepEqual(memory.messages().slice(0, previous.length), previous);
      assert.equal(await readFile(join(root, "fixture.txt"), "utf8"), "blue\n");
    } finally {
      await provider.shutdown?.();
      await rm(root, { recursive: true, force: true });
    }
  }
});
