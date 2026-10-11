import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, realpath, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Message, ToolDefinition } from "./interfaces.js";

interface Configuration {
  workspace: string;
  modelPath: string;
  generation: { temperature: number; maxTokens: number; seed?: number };
  tools: Pick<ToolDefinition, "name" | "description" | "parameters">[];
}

interface Header {
  v: 1;
  kind: "header";
  conversationId: string;
  configuration: Configuration;
  label?: string;
  origin?: { conversationId: string; checkpointId: string; rootConversationId: string };
}

interface Checkpoint {
  ordinal: number;
  id: string;
  messageCount: number;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validateId(id: string): void {
  if (typeof id !== "string" || !uuidPattern.test(id)) throw new Error("Conversation ID must be a UUID printed by the runner.");
}

function validateLabel(label: string): void {
  if (typeof label !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(label) ||
      label === "main" || uuidPattern.test(label)) {
    throw new Error("Name must be a 1–64 character lowercase letters/digits/hyphen/underscore slug, not main or a UUID.");
  }
}

function compatible(saved: Configuration, current: Configuration): void {
  if (saved.workspace !== current.workspace || saved.modelPath !== current.modelPath ||
      JSON.stringify(saved.tools) !== JSON.stringify(current.tools)) {
    throw new Error("Resume requires the same canonical workspace/model path and ordered tool descriptors.");
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validateMessage(value: unknown): asserts value is Message {
  if (!object(value) || !fields(value, ["role", "content", "toolCallId", "toolCalls"]) ||
      typeof value.role !== "string" || !["system", "user", "assistant", "tool"].includes(value.role) ||
      typeof value.content !== "string" ||
      (value.toolCallId !== undefined && typeof value.toolCallId !== "string") ||
      (value.toolCalls !== undefined && (!Array.isArray(value.toolCalls) ||
        !value.toolCalls.every((call) => object(call) && fields(call, ["id", "name", "arguments"]) &&
          typeof call.id === "string" && typeof call.name === "string" && typeof call.arguments === "string")))) {
    throw new Error("Invalid saved message fields.");
  }
}

function validateConfiguration(value: unknown): asserts value is Configuration {
  if (!object(value) || !fields(value, ["workspace", "modelPath", "generation", "tools"]) ||
      typeof value.workspace !== "string" || typeof value.modelPath !== "string" ||
      !object(value.generation) || !fields(value.generation, ["temperature", "maxTokens", "seed"]) ||
      typeof value.generation.temperature !== "number" || !Number.isFinite(value.generation.temperature) ||
      value.generation.temperature < 0 || value.generation.temperature > 2 ||
      !Number.isInteger(value.generation.maxTokens) ||
      Number(value.generation.maxTokens) <= 0 || Number(value.generation.maxTokens) > 0x7fffffff ||
      (value.generation.seed !== undefined && (!Number.isInteger(value.generation.seed) ||
        Number(value.generation.seed) < 0 || Number(value.generation.seed) >= 0xffffffff)) ||
      !Array.isArray(value.tools) || !value.tools.every((tool) => object(tool) &&
        fields(tool, ["name", "description", "parameters"]) && typeof tool.name === "string" &&
        typeof tool.description === "string" && object(tool.parameters))) {
    throw new Error("Invalid saved conversation configuration.");
  }
}

function messageRecord(message: Message, index: number): string {
  validateMessage(message);
  return JSON.stringify({ v: 1, kind: "message", index, message }) + "\n";
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

// Read precisely the file size selected at open; appends cannot extend this snapshot.
async function snapshot(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc((await file.stat()).size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("History changed while reading; inspect again.");
      offset += bytesRead;
    }
    return bytes;
  } finally { await file.close(); }
}

function parseHistory(bytes: Buffer, conversationId: string) {
  const completeEnd = bytes.lastIndexOf(10) + 1;
  if (!completeEnd) throw new Error("Conversation has no complete header or saved completed task.");
  new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, completeEnd));
  const lines = bytes.subarray(0, completeEnd).toString("utf8").split("\n");
  lines.pop();
  const value: unknown = JSON.parse(lines[0]!);
  if (!object(value) || !fields(value, ["v", "kind", "conversationId", "configuration", "label", "origin"]) ||
      value.v !== 1 || value.kind !== "header" || value.conversationId !== conversationId) {
    throw new Error("Invalid conversation header.");
  }
  validateConfiguration(value.configuration);
  if (value.label !== undefined) {
    if (typeof value.label !== "string") throw new Error("Invalid conversation label.");
    validateLabel(value.label);
  }
  if (value.origin !== undefined) {
    const origin = value.origin;
    if (!object(origin) || !fields(origin, ["conversationId", "checkpointId", "rootConversationId"]) ||
        typeof origin.conversationId !== "string" || typeof origin.checkpointId !== "string" ||
        typeof origin.rootConversationId !== "string" ||
        !uuidPattern.test(origin.conversationId) || !uuidPattern.test(origin.rootConversationId) ||
        !origin.checkpointId.startsWith(origin.conversationId + ":") ||
        !/^[1-9][0-9]*$/.test(origin.checkpointId.slice(origin.conversationId.length + 1))) {
      throw new Error("Invalid conversation origin.");
    }
  }
  const header = value as unknown as Header;
  const headerBytes = Buffer.from(lines[0]! + "\n");
  const hash = createHash("sha256").update(headerBytes);
  const messages: Message[] = [];
  const records: string[] = [];
  const checkpoints: Checkpoint[] = [];
  let offset = headerBytes.length;
  let savedEnd = 0;
  let savedCount = 0;
  let savedHash = hash.copy();
  for (const line of lines.slice(1)) {
    const record: unknown = JSON.parse(line);
    const raw = Buffer.from(line + "\n");
    offset += raw.length;
    if (!object(record) || record.v !== 1) throw new Error("Invalid complete history record.");
    if (record.kind === "message" && fields(record, ["v", "kind", "index", "message"])) {
      if (record.index !== messages.length) throw new Error("Saved message index is out of order.");
      validateMessage(record.message);
      messages.push(record.message);
      records.push(messageRecord(record.message, records.length));
      hash.update(raw);
    } else if (record.kind === "checkpoint" && fields(record, ["v", "kind", "id", "messageCount", "digest"])) {
      if (record.messageCount !== messages.length || messages.length <= savedCount ||
          record.id !== conversationId + ":" + messages.length ||
          record.digest !== hash.copy().digest("hex")) {
        throw new Error("Invalid checkpoint identity, count or history digest.");
      }
      checkpoints.push({ ordinal: checkpoints.length + 1, id: record.id, messageCount: messages.length });
      savedCount = messages.length;
      savedEnd = offset;
      savedHash = hash.copy();
    } else {
      throw new Error("Invalid complete history record.");
    }
  }
  return { header, headerBytes, messages: messages.slice(0, savedCount),
    records: records.slice(0, savedCount), checkpoints, savedEnd, savedHash };
}

// One runner owns this store. Await each open/checkpoint/close before the next call;
// overlapping calls are unsupported and can corrupt the log.
export class ConversationStore {
  private savedRecords: string[] = [];
  private hash = createHash("sha256");
  private usable = true;
  private closed = false;

