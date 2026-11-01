import { randomUUID } from "node:crypto";
import type { Message, ModelRequest, ToolCalls, ToolDefinition } from "../interfaces.js";

// Match the GGUF template's tojson spacing without changing string contents.
function templateJson(value: unknown): string {
  return JSON.stringify(value).replace(/("(?:\\.|[^"\\])*")|([,:])/g,
    (_match, quoted, punctuation) => quoted ?? punctuation + " ");
}

// A run of prompt text. Only special runs, the template's own turn markers, can become control
// tokens; message and tool text is tokenized as plain text, so <|im_end|> in a file cannot end a turn.
export interface PromptSegment {
  text: string;
  special: boolean;
}

export function renderQwen(request: ModelRequest): PromptSegment[] {
  const { messages, tools } = request;
  const segments: PromptSegment[] = [];
  // Neighboring runs of the same kind are joined, so an ordinary prompt tokenizes as one string would.
  const add = (text: string, special: boolean) => {
    const last = segments.at(-1);
    if (!text) return;
    if (last?.special === special) last.text += text;
    else segments.push({ text, special });
  };
  const plain = (text: string) => add(text, false);
  const markup = (text: string) => text.split(/(<\|im_start\|>|<\|im_end\|>)/)
    .forEach((part, index) => add(part, index % 2 === 1));
  if (tools?.length) {
    markup("<|im_start|>system\n");
    if (messages[0]?.role === "system") {
      plain(messages[0].content);
      markup("\n\n");
    }
    markup("# Tools\n\nYou may call one or more functions to assist with the user query.\n\n");
    markup("You are provided with function signatures within <tools></tools> XML tags:\n<tools>");
    for (const tool of tools) {
      markup("\n");
      plain(templateJson({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }
    markup("\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n");
    markup('<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call><|im_end|>\n');
  } else if (messages[0]?.role === "system") {
    markup("<|im_start|>system\n");
    plain(messages[0].content);
    markup("<|im_end|>\n");
  }

  let lastQuery = messages.length - 1;
  for (let i = messages.length - 1; i >= 0; --i) {
    const message = messages[i]!;
    if (message.role === "user" &&
        !(message.content.startsWith("<tool_response>") && message.content.endsWith("</tool_response>"))) {
      lastQuery = i;
      break;
    }
  }

  for (const [i, message] of messages.entries()) {
    let content = message.content;
    if (message.role === "user" || (message.role === "system" && i > 0)) {
      markup("<|im_start|>" + message.role + "\n");
      plain(content);
      markup("<|im_end|>\n");
    } else if (message.role === "assistant") {
      let reasoning = "";
      if (content.includes("</think>")) {
        reasoning = content.split("</think>")[0]!.replace(/\n+$/, "").split("<think>").at(-1)!.replace(/^\n+/, "");
        content = content.split("</think>").at(-1)!.replace(/^\n+/, "");
      }
      markup("<|im_start|>assistant\n");
      if (i > lastQuery && (i === messages.length - 1 || reasoning)) {
        markup("<think>\n");
        plain(reasoning.replace(/^\n+|\n+$/g, ""));
        markup("\n</think>\n\n");
        plain(content.replace(/^\n+/, ""));
      } else {
        plain(content);
      }
      // Unlike the template, past calls are shown as ```json fences, the form Qwen2.5-Coder-7B writes.
      // After its own call shown in <tool_call> tags it made no call in 6 of 6 samples, often starting a
      // new turn with <|im_start|>; after the same call in a fence it made a call in 6 of 6.
      for (const [j, call] of (message.toolCalls ?? []).entries()) {
        if (content || j > 0) markup("\n");
        let args = call.arguments;
        try { args = templateJson(JSON.parse(args)); } catch { /* Keep invalid arguments so Agent can recover. */ }
        markup('```json\n{"name": "');
        plain(call.name);
        markup('", "arguments": ');
        plain(args);
        markup("}\n```");
      }
      markup("<|im_end|>\n");
    } else if (message.role === "tool") {
      if (messages[i - 1]?.role !== "tool") markup("<|im_start|>user");
      markup("\n<tool_response>\n");
      plain(content);
      markup("\n</tool_response>");
      if (messages[i + 1]?.role !== "tool") markup("<|im_end|>\n");
    }
  }
  markup("<|im_start|>assistant\n");
  return segments;
}

// The index just past the JSON object that opens at `start`, or -1 if the text ends first. Braces
// inside strings, such as edit_file text, do not count.
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

// The JSON object at `start` and the end of the closing tag or fence after it, or what is wrong.
function readBlock(text: string, start: number, close: string): { value: unknown; next: number } | string {
  if (text[start] !== "{") return 'must hold a JSON object with "name" and "arguments"';
  const end = objectEnd(text, start);
  if (end < 0) return "is incomplete";
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end));
  } catch (error) {
    return "holds invalid JSON: " + (error instanceof Error ? error.message : String(error));
  }
  const after = end + /^\s*/.exec(text.slice(end))![0].length;
  if (!text.startsWith(close, after)) return `must end with ${close} right after its JSON object`;
  return { value, next: after + close.length };
}

// The one tool whose schema these arguments fit: every required parameter given and no other keys.
// Qwen2.5-Coder sometimes fences a call's arguments without its name.
function inferTool(args: object, tools: ToolDefinition[]): string | undefined {
  const keys = Object.keys(args);
  const fits = tools.filter(({ parameters }) => {
    const properties = Object.keys((parameters.properties ?? {}) as object);
    const required = (parameters.required ?? []) as string[];
    return keys.length > 0 && required.every((key) => keys.includes(key)) &&
      keys.every((key) => properties.includes(key));
  });
  return fits.length === 1 ? fits[0]!.name : undefined;
}

