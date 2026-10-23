import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, realpath, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Message, ToolDefinition } from "./interfaces.js";
import { WorkspaceHistory } from "./workspaceHistory.js";

interface Configuration {
  workspace: string;
  modelPath: string;
  generation: { temperature: number; maxTokens: number; seed?: number };
  tools: Pick<ToolDefinition, "name" | "description" | "parameters">[];
}

interface Header {
  v: 1 | 2;
  baseline?: string;
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
  tree?: string;
  messages?: Message[];
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
  if (!object(value) || !fields(value, ["v", "kind", "conversationId", "configuration", "label", "origin", "baseline"]) ||
      (value.v !== 1 && value.v !== 2) || value.kind !== "header" || value.conversationId !== conversationId) {
    throw new Error("Invalid conversation header.");
  }
  if (value.v === 2 ? typeof value.baseline !== "string" || !/^[0-9a-f]{40}$/.test(value.baseline) : value.baseline !== undefined) {
    throw new Error("Invalid initial file snapshot.");
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
        !(value.v === 2 ? /^(?:0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(origin.checkpointId.slice(origin.conversationId.length + 1))) {
      throw new Error("Invalid conversation origin.");
    }
  }
  const header = value as unknown as Header;
  const headerBytes = Buffer.from(lines[0]! + "\n");
  const hash = createHash("sha256").update(headerBytes);
  const messages: Message[] = [];
  const records: string[] = [];
  const checkpoints: Checkpoint[] = header.v === 2 ?
    [{ ordinal: 0, id: conversationId + ":0", messageCount: 0, tree: header.baseline!, messages: [] }] : [];
  let offset = headerBytes.length;
  let savedEnd = header.v === 2 ? headerBytes.length : 0;
  let savedCount = 0;
  let savedHash = hash.copy();
  let headOrdinal = header.v === 2 ? 0 : undefined;
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
    } else if (record.kind === "checkpoint" && fields(record, ["v", "kind", "id", "messageCount", "digest", "tree"])) {
      if (header.v === 2 ? typeof record.tree !== "string" || !/^[0-9a-f]{40}$/.test(record.tree) : record.tree !== undefined) {
        throw new Error("Invalid checkpoint file snapshot.");
      }
      const digest = hash.copy();
      if (header.v === 2) digest.update("\0" + record.tree);
      if (record.messageCount !== messages.length || messages.length <= savedCount ||
          record.id !== conversationId + ":" + (header.v === 2 ? checkpoints.length : messages.length) ||
          record.digest !== digest.digest("hex")) {
        throw new Error("Invalid checkpoint identity, count or history digest.");
      }
      checkpoints.push({ ordinal: checkpoints.length + (header.v === 2 ? 0 : 1), id: record.id,
        messageCount: messages.length, ...(header.v === 2 ? { tree: record.tree as string, messages: messages.slice() } : {}) });
      headOrdinal = checkpoints.at(-1)!.ordinal;
      savedCount = messages.length;
      savedEnd = offset;
      savedHash = hash.copy();
    } else if (header.v === 2 && record.kind === "rewind" &&
        fields(record, ["v", "kind", "checkpointId", "recoveryTree", "operationId", "digest"])) {
      const target = checkpoints.find((item) => item.id === record.checkpointId);
      if (!target || typeof record.recoveryTree !== "string" || !/^[0-9a-f]{40}$/.test(record.recoveryTree) ||
          typeof record.operationId !== "string" || !uuidPattern.test(record.operationId) ||
          record.digest !== JSON.parse(rewindRecord(hash, target.id, record.recoveryTree, record.operationId)).digest ||
          messages.length !== savedCount) throw new Error("Invalid saved rewind record.");
      messages.splice(0, messages.length, ...target.messages!);
      records.splice(0, records.length, ...messages.map(messageRecord));
      savedCount = messages.length;
      headOrdinal = target.ordinal;
      hash.update(raw);
      savedEnd = offset;
      savedHash = hash.copy();
    } else {
      throw new Error("Invalid complete history record.");
    }
  }
  return { header, headerBytes, messages: messages.slice(0, savedCount),
    records: records.slice(0, savedCount), checkpoints, headOrdinal, savedEnd, savedHash };
}