  private constructor(
    readonly header: Header,
    headerBytes: Buffer,
    private readonly log: FileHandle,
    private readonly lock: FileHandle,
    private readonly lockPath: string,
  ) {
    this.hash.update(headerBytes);
  }

  get conversationId(): string { return this.header.conversationId; }
  get rootConversationId(): string { return this.header.origin?.rootConversationId ?? this.conversationId; }

  hasUnsavedMessages(messages: Message[]): boolean {
    const records = messages.map(messageRecord);
    return records.length !== this.savedRecords.length ||
      this.savedRecords.some((record, index) => records[index] !== record);
  }

  static async inspect(workspace: string, conversationId: string, ordinal?: number) {
    validateId(conversationId);
    const parsed = parseHistory(await snapshot(join(await realpath(workspace), "sessions", conversationId, "history.jsonl")), conversationId);
    const checkpoint = ordinal === undefined ? parsed.checkpoints.at(-1) : parsed.checkpoints[ordinal - 1];
    if (ordinal !== undefined && (!Number.isInteger(ordinal) || ordinal < 1)) {
      throw new Error("Checkpoint number must be a positive ordinal.");
    }
    if (!checkpoint) throw new Error("Conversation has no saved completed task at that checkpoint.");
    return { header: parsed.header, checkpoints: parsed.checkpoints,
      checkpoint, messages: parsed.messages.slice(0, checkpoint.messageCount) };
  }

