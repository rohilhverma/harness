export interface AgentConfiguration {
  identity: AgentIdentity;
  model: ModelConfiguration;
  tools: ToolDefinition[];
  memory: ConversationMemory;
  compaction?: Compaction;
  workspace?: string; // Absolute tool root, shown to the model in the notes block.
  programs?: () => { process_id: string; command: string; state: string }[]; // exec programs, shown in the notes block.
}

// The prompt shows `summary`, then messages from `boundary` on. Tool outputs before
// `messageCount` were shortened when this was made. The full history stays in memory.
export interface Compaction {
  summary: string;
  boundary: number;
  messageCount: number;
}

export interface AgentIdentity {
  name: string;
  systemPrompt: string;
}

export interface ModelConfiguration {
  temperature?: number;
  maxTokens?: number;
  seed?: number;
}

export interface ModelProvider<Client> {
  createClient(): Promise<Client | null>;
  generate(request: ModelRequest): Promise<ModelResponse>;
  release?(sequence: number): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface ModelRequest {
  messages: Message[];
  temperature?: number;
  tools?: ToolDefinition[];
  maxTokens?: number;
  seed?: number;
  sequence?: number;
}

export interface ModelResponse {
  output: Message;
  conclusion: "success" | "error" | "length" | "tool_request";
  usage: { promptTokens: number; generatedTokens: number }; // Exact sidecar counts for this request.
  error?: string; // With conclusion "error": why the reply ran nothing. Agent sends it back to the model.
}

// Remaining allowances for one outer user task, shared with its children.
export interface RunBudget {
  modelCalls: number;
  toolCalls: number;
  delegations: number;
}

export interface ToolExecutionContext {
  budget: RunBudget;
  depth: 0 | 1;
  userTask: string;
  turn: number;
  readRanges: Map<string, {
    version: string;
    ranges: { start: number; end: number; turn: number }[];
  }>;
  // Each file's check problems from before this request first changed it.
  baselines: Map<string, string[]>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON-schema-style
  execute: (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Promise<unknown>;
}

export interface RunCommandResult {
  ok: boolean;
  status: "success" | "failed" | "timeout" | "rejected";
  exit_code: number | null;
  full_output?: Partial<Record<"stdout" | "stderr", string>>;
  note?: string;
  stdout: string;
  stderr: string;
  output_truncated: boolean;
  error: string | null;
}

export type ReadFileResult =
  | {
      ok: true;
      path: string;
      start_line: number;
      end_line: number | null;
      total_lines: number;
      content: string;
      next_line: number | null;
    }
  | {
      ok: false;
      path: string;
      error: string;
    };

export type SearchResult =
  | {
      ok: true;
      full_results?: string;
      total_matches?: number;
      note?: string;
      names?: string[];
      suggestions?: {
        term: string;
        path: string;
        line: number;
        text: string;
      }[];
      files: {
        path: string;
        matches: {
          line: number;
          text: string;
          context: string;
        }[];
      }[];
      limited: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type EditFileResult =
  | { ok: true; path: string; start_line?: number; end_line?: number; total_lines?: number; problems?: string[];
      warnings?: string[]; content?: string }
  | { ok: false; path: string; error: string };

export class ConversationMemory {
  private readonly items: Message[] = [];

  add(message: Message): void {
    this.items.push(message);
  }

  messages(): Message[] {
    return [...this.items];
  }
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCalls[];
}

export interface ToolCalls {
  id: string;
  name: string;
  arguments: string;
}

export type SidecarReply =
  | { v: 1; id: string; ok: true; result: Record<string, unknown> }
  | { v: 1; id: string; ok: false; error: { code: string; message: string } };

export interface SidecarPending {
  id: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