// The start of an object that names one of these tools; {"name": "app", ...} in a package.json is not a call.
function namedCall(tools: ToolDefinition[]): string {
  return String.raw`\{\s*"name"\s*:\s*"(?:${tools.map((tool) => tool.name.replace(/[^\w]/g, "\\$&")).join("|")})"`;
}

// Where a call block can start: the template's <tool_call> tag, a ```json fence opening a JSON object,
// or a line that starts with an object naming a tool. Qwen2.5-Coder-7B writes the last two instead of
// the tags, sometimes indented under a list item.
function callStart(tools: ToolDefinition[]): RegExp {
  return new RegExp(String.raw`<tool_call>|^[ \t]*${"```"}(?:json)?[ \t]*\n(?=\s*\{)|^[ \t]*(?=${namedCall(tools)})`, "gm");
}

// A <tool_call>, or a fence or line whose object starts by naming a tool, must hold a valid call. A fence
// holding only arguments is a call when exactly one tool fits them; other fences are content. As in
// Qwen-Agent's Nous parser, a reply with calls keeps only the text before the first call, so its history
// shows that text followed by the calls rather than prose with holes where the blocks were.
export function parseQwen(text: string, tools: ToolDefinition[] = []): Message {
  const toolCalls: ToolCalls[] = [];
  let content: string | undefined;
  const named = new RegExp("^" + namedCall(tools));
  const starts = callStart(tools);
  if (text.trimStart().startsWith("<think>")) {
    const end = text.indexOf("</think>");
    if (end < 0) {
      throw new Error("Unclosed Qwen reasoning block.");
    }
    starts.lastIndex = end + "</think>".length;
  }

  for (let match; (match = starts.exec(text));) {
    const tagged = match[0] === "<tool_call>";
    const fenced = match[0].includes("```");
    const block = tagged ? "<tool_call>" : fenced ? "```json block" : "JSON call";
    const open = match.index + match[0].length;
    const start = open + /^\s*/.exec(text.slice(open))![0].length;
    const read = readBlock(text, start, tagged ? "</tool_call>" : fenced ? "```" : "");
    let name: string;
    let args: unknown;
    // An unfenced object always names a tool here, so the loop never repeats an empty match.
    if (!fenced || named.test(text.slice(start))) {
      if (typeof read === "string") throw new Error(`A ${block} ${read}.`);
      const call = read.value;
      if (call === null || typeof call !== "object" ||
          !("name" in call) || typeof call.name !== "string" || !call.name ||
          !("arguments" in call)) {
        throw new Error(`A ${block} must hold a JSON object with "name" and "arguments".`);
      }
      name = call.name;
      args = call.arguments;
    } else {
      if (typeof read === "string" || read.value === null || typeof read.value !== "object" ||
          Array.isArray(read.value)) continue;
      const inferred = inferTool(read.value, tools);
      if (!inferred) continue;
      name = inferred;
      args = read.value;
    }
    content ??= text.slice(0, match.index);
    toolCalls.push({
      id: "call_" + randomUUID(),
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    });
    starts.lastIndex = read.next;
  }
  return toolCalls.length ? { role: "assistant", content: content!.trim(), toolCalls } : { role: "assistant", content: text };
}

// A GBNF grammar the sidecar applies once a reply starts a call block naming a tool, so the block is
// well-formed JSON naming a real tool and the reply ends right after it. Calls in one reply cannot see
// each other's results, and Qwen2.5-Coder fills a reply with planned calls, such as an edit of lines
// it reads in the same reply, so one call per reply. Text before the block is free, and a fence of
// bare arguments is left to parseQwen.
export function qwenGrammar(tools: ToolDefinition[]): { grammar: string; triggers: string[] } {
  const names = tools.map((tool) => JSON.stringify(JSON.stringify(tool.name))).join(" | ");
  const grammar = String.raw`root ::= block sep
block ::= "<tool_call>" sep call sep "</tool_call>" | "${"```"}" "json"? [ \t]* "\n" sep call sep "${"```"}" | call
call ::= "{" ws "\"name\"" ws ":" ws name "," ws "\"arguments\"" ws ":" ws object "}"
name ::= (${names}) ws
sep ::= [ \t\n]{0,40}
value ::= object | array | string | number | ("true" | "false" | "null") ws
object ::= "{" ws (string ":" ws value ("," ws string ":" ws value)*)? "}" ws
array ::= "[" ws (value ("," ws value)*)? "]" ws
string ::= "\"" ([^"\\\x7F\x00-\x1F] | "\\" (["\\bfnrt] | "u" [0-9a-fA-F]{4}))* "\"" ws
number ::= ("-"? ([0-9] | [1-9] [0-9]{0,15})) ("." [0-9]+)? ([eE] [-+]? [0-9] [1-9]{0,15})? ws
ws ::= | " " | "\n" [ \t]{0,20}
`;
  // The sidecar constrains from a trigger's first capture group, or from the whole match without one.
  return { grammar, triggers: ["<tool_call>", String.raw`${"```"}(?:json)?[ \t]*\n\s*` + namedCall(tools),
    String.raw`(?:^|\n)[ \t]*(` + namedCall(tools) + ")"] };
}