  static async list(workspace: string) {
    const sessions = join(await realpath(workspace), "sessions");
    let names: string[];
    try { names = await readdir(sessions); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const rows: { conversationId: string; header?: Header; checkpoints: number; unavailable?: string }[] = [];
    for (const conversationId of names.filter((name) => uuidPattern.test(name)).sort()) {
      try {
        const parsed = parseHistory(await snapshot(join(sessions, conversationId, "history.jsonl")), conversationId);
        rows.push({ conversationId, header: parsed.header, checkpoints: parsed.checkpoints.length,
          ...(parsed.checkpoints.length ? {} : { unavailable: "no saved completed task" }) });
      } catch (error) {
        rows.push({ conversationId, checkpoints: 0, unavailable: error instanceof Error ? error.message : String(error) });
      }
    }
    return rows;
  }

  static async open(
    selection: { mode: "create" } | { mode: "resume"; conversationId: string } |
      { mode: "branch"; conversationId: string; checkpointOrdinal: number; label?: string },
    configuration: Configuration,
  ): Promise<{ store: ConversationStore; messages: Message[]; configuration: Configuration;
    sourceCheckpoint?: { ordinal: number; id: string } }> {
    const conversationId = selection.mode === "resume" ? selection.conversationId : randomUUID();
    validateId(conversationId);
    // Snapshot configuration; callers must not be able to mutate the saved header.
    const current: unknown = JSON.parse(JSON.stringify(configuration));
    validateConfiguration(current);
    current.workspace = await realpath(current.workspace);
    current.modelPath = await realpath(current.modelPath);
    let selected: Awaited<ReturnType<typeof ConversationStore.inspect>> | undefined;
    let label: string | undefined;
    if (selection.mode === "branch") {
      selected = await ConversationStore.inspect(current.workspace, selection.conversationId, selection.checkpointOrdinal);
      compatible(selected.header.configuration, current);
      label = selection.label === undefined ? "rewind-" + conversationId.slice(0, 8) : selection.label;
      validateLabel(label);
      const rows = await ConversationStore.list(current.workspace);
      if (rows.some((row) => row.header?.label === label)) {
        throw new Error("Conversation name already exists in this workspace: " + label);
      }
    }
    const sessions = join(current.workspace, "sessions");
    const directory = join(sessions, conversationId);
    if (selection.mode !== "resume") {
      await mkdir(sessions, { recursive: true });
      await mkdir(directory);
    } else {
      await realpath(directory); // A missing resume target must never be created.
    }
    const lockPath = join(directory, "writer.lock");
    let lock: FileHandle;
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Conversation has a writer.lock. Stop its writer before manual stale-lock recovery.");
      }
      throw error;
    }
    let log: FileHandle | undefined;
    try {
      if (selection.mode !== "resume") {
        const header: Header = { v: 1, kind: "header", conversationId,
          configuration: selected?.header.configuration ?? current,
          ...(selected ? { label, origin: { conversationId: selected.header.conversationId,
            checkpointId: selected.checkpoint.id,
            rootConversationId: selected.header.origin?.rootConversationId ?? selected.header.conversationId } } : {}) };
        const messages = selected?.messages ?? [];
        const headerBytes = Buffer.from(JSON.stringify(header) + "\n");
        log = await open(join(directory, "history.jsonl"), "ax+");
        await log.writeFile(headerBytes);
        await log.sync();
        await syncDirectory(directory);
        await syncDirectory(sessions);
        await syncDirectory(current.workspace);
        const store = new ConversationStore(header, headerBytes, log, lock, lockPath);
        if (messages.length) await store.checkpoint(messages);
        return { store, messages, configuration: header.configuration,
          ...(selected ? { sourceCheckpoint: { ordinal: selected.checkpoint.ordinal, id: selected.checkpoint.id } } : {}) };
      }
      log = await open(join(directory, "history.jsonl"), constants.O_RDWR | constants.O_APPEND);
      const bytes = await log.readFile();
      const parsed = parseHistory(bytes, conversationId);
      compatible(parsed.header.configuration, current);
      if (!parsed.savedEnd) throw new Error("Conversation has no saved completed task.");
      // Only locked resume recovers tails. Inspection and branching never alter the source.
      if (parsed.savedEnd !== bytes.length) {
        await log.truncate(parsed.savedEnd);
        await log.sync();
      }
      const store = new ConversationStore(parsed.header, parsed.headerBytes, log, lock, lockPath);
      store.savedRecords = parsed.records;
      store.hash = parsed.savedHash;
      return { store, messages: parsed.messages, configuration: parsed.header.configuration };
    } catch (error) {
      try { await log?.close(); } finally {
        try { await lock.close(); } finally { await unlink(lockPath); }
      }
      throw error;
    }
  }

  // Digest scope: exact UTF-8 header/message lines including LF; markers are excluded.
  // Marker IDs bind the conversation UUID and ordered message count.
  async checkpoint(messages: Message[]): Promise<string> {
    if (!this.usable || this.closed) throw new Error("Conversation store is unavailable; stop this runner.");
    const records = messages.map(messageRecord);
    if (records.length <= this.savedRecords.length ||
        this.savedRecords.some((record, index) => records[index] !== record)) {
      throw new Error("Saved conversation prefix changed or no new messages were provided.");
    }
    const newRecords = records.slice(this.savedRecords.length);
    const nextHash = this.hash.copy();
    for (const record of newRecords) nextHash.update(record);
    const id = this.conversationId + ":" + messages.length;
    const marker = JSON.stringify({ v: 1, kind: "checkpoint", id,
      messageCount: messages.length, digest: nextHash.copy().digest("hex") }) + "\n";
    try {
      await this.log.writeFile(newRecords.join("") + marker);
      await this.log.sync();
    } catch (error) {
      this.usable = false;
      throw error;
    }
    this.hash = nextHash;
    this.savedRecords = records;
    return id;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.log.close(); } finally {
      try { await this.lock.close(); } finally { await unlink(this.lockPath); }
    }
  }
}
