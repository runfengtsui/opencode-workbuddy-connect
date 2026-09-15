import crypto from "node:crypto";
import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FinishReason,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
  type LanguageModelV3Usage,
  type SharedV3Warning,
} from "@ai-sdk/provider";
import {
  baseUrlFor,
  chatHeaders,
  refreshWorkBuddyToken,
  resolveWorkBuddyCredentials,
  saveOwnStore,
  type WorkBuddyCredentials,
  type WorkBuddyProviderOptions,
} from "./auth.js";
import { flashMaxTokensCap } from "./constants.js";
import { readEnvSafe } from "./env-helpers.js";
import { errorMessage, logPlugin } from "./log.js";
import { getModelDefinition, type WorkBuddyModelDefinition } from "./models.js";
import { transformPrompt, transformTools, type WorkBuddyMessage, type WorkBuddyTool } from "./transform.js";

// ---------------------------------------------------------------------------
// Chunk shapes (pure OpenAI SSE, verified against the live gateway)
// ---------------------------------------------------------------------------

type WorkBuddyChunk = {
  id?: string;
  model?: string;
  created?: number;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    message?: unknown;
  }>;
};

type ToolCallState = {
  id?: string;
  upstreamID: boolean;
  name: string;
  arguments: string;
  started: boolean;
  finished: boolean;
  pendingDeltas: string[];
};

function mapFinishReason(raw: string | undefined, hasToolCalls: boolean): LanguageModelV3FinishReason {
  if (hasToolCalls || raw === "tool_calls" || raw === "function_call") return { unified: "tool-calls", raw };
  if (raw === "length") return { unified: "length", raw };
  if (raw === "content_filter") return { unified: "content-filter", raw };
  if (!raw || raw === "stop") return { unified: "stop", raw };
  return { unified: "other", raw };
}

function usageFromWorkBuddy(raw?: WorkBuddyChunk["usage"]): LanguageModelV3Usage {
  const promptTokens = raw?.prompt_tokens;
  const cachedTokens = raw?.prompt_tokens_details?.cached_tokens;
  return {
    inputTokens: {
      total: promptTokens,
      noCache:
        promptTokens !== undefined && cachedTokens !== undefined ? promptTokens - cachedTokens : undefined,
      cacheRead: cachedTokens,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: raw?.completion_tokens,
      text: undefined,
      reasoning: raw?.completion_tokens_details?.reasoning_tokens,
    },
    raw,
  };
}

function isParsableJson(input: string): boolean {
  try {
    JSON.parse(input);
    return true;
  } catch {
    return false;
  }
}

class StreamEmitter {
  private textID: string | undefined;
  private reasoningID: string | undefined;
  private textIndex = 0;

  constructor(private controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) {}

  text(delta: string): void {
    if (!delta) return;
    this.endReasoning();
    if (!this.textID) {
      this.textID = `txt-${this.textIndex++}`;
      this.controller.enqueue({ type: "text-start", id: this.textID });
    }
    this.controller.enqueue({ type: "text-delta", id: this.textID, delta });
  }

  endText(): void {
    if (!this.textID) return;
    this.controller.enqueue({ type: "text-end", id: this.textID });
    this.textID = undefined;
  }

  reasoning(delta: string): void {
    if (!delta) return;
    if (!this.reasoningID) {
      this.endText();
      this.reasoningID = "reasoning-0";
      this.controller.enqueue({ type: "reasoning-start", id: this.reasoningID });
    }
    this.controller.enqueue({ type: "reasoning-delta", id: this.reasoningID, delta });
  }

  endReasoning(): void {
    if (!this.reasoningID) return;
    this.controller.enqueue({ type: "reasoning-end", id: this.reasoningID });
    this.reasoningID = undefined;
  }

