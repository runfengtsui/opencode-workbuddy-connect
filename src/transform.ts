import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultOutput,
} from "@ai-sdk/provider";

// OpenAI-compatible message shapes, as WorkBuddy's /v2/chat/completions
// accepts them. Reference: pi-workbuddy-connect prepareChatPayload().

export interface WorkBuddyToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type WorkBuddyContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface WorkBuddyMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | WorkBuddyContentPart[] | null;
  tool_calls?: WorkBuddyToolCall[];
  tool_call_id?: string;
}

export interface WorkBuddyTool {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}

function dataContentToUrl(part: LanguageModelV3FilePart): string {
  if (part.data instanceof URL) return part.data.toString();
  if (typeof part.data === "string") {
    if (/^(https?:|data:)/i.test(part.data)) return part.data;
    return `data:${part.mediaType};base64,${part.data}`;
  }
  return `data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}`;
}

function stringifyToolResultOutput(output: LanguageModelV3ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "execution-denied":
      return output.reason ? `Execution denied: ${output.reason}` : "Execution denied";
    case "content":
      return output.value
        .map((part) => {
          if (part.type === "text") return part.text;
          if (part.type === "file-url") return part.url;
          if (part.type === "image-url") return part.url;
          if (part.type === "file-id" || part.type === "image-file-id")
            return typeof part.fileId === "string" ? part.fileId : JSON.stringify(part.fileId);
          return "mediaType" in part ? `[${part.mediaType}]` : `[${part.type}]`;
        })
        .join("\n");
  }
}

/**
 * The V3 spec says user/assistant content is always an array of parts, but
 * V2 callers (and hand-written harnesses) may pass a plain string. Normalize
 * both to the array form so the loops below can't silently drop content.
 */
type ContentLike = NonNullable<LanguageModelV3Message["content"]> | string;

function normalizeContent(content: ContentLike): Array<{ type: string } & Record<string, unknown>> {
  if (typeof content === "string") {
    return [{ type: "text", text: content } satisfies LanguageModelV3TextPart] as unknown as Array<
      { type: string } & Record<string, unknown>
    >;
  }
  return content as unknown as Array<{ type: string } & Record<string, unknown>>;
}

function transformUserMessage(
  message: Extract<LanguageModelV3Message, { role: "user" }>,
): WorkBuddyMessage {
  const parts: WorkBuddyContentPart[] = [];
  let hasImage = false;
  for (const part of normalizeContent(message.content)) {
    if (part.type === "text") {
      parts.push({ type: "text", text: String(part.text ?? "") });
      continue;
    }
    if (part.type === "file" && String(part.mediaType ?? "").startsWith("image/")) {
      hasImage = true;
      parts.push({ type: "image_url", image_url: { url: dataContentToUrl(part as unknown as LanguageModelV3FilePart) } });
    }
  }
  if (!hasImage) {
    return {
      role: "user",
      content: parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join(""),
    };
  }
  return { role: "user", content: parts };
}

function transformAssistantMessage(
  message: Extract<LanguageModelV3Message, { role: "assistant" }>,
): WorkBuddyMessage {
  let content = "";
  const toolCalls: WorkBuddyToolCall[] = [];
  for (const part of normalizeContent(message.content)) {
    // Replayed reasoning is deliberately DROPPED. WorkBuddy's endpoint
    // rejects assistant turns carrying reasoning/thinking fields, and the
    // reference strips them for exactly that reason.
    if (part.type === "text") content += String(part.text ?? "");
    if (part.type === "tool-call") {
      const call = part as unknown as LanguageModelV3ToolCallPart;
      toolCalls.push({
        id: call.toolCallId,
        type: "function",
        function: {
          name: call.toolName,
          arguments: typeof call.input === "string" ? call.input : JSON.stringify(call.input),
        },
      });
    }
  }
  // content must stay a string (possibly empty), never null: an assistant
  // tool-call turn with null content breaks the upstream's tool_call_id
  // matching (documented for the Kimi/Moonshot adapters this gateway routes).
  const result: WorkBuddyMessage = { role: "assistant", content };
  if (toolCalls.length > 0) result.tool_calls = toolCalls;
  return result;
}

function transformToolMessage(
  message: Extract<LanguageModelV3Message, { role: "tool" }>,
): WorkBuddyMessage[] {
  return message.content.flatMap((part) => {
    if (part.type !== "tool-result") return [];
    return [
      {
        role: "tool" as const,
        tool_call_id: part.toolCallId,
        content: stringifyToolResultOutput(part.output),
      },
    ];
  });
}

export interface TransformedPrompt {
  messages: WorkBuddyMessage[];
}

export function transformPrompt(prompt: LanguageModelV3Prompt): TransformedPrompt {
  const messages: WorkBuddyMessage[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      messages.push({ role: "system", content: message.content });
      continue;
    }
    if (message.role === "user") {
      messages.push(transformUserMessage(message));
      continue;
    }
    if (message.role === "assistant") {
      messages.push(transformAssistantMessage(message));
      continue;
    }
    if (message.role === "tool") messages.push(...transformToolMessage(message));
  }
  // The endpoint expects a leading system turn; opencode always supplies one,
  // but a bare library call might not. The neutral default matches the
  // reference's unshift.
  if (messages.length > 0 && messages[0].role !== "system") {
    messages.unshift({ role: "system", content: "You are a helpful assistant." });
  }
  return { messages };
}

export function transformTools(
  tools: LanguageModelV3CallOptions["tools"],
): { tools: WorkBuddyTool[]; ignoredTools: number } {
  if (!tools?.length) return { tools: [], ignoredTools: 0 };
  const result: WorkBuddyTool[] = [];
  let ignoredTools = 0;
  for (const tool of tools) {
    if (tool.type !== "function") {
      ignoredTools++;
      continue;
    }
    const functionTool = tool as LanguageModelV3FunctionTool;
    result.push({
      type: "function",
      function: {
        name: functionTool.name,
        description: functionTool.description,
        parameters: functionTool.inputSchema,
      },
    });
  }
  return { tools: result, ignoredTools };
}
