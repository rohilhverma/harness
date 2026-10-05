import { randomUUID } from "node:crypto";
import type { Message, ModelRequest, ToolCalls } from "../interfaces.js";

// Match the GGUF template's tojson spacing without changing string contents.
function templateJson(value: unknown): string {
  return JSON.stringify(value).replace(/("(?:\\.|[^"\\])*")|([,:])/g,
    (_match, quoted, punctuation) => quoted ?? punctuation + " ");
}

export function renderQwen(request: ModelRequest): string {
  const { messages, tools } = request;
  let prompt = "";
  if (tools?.length) {
    prompt = "<|im_start|>system\n";
    if (messages[0]?.role === "system") prompt += messages[0].content + "\n\n";
    prompt += "# Tools\n\nYou may call one or more functions to assist with the user query.\n\n";
    prompt += "You are provided with function signatures within <tools></tools> XML tags:\n<tools>";
    for (const tool of tools) {
      prompt += "\n" + templateJson({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      });
    }
    prompt += "\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n";
    prompt += '<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call><|im_end|>\n';
  } else if (messages[0]?.role === "system") {
    prompt = "<|im_start|>system\n" + messages[0].content + "<|im_end|>\n";
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
      prompt += "<|im_start|>" + message.role + "\n" + content + "<|im_end|>\n";
    } else if (message.role === "assistant") {
      let reasoning = "";
      if (content.includes("</think>")) {
        reasoning = content.split("</think>")[0]!.replace(/\n+$/, "").split("<think>").at(-1)!.replace(/^\n+/, "");
        content = content.split("</think>").at(-1)!.replace(/^\n+/, "");
      }
      prompt += "<|im_start|>assistant\n";
      if (i > lastQuery && (i === messages.length - 1 || reasoning)) {
        prompt += "<think>\n" + reasoning.replace(/^\n+|\n+$/g, "") + "\n</think>\n\n" + content.replace(/^\n+/, "");
      } else {
        prompt += content;
      }
      for (const [j, call] of (message.toolCalls ?? []).entries()) {
        if (content || j > 0) prompt += "\n";
        let args = call.arguments;
        try { args = templateJson(JSON.parse(args)); } catch { /* Keep invalid arguments so Agent can recover. */ }
        prompt += '<tool_call>\n{"name": "' + call.name + '", "arguments": ' + args + "}\n</tool_call>";
      }
      prompt += "<|im_end|>\n";
    } else if (message.role === "tool") {
      if (messages[i - 1]?.role !== "tool") prompt += "<|im_start|>user";
      prompt += "\n<tool_response>\n" + content + "\n</tool_response>";
      if (messages[i + 1]?.role !== "tool") prompt += "<|im_end|>\n";
    }
  }
  return prompt + "<|im_start|>assistant\n";
}

export function parseQwen(text: string): Message {
  const toolCalls: ToolCalls[] = [];
  let content = "";
  let cursor = 0;
  let searchFrom = 0;
  if (text.trimStart().startsWith("<think>")) {
    const end = text.indexOf("</think>");
    if (end < 0) {
      throw new Error("Unclosed Qwen reasoning block.");
    }
    searchFrom = end + "</think>".length;
  }

  while (true) {
    const start = text.indexOf("<tool_call>", searchFrom);
    if (start < 0) break;
    content += text.slice(cursor, start);
    let end = text.indexOf("</tool_call>", start);
    let call: unknown;
    // A closing tag can also occur inside a JSON string, such as edit_file text.
    while (end >= 0) {
      try {
        call = JSON.parse(text.slice(start + "<tool_call>".length, end));
        break;
      } catch {
        end = text.indexOf("</tool_call>", end + "</tool_call>".length);
      }
    }
    if (end < 0 || call === null || typeof call !== "object" ||
        !("name" in call) || typeof call.name !== "string" || !call.name ||
        !("arguments" in call)) {
      throw new Error("Invalid Qwen tool-call output.");
    }
    toolCalls.push({
      id: "call_" + randomUUID(),
      name: call.name,
      arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
    });
    cursor = end + "</tool_call>".length;
    searchFrom = cursor;
  }
  content += text.slice(cursor);
  return { role: "assistant", content: toolCalls.length ? content.trim() : content, ...(toolCalls.length ? { toolCalls } : {}) };
}