  closeOpenBlocks(): void {
    this.endReasoning();
    this.endText();
  }
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

// Effort ladder. Only sent when the model advertises efforts AND the user
// picked one (variant body or env override) -- an unrequested field must not
// turn "Default" into "high" (reference: "never inject reasoning_effort").
function resolveReasoningEffort(
  options: LanguageModelV3CallOptions,
  model: WorkBuddyModelDefinition | undefined,
): string | undefined {
  const supported = model?.efforts ?? [];
  if (supported.length === 0) return undefined;
  const env = readEnvSafe("WORKBUDDY_REASONING_EFFORT").toLowerCase();
  const bag = options as Record<string, unknown>;
  const picked = (env || String(bag?.reasoningEffort ?? bag?.reasoning_effort ?? ""))
    .trim()
    .toLowerCase();
  if (!picked) return undefined;
  return supported.includes(picked) ? picked : undefined;
}

function buildRequestBody(
  modelID: string,
  options: LanguageModelV3CallOptions,
): { body: Record<string, unknown>; warnings: SharedV3Warning[] } {
  const model = getModelDefinition(modelID);
  const transformed = transformPrompt(options.prompt);
  const { tools, ignoredTools } = transformTools(options.tools);
  const warnings: SharedV3Warning[] = [];
  if (ignoredTools > 0) warnings.push({ type: "unsupported", feature: "provider-defined tools" });
  if (options.stopSequences?.length) warnings.push({ type: "unsupported", feature: "stop sequences" });
  if (options.responseFormat?.type === "json")
    warnings.push({ type: "unsupported", feature: "JSON response format" });

  let maxTokens = model?.maxTokens ?? 32_000;
  if (options.maxOutputTokens && options.maxOutputTokens < maxTokens) maxTokens = options.maxOutputTokens;
  maxTokens = flashMaxTokensCap(modelID, maxTokens);

  const body: Record<string, unknown> = {
    model: modelID,
    messages: transformed.messages,
    stream: true,
    // The gateway honors include_usage and answers the final chunk with a
    // full usage record (tokens, cached, reasoning) -- verified live.
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
  };
  if (typeof options.temperature === "number") body.temperature = options.temperature;
  if (typeof options.topP === "number") body.top_p = options.topP;
  if (tools.length > 0) body.tools = tools;

  const effort = resolveReasoningEffort(options, model);
  if (effort) body.reasoning_effort = effort;

  return { body, warnings };
}

function throwWorkBuddyApiError(status: number, url: string, body: string): never {
  let message = `WorkBuddy API error ${status}`;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; msg?: string; message?: string };
    const detail = parsed.error?.message || parsed.msg || parsed.message;
    if (detail) message = `WorkBuddy API error ${status}: ${detail}`;
  } catch {
    /* non-JSON error body */
  }
  if (status === 401 || status === 403) {
    message += " — the credential was rejected. Re-run /connect workbuddy or refresh the desktop login.";
  }
  throw new APICallError({
    message,
    url,
    requestBodyValues: undefined,
    statusCode: status,
    responseBody: body,
    isRetryable: status === 429 || status >= 500,
  });
}

// ---------------------------------------------------------------------------
// Language model
// ---------------------------------------------------------------------------

