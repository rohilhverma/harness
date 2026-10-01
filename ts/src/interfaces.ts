export interface AgentConfiguration {
  identity: AgentIdentity;
  model: ModelConfiguration;
  tools: ToolConfiguration[];
  memory: MemoryConfiguration[];
}

export interface AgentIdentity {
  name: string;
  systemPrompt: string;
}

export interface ModelConfiguration {
  model: string;
  temperature?: number;
  contextWindow?: number;
}

export interface ToolConfiguration {
  toolDefinitions: ToolDefinition;
}

export interface ModelProvider<Client> {
  createClient(): Promise<Client | null>;
  serverStatus(): Promise<boolean>;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

// define a object that handles taking a request and sending to ModelClient
export interface ModelRequest {
  messages: Message[];
  model?: string;
  temperature?: number;
  tools?: ToolDefinition;
}

// have to outline general format of requests
export interface ModelResponse {
  output: Message;
  toolCalls?: ToolCalls[];
  conclusion: "success" | "error" | "length" | "tool_request";
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: null; // outline like a schema
  execute: () => Promise<unknown>;
}

export interface MemoryConfiguration {
  messages: Message[]
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCalls[];
}

export interface ToolCalls {
  name: string;
  arguments: string;
}