function rewindRecord(hash: ReturnType<typeof createHash>, checkpointId: string, recoveryTree: string, operationId: string): string {
  return JSON.stringify({ v: 1, kind: "rewind", checkpointId, recoveryTree, operationId,
    digest: hash.copy().update("\0rewind\0" + checkpointId + "\0" + recoveryTree + "\0" + operationId).digest("hex") }) + "\n";
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
    private readonly fileHistory?: WorkspaceHistory,
  ) {
    this.hash.update(headerBytes);
  }

  get conversationId(): string { return this.header.conversationId; }
  get workingDirectory(): string { return this.fileHistory?.directory ?? this.header.configuration.workspace; }

  private nextOrdinal = 1;
  get rootConversationId(): string { return this.header.origin?.rootConversationId ?? this.conversationId; }

  hasUnsavedMessages(messages: Message[]): boolean {
    const records = messages.map(messageRecord);
    return records.length !== this.savedRecords.length ||
      this.savedRecords.some((record, index) => records[index] !== record);
  }

  private async writeMarkdown(): Promise<void> {
    const path = join(this.header.configuration.workspace, "sessions", this.conversationId, "conversation.md");
    try {
      const literal = (text: string) => {
        let fence = "```";
        while (text.includes(fence)) fence += "`";
        return fence + "text\n" + text + "\n" + fence;
      };
      const lines = ["# " + (this.header.label ?? "Conversation"), "",
        "Conversation ID: " + this.conversationId, "",
        "Saved messages: " + this.savedRecords.length, "",
        "Updated automatically after saved checkpoints and on resume. Editing this file does not change model history.", ""];
      if (this.header.origin) lines.push("From checkpoint: " + this.header.origin.checkpointId, "");
      if (!this.savedRecords.length) lines.push("No messages saved yet. Your conversation will appear here after a completed task.", "");
      this.savedRecords.forEach((record, index) => {
        const message = (JSON.parse(record) as { message: Message }).message;
        lines.push("## " + (index + 1) + ". " + message.role, "");
        if (message.toolCallId !== undefined) lines.push(literal("Tool result ID: " + message.toolCallId), "");
        lines.push(literal(message.content), "");
        for (const call of message.toolCalls ?? []) {
          lines.push("### Tool call", "", literal("Name: " + call.name + "\nID: " + call.id + "\nArguments:\n" + call.arguments), "");
        }
      });
      await writeFile(path + ".tmp", lines.join("\n"), "utf8");
      await rename(path + ".tmp", path);
    } catch (error) {
      await unlink(path + ".tmp").catch(() => {});
      console.error("Could not update readable conversation:", path, error);
    }
  }

  static async inspect(workspace: string, conversationId: string, ordinal?: number) {
    validateId(conversationId);
    const parsed = parseHistory(await snapshot(join(await realpath(workspace), "sessions", conversationId, "history.jsonl")), conversationId);
    const checkpoint = parsed.checkpoints.find((item) => item.ordinal === (ordinal ?? parsed.headOrdinal));
    if (ordinal !== undefined && (!Number.isInteger(ordinal) || ordinal < (parsed.header.v === 2 ? 0 : 1))) {
      throw new Error("Checkpoint number must be an available ordinal; #0 is the initial coding workspace.");
    }
    if (!checkpoint) throw new Error("Conversation has no saved completed task at that checkpoint.");
    return { header: parsed.header, checkpoints: parsed.checkpoints,
      checkpoint, messages: checkpoint.messages ?? parsed.messages.slice(0, checkpoint.messageCount) };
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
        rows.push({ conversationId, header: parsed.header, checkpoints: parsed.checkpoints.filter((item) => item.ordinal > 0).length,
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
        const files = selected?.header.v === 1 ? undefined :
          await WorkspaceHistory.create(current.workspace, conversationId, selected?.checkpoint.tree);
        if (!files) await writeFile(join(directory, "AGENT_TEST.md"),
          "# Agent test file\n\nStatus: not tested\nTest word: cobalt\n", { encoding: "utf8", flag: "wx" });
        const header: Header = { v: files ? 2 : 1, kind: "header", conversationId,
          ...(files ? { baseline: files.baseline } : {}),
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
        const store = new ConversationStore(header, headerBytes, log, lock, lockPath, files?.history);
        if (messages.length) await store.saveCheckpoint(messages, files?.baseline);
        else await store.writeMarkdown();
        return { store, messages, configuration: header.configuration,
          ...(selected ? { sourceCheckpoint: { ordinal: selected.checkpoint.ordinal, id: selected.checkpoint.id } } : {}) };
      }
      log = await open(join(directory, "history.jsonl"), constants.O_RDWR | constants.O_APPEND);
      let bytes: Buffer = await log.readFile();
      let parsed = parseHistory(bytes, conversationId);
      compatible(parsed.header.configuration, current);
      if (!parsed.savedEnd) throw new Error("Conversation has no saved completed task.");
      const fileHistory = parsed.header.v === 2 ? await WorkspaceHistory.resume(current.workspace, conversationId) : undefined;
      if (fileHistory) {
        bytes = await ConversationStore.recoverRewind(fileHistory, log, bytes, conversationId, directory);
        parsed = parseHistory(bytes, conversationId);
      }
      // Only locked resume recovers tails. Inspection and branching never alter the source.
      if (parsed.savedEnd !== bytes.length) {
        await log.truncate(parsed.savedEnd);
        await log.sync();
      }
      const store = new ConversationStore(parsed.header, parsed.headerBytes, log, lock, lockPath, fileHistory);
      store.nextOrdinal = parsed.header.v === 2 ? parsed.checkpoints.length : 1;
      store.savedRecords = parsed.records;
      store.hash = parsed.savedHash;
      await store.writeMarkdown();
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
  async checkpoint(messages: Message[]): Promise<string> { return this.saveCheckpoint(messages); }

  private async saveCheckpoint(messages: Message[], capturedTree?: string): Promise<string> {
    if (!this.usable || this.closed) throw new Error("Conversation store is unavailable; stop this runner.");
    const records = messages.map(messageRecord);
    if (records.length <= this.savedRecords.length ||
        this.savedRecords.some((record, index) => records[index] !== record)) {
      throw new Error("Saved conversation prefix changed or no new messages were provided.");
    }
    const newRecords = records.slice(this.savedRecords.length);
    const nextHash = this.hash.copy();
    for (const record of newRecords) nextHash.update(record);
    const id = this.conversationId + ":" + (this.fileHistory ? this.nextOrdinal : messages.length);
    const tree = capturedTree ?? await this.fileHistory?.capture("checkpoint");
    const digest = nextHash.copy();
    if (tree) digest.update("\0" + tree);
    const marker = JSON.stringify({ v: 1, kind: "checkpoint", id,
      messageCount: messages.length, digest: digest.digest("hex"), ...(tree ? { tree } : {}) }) + "\n";
    try {
      await this.log.writeFile(newRecords.join("") + marker);
      await this.log.sync();
    } catch (error) {
      this.usable = false;
      throw error;
    }
    this.hash = nextHash;
    this.savedRecords = records;
    this.nextOrdinal++;
    await this.writeMarkdown();
    return id;
  }

  // A rewind changes the active head, never deletes already saved checkpoints.
  async rewind(ordinal: number): Promise<Message[]> {
    if (!this.usable || this.closed || !this.fileHistory) throw new Error("In-place rewind requires an active coding conversation.");
    const parsed = parseHistory(await snapshot(join(this.header.configuration.workspace, "sessions", this.conversationId, "history.jsonl")), this.conversationId);
    const target = parsed.checkpoints.find((item) => item.ordinal === ordinal);
    if (!target) throw new Error("No saved checkpoint #" + ordinal);
    const directory = join(this.header.configuration.workspace, "sessions", this.conversationId);
    const pending = join(directory, "rewind.pending.json");
    let marker = "";
    try {
      await this.fileHistory.restore(target.tree!, async () => {
        const recoveryTree = await this.fileHistory!.capture("before-rewind");
        const operationId = randomUUID();
        marker = rewindRecord(this.hash, target.id, recoveryTree, operationId);
        const temporary = pending + ".tmp-" + operationId;
        await writeFile(temporary, JSON.stringify({ v: 1, offset: parsed.savedEnd,
          checkpointId: target.id, recoveryTree, operationId }), { flag: "wx", flush: true });
        await link(temporary, pending); // Atomically publish complete bytes without overwriting a journal.
        await unlink(temporary);
        await syncDirectory(directory);
      });
      await this.log.writeFile(marker);
      await this.log.sync();
      this.hash.update(marker);
      this.savedRecords = target.messages!.map(messageRecord);
      await unlink(pending);
      await syncDirectory(directory);
      await this.writeMarkdown();
      return target.messages!;
    } catch (error) {
      this.usable = false;
      throw new Error("Rewind stopped. Resume this conversation to recover any pending restoration.", { cause: error });
    }
  }

  private static async recoverRewind(files: WorkspaceHistory, log: FileHandle, bytes: Buffer,
      conversationId: string, directory: string): Promise<Buffer> {
    const pendingPath = join(directory, "rewind.pending.json");
    let pending: unknown;
    try { pending = JSON.parse((await snapshot(pendingPath)).toString()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return bytes; throw error; }
    if (!object(pending) || !fields(pending, ["v", "offset", "checkpointId", "recoveryTree", "operationId"]) ||
        pending.v !== 1 || !Number.isSafeInteger(pending.offset) || Number(pending.offset) < 0 || Number(pending.offset) > bytes.length ||
        typeof pending.checkpointId !== "string" || typeof pending.recoveryTree !== "string" || !/^[0-9a-f]{40}$/.test(pending.recoveryTree) ||
        typeof pending.operationId !== "string" || !uuidPattern.test(pending.operationId)) throw new Error("Invalid pending rewind; files were not replaced.");
    const offset = Number(pending.offset);
    const prefix = bytes.subarray(0, offset);
    const previous = parseHistory(prefix, conversationId);
    if (previous.savedEnd !== offset || !previous.checkpoints.some((item) => item.id === pending.checkpointId)) {
      throw new Error("Pending rewind does not match saved history; files were not replaced.");
    }
    const expected = Buffer.from(rewindRecord(previous.savedHash, pending.checkpointId, pending.recoveryTree, pending.operationId));
    const tail = bytes.subarray(offset);
    if (tail.equals(expected)) {
      parseHistory(bytes, conversationId); // A validated marker was published only after restoration finished.
      await log.sync();
    } else {
      if (tail.length >= expected.length || !tail.equals(expected.subarray(0, tail.length))) {
        throw new Error("Unexpected history after pending rewind; files were not replaced.");
      }
      // Exceptional crash recovery preserves interrupted/manual changes before rolling back.
      await files.capture("interrupted-rewind");
      await files.restore(pending.recoveryTree);
      await log.truncate(offset);
      await log.sync();
      bytes = prefix;
      console.log("Interrupted rewind rolled back; interrupted files retained in file-snapshots.md.");
    }
    await unlink(pendingPath);
    await syncDirectory(directory);
    return bytes;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.log.close(); } finally {
      try { await this.lock.close(); } finally { await unlink(this.lockPath); }
    }
  }
}