export class WorkBuddyLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "workbuddy";
  readonly supportedUrls = { "image/*": [/^data:/, /^https?:/] };

  constructor(
    readonly modelId: string,
    private readonly providerOptions: WorkBuddyProviderOptions = {},
  ) {}

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const result = await this.doStream(options);
    const content: LanguageModelV3Content[] = [];
    const textByID = new Map<string, { type: "text"; text: string }>();
    const reasoningByID = new Map<string, { type: "reasoning"; text: string }>();
    let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: undefined };
    let usage = usageFromWorkBuddy();
    const warnings: SharedV3Warning[] = [];

    for await (const part of result.stream) {
      if (part.type === "stream-start") warnings.push(...part.warnings);
      if (part.type === "text-start") {
        const block = { type: "text" as const, text: "" };
        textByID.set(part.id, block);
        content.push(block);
      }
      if (part.type === "text-delta") {
        const block = textByID.get(part.id);
        if (block) block.text += part.delta;
      }
      if (part.type === "reasoning-start") {
        const block = { type: "reasoning" as const, text: "" };
        reasoningByID.set(part.id, block);
        content.push(block);
      }
      if (part.type === "reasoning-delta") {
        const block = reasoningByID.get(part.id);
        if (block) block.text += part.delta;
      }
      if (part.type === "tool-call") {
        content.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
      }
      if (part.type === "finish") {
        finishReason = part.finishReason;
        usage = part.usage;
      }
      if (part.type === "error") throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
    return { content, finishReason, usage, warnings, request: result.request, response: result.response };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const abortController = new AbortController();
    const signal = options.abortSignal;
    const abort = () => abortController.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const detachAbort = () => signal?.removeEventListener("abort", abort);

    const credentials = await resolveWorkBuddyCredentials(this.providerOptions);
    const { body, warnings } = buildRequestBody(this.modelId, options);
    let opened: { response: Response; url: string };
    try {
      opened = await this.openRequest(credentials, body, abortController);
    } catch (error) {
      detachAbort();
      throw error;
    }
    if (!opened.response.ok) {
      detachAbort();
      const status = opened.response.status;
      const text = await opened.response.text().catch(() => "");
      // One credential renewal on a rejection a fresh token can cure
      // (revoked/rotated access token), then replay the request once.
      if (status === 401 || status === 403) {
        const renewed = await this.renew(credentials).catch(() => undefined);
        if (renewed) {
          logPlugin("chat: credential rejected -- renewed and replaying once");
          try {
            const retry = await this.openRequest(renewed, body, abortController);
            if (retry.response.ok) {
              return this.streamOf(retry.response, body, warnings, detachAbort);
            }
            detachAbort();
            throwWorkBuddyApiError(retry.response.status, retry.url, await retry.response.text().catch(() => ""));
          } catch (retryError) {
            detachAbort();
            throw retryError;
          }
        }
      }
      throwWorkBuddyApiError(status, opened.url, text);
    }
    return this.streamOf(opened.response, body, warnings, detachAbort);
  }

  private async renew(cred: WorkBuddyCredentials): Promise<WorkBuddyCredentials | undefined> {
    if (!cred.refreshToken) return undefined;
    try {
      const next = await refreshWorkBuddyToken(cred);
      saveOwnStore(next);
      return next;
    } catch (error) {
      logPlugin(`chat: renewal failed (${errorMessage(error)})`);
      return undefined;
    }
  }

  private async openRequest(
    credentials: WorkBuddyCredentials,
    body: Record<string, unknown>,
    abortController: AbortController,
  ): Promise<{ response: Response; url: string }> {
    const base = baseUrlFor(credentials, this.providerOptions);
    const url = `${base}/v2/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...chatHeaders(credentials),
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        "Accept-Encoding": "identity",
      },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });
    return { response, url };
  }

  private streamOf(
    response: Response,
    body: Record<string, unknown>,
    warnings: SharedV3Warning[],
    detachAbort: () => void,
  ): LanguageModelV3StreamResult {
    return {
      stream: this.responseToStream(response, warnings, detachAbort),
      request: { body },
      response: { headers: Object.fromEntries(response.headers.entries()) },
    };
  }

  private responseToStream(
    response: Response,
    warnings: SharedV3Warning[],
    detachAbort: () => void,
  ): ReadableStream<LanguageModelV3StreamPart> {
    const modelID = this.modelId;
    return new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings });
        const reader = response.body?.getReader();
        if (!reader) throw new Error("WorkBuddy response body is empty");

        const decoder = new TextDecoder();
        const emitter = new StreamEmitter(controller);
        const toolCalls: ToolCallState[] = [];
        let buffer = "";
        let rawFinishReason: string | undefined;
        let rawUsage: WorkBuddyChunk["usage"];
        let sawToolCall = false;
        let done = false;

        const startToolCall = (state: ToolCallState): string => {
          if (!state.id) state.id = crypto.randomUUID();
          if (!state.started) {
            state.started = true;
            controller.enqueue({ type: "tool-input-start", id: state.id, toolName: state.name });
            for (const pending of state.pendingDeltas) {
              controller.enqueue({ type: "tool-input-delta", id: state.id, delta: pending });
            }
            state.pendingDeltas = [];
          }
          return state.id;
        };

        const finishToolCall = (state: ToolCallState) => {
          if (state.finished || !state.name) return;
          state.finished = true;
          const id = startToolCall(state);
          controller.enqueue({ type: "tool-input-end", id });
          controller.enqueue({ type: "tool-call", toolCallId: id, toolName: state.name, input: state.arguments });
          sawToolCall = true;
        };

        const handleChunk = (chunk: WorkBuddyChunk) => {
          if (chunk.id || chunk.model || chunk.created) {
            controller.enqueue({
              type: "response-metadata",
              id: chunk.id,
              modelId: chunk.model || modelID,
              timestamp: chunk.created ? new Date(chunk.created * 1000) : undefined,
            });
          }
          if (chunk.usage) rawUsage = chunk.usage;
          const choice = chunk.choices?.[0];
          if (!choice) return;
          // finish_reason can ride a chunk whose delta is a stub (verified:
          // the last chunk carries the usage plus an empty-content delta).
          if (choice.finish_reason && choice.finish_reason !== "") rawFinishReason = choice.finish_reason;
          const delta = choice.delta;
          if (!delta) return;
          if (delta.reasoning_content) emitter.reasoning(delta.reasoning_content);
          if (delta.content) emitter.text(delta.content);
          if (delta.tool_calls) {
            emitter.endReasoning();
            emitter.endText();
            for (const tc of delta.tool_calls) {
              const index = tc.index ?? 0;
              let state = toolCalls[index];
              if (!state) {
                state = { id: undefined, upstreamID: false, name: "", arguments: "", started: false, finished: false, pendingDeltas: [] };
                toolCalls[index] = state;
              }
              if (tc.id) {
                state.id = tc.id;
                state.upstreamID = true;
              }
              if (tc.function?.name) state.name = tc.function.name;
              if (!state.started && state.name && state.upstreamID) startToolCall(state);
              const argDelta = tc.function?.arguments || "";
              if (argDelta) {
                state.arguments += argDelta;
                if (state.started && state.id) {
                  controller.enqueue({ type: "tool-input-delta", id: state.id, delta: argDelta });
                } else {
                  state.pendingDeltas.push(argDelta);
                }
              }
              if (state.started && isParsableJson(state.arguments)) finishToolCall(state);
            }
          }
        };

        try {
          outer: while (!done) {
            const read = await reader.read();
            if (read.done) break;
            buffer += decoder.decode(read.value, { stream: true });
            let newline: number;
            while ((newline = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (payload === "") continue;
              if (payload === "[DONE]") {
                done = true;
                break;
              }
              // A malformed line is dropped, not fatal: proxies truncate.
              try {
                handleChunk(JSON.parse(payload) as WorkBuddyChunk);
              } catch (error) {
                if (error instanceof SyntaxError) {
                  logPlugin(`sse: dropped malformed data line (${payload.slice(0, 80)})`);
                } else {
                  throw error;
                }
              }
            }
            if (done) break outer;
          }

          emitter.closeOpenBlocks();
          for (const state of toolCalls) finishToolCall(state);
          controller.enqueue({
            type: "finish",
            finishReason: mapFinishReason(rawFinishReason, sawToolCall),
            usage: usageFromWorkBuddy(rawUsage),
            providerMetadata: { workbuddy: {} },
          });
          controller.close();
        } catch (error) {
          controller.enqueue({ type: "error", error: error instanceof Error ? error : new Error(String(error)) });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "error", raw: undefined },
            usage: usageFromWorkBuddy(rawUsage),
            providerMetadata: { workbuddy: {} },
          });
          controller.close();
        } finally {
          detachAbort();
          await reader.cancel().catch(() => {});
        }
      },
    });
  }
}

/**
 * AI SDK provider factory. opencode's npm loader calls
 * `createWorkBuddy(providerOptions).languageModel(modelId)` (the same
 * contract as @ai-sdk/openai-compatible and the reference createQoder).
 */
export function createWorkBuddy(
  options?: WorkBuddyProviderOptions,
): { languageModel(modelId: string): WorkBuddyLanguageModel } {
  const providerOptions = options ?? {};
  return {
    languageModel(modelId: string): WorkBuddyLanguageModel {
      return new WorkBuddyLanguageModel(modelId, providerOptions);
    },
  };
}
