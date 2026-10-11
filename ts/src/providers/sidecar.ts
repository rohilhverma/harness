import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import type {
  ModelProvider, ModelRequest, ModelResponse, SidecarPending, SidecarReply,
} from "../interfaces.js";
import { parseQwen, renderQwen } from "./qwen.js";

interface PreparationResult {
  prompt_tokens: number;
  reused_tokens: number;
  prefilled_tokens: number;
}

export class SidecarProvider implements ModelProvider<ChildProcessWithoutNullStreams> {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<ChildProcessWithoutNullStreams>;
  private closed?: Promise<void>;
  private pending?: SidecarPending;
  private preparation?: Promise<PreparationResult>;
  private failure?: Error;
  private nextId = 0;
  private stderrTail = "";

  constructor(
    private readonly modelPath: string,
    private readonly executable = process.env.SIDECAR_EXECUTABLE ?? resolve("c/build/harness-sidecar"),
    private readonly timeoutMs = 300_000,
  ) {}

  async createClient(): Promise<ChildProcessWithoutNullStreams> {
    if (this.failure) throw this.failure;
    this.ready ??= this.start();
    return this.ready;
  }

  private async start(): Promise<ChildProcessWithoutNullStreams> {
    const child = spawn(this.executable, [this.modelPath], { stdio: "pipe" });
    this.child = child;
    this.closed = new Promise((done) => {
      child.once("close", (code, signal) => {
        done();
        this.fail(new Error("Sidecar exited: code=" + code + " signal=" + signal));
      });
    });
    child.once("error", (error) => this.fail(error));
    child.stdin.on("error", (error) => this.fail(error));
    child.stdout.on("error", (error) => this.fail(error));
    child.stderr.on("error", (error) => this.fail(error));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8192);
      process.stderr.write(chunk);
    });
    child.stdout.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const reply = JSON.parse(line) as SidecarReply;
          const pending = this.pending;
          if (!reply || reply.v !== 1 || !pending || reply.id !== pending.id ||
              typeof reply.ok !== "boolean") {
            throw new Error("Invalid or uncorrelated sidecar response.");
          }
          if (reply.ok) {
            if (!reply.result || typeof reply.result !== "object" || Array.isArray(reply.result)) {
              throw new Error("Invalid sidecar result.");
            }
            clearTimeout(pending.timer);
            this.pending = undefined;
            pending.resolve(reply.result);
          } else {
            if (typeof reply.error?.code !== "string" || typeof reply.error.message !== "string") {
              throw new Error("Invalid sidecar error.");
            }
            clearTimeout(pending.timer);
            this.pending = undefined;
            const error = new Error(reply.error.code + ": " + reply.error.message);
            error.name = "SidecarRequestError";
            pending.reject(error);
          }
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    });
    child.stdout.once("end", () => this.fail(new Error("Sidecar stdout reached EOF.")));
    const result = await this.send("ping", {});
    if (result.status !== "ready") throw this.fail(new Error("Sidecar did not report readiness."));
    return child;
  }

  private send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error("A sidecar request is already pending."));
    const id = "r" + ++this.nextId;
    const record = JSON.stringify({ v: 1, id, method, params });
    if (Buffer.byteLength(record) > 1024 * 1024) {
      return Promise.reject(new Error("Sidecar request exceeds 1 MiB."));
    }
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Sidecar request " + id + " timed out.")), this.timeoutMs);
      this.pending = { id, resolve: resolveReply, reject, timer };
      console.error("[sidecar-provider] send id=%s method=%s bytes=%d", id, method, Buffer.byteLength(record));
      this.child!.stdin.write(record + "\n", (error) => {
        if (error) this.fail(error);
      });
    });
  }

  private fail(error: Error): Error {
    if (this.failure) return this.failure;
    this.failure = new Error(error.message + (this.stderrTail ? "\n" + this.stderrTail : ""), { cause: error });
    this.failure.name = "SidecarTransportError";
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.failure);
      this.pending = undefined;
    }
    this.child?.kill();
    return this.failure;
  }

  async serverStatus(): Promise<boolean> {
    try {
      await this.createClient();
      return true;
    } catch {
      return false;
    }
  }

  prepare(request: Pick<ModelRequest, "messages" | "tools">): Promise<PreparationResult> {
    if (this.preparation) return Promise.reject(new Error("Preparation has already been started."));
    // The executor snapshots synchronously and captures rendering errors as rejections.
    const rendered = new Promise<string>((resolvePrompt) => resolvePrompt(renderQwen(request)));
    this.preparation = rendered.then(async (prompt) => {
      await this.createClient();
      const result = await this.send("prepare", { prompt });
      const { prompt_tokens, reused_tokens, prefilled_tokens } = result;
      if (Object.keys(result).length !== 3 ||
          ![prompt_tokens, reused_tokens, prefilled_tokens].every(Number.isInteger) ||
          Number(prompt_tokens) <= 0 || Number(reused_tokens) < 0 || Number(prefilled_tokens) <= 0 ||
          Number(reused_tokens) + Number(prefilled_tokens) !== prompt_tokens) {
        throw this.fail(new Error("Invalid sidecar preparation result."));
      }
      return { prompt_tokens: Number(prompt_tokens), reused_tokens: Number(reused_tokens),
        prefilled_tokens: Number(prefilled_tokens) };
    });
    return this.preparation;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    await this.preparation;
    await this.createClient();
    const result = await this.send("generate", {
      prompt: renderQwen(request),
      max_tokens: request.maxTokens ?? 2048,
      temperature: request.temperature ?? 0.2,
      ...(request.seed === undefined ? {} : { seed: request.seed }),
    });
    const { text, completion_reason, prompt_tokens, generated_tokens, evaluated_tokens } = result;
    if (typeof text !== "string" || (completion_reason !== "eog" && completion_reason !== "length") ||
        ![prompt_tokens, generated_tokens, evaluated_tokens].every((value) => Number.isInteger(value) && Number(value) > 0)) {
      throw this.fail(new Error("Invalid sidecar generation result."));
    }
    console.error("[sidecar-provider] result prompt=%d generated=%d evaluated=%d reason=%s",
      prompt_tokens, generated_tokens, evaluated_tokens, completion_reason);
    if (completion_reason === "length") {
      return { output: { role: "assistant", content: text }, conclusion: "length" };
    }
    const output = parseQwen(text);
    return { output, conclusion: output.toolCalls?.length ? "tool_request" : "success" };
  }

  async shutdown(): Promise<void> {
    this.failure ??= new Error("Sidecar has been shut down.");
    if (!this.child) {
      await this.preparation?.catch(() => {});
      return;
    }
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.failure);
      this.pending = undefined;
    }
    this.child.stdin.end();
    const timer = setTimeout(() => this.child?.kill("SIGKILL"), 5000);
    await this.closed;
    clearTimeout(timer);
    await this.preparation?.catch(() => {});
  }
}
