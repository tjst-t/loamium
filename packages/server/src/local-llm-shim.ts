/**
 * OpenAI 互換 shim の変換ロジックと内蔵エンジンのプロセス内シングルトン (S8a3f2e-2)。
 *
 * ADR-0025: Hono に極薄の OpenAI 互換ルートを設け、pi SDK (openai-completions
 * アダプタ) の baseUrl をローカルへ向ける。ここは「OpenAI chat.completions 形 ↔
 * LlamaChatSession の prompt/completion」の変換と、pi が読む内蔵モデル一覧の
 * OpenAI models 形整形を担う純粋関数群 + エンジン保持。
 *
 * ルーティング (routes/llm.ts) はこのモジュールの純粋関数を呼ぶだけにして、
 * HTTP と変換ロジックを分離しテスト可能に保つ。
 */
import {
  LocalLlmEngine,
  selectEngineLoaderFromEnv,
  type CompletionOptions,
  type ChatOptions,
} from './local-llm-engine.js';
import {
  toolsToEngineDefs,
  messagesToToolChat,
  type EngineToolCall,
  type ToolChatMessage,
} from './local-llm-tools.js';
import type { LlmChatMessage, LlmChatRequest } from '@loamium/shared';

/**
 * プロセス内で共有する内蔵 LLM エンジン。単一ユーザーローカル前提のため 1 本
 * (local-llm-engine 側で load/unload/推論を直列化する)。shim ルートとモデル管理
 * (削除時のアンロード) が同じインスタンスを参照する。
 *
 * ローダーは selectEngineLoaderFromEnv で決める。通常は node-llama-cpp の実
 * ローダーだが、オフライン acceptance (LOAMIUM_LLM_TEST_STUB=1) のときだけ addon
 * 非依存の決定的スタブへ切り替わる。pi → shim → engine の経路自体は本物を通す。
 */
export const sharedLocalLlmEngine = new LocalLlmEngine(selectEngineLoaderFromEnv());

/** OpenAI tool_call (function calling レスポンス)。arguments は JSON 文字列。 */
export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** OpenAI chat.completion レスポンス (非ストリーム) の最小形。 */
export interface OpenAiChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: 'assistant';
      // tool_calls のみのターンでは content は null (OpenAI 仕様)。
      content: string | null;
      tool_calls?: OpenAiToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls';
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** ストリーム delta 内の tool_call (index 付き)。arguments は JSON 文字列 (一括送出)。 */
export interface OpenAiToolCallDelta {
  index: number;
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** OpenAI chat.completion.chunk (ストリーム delta) の最小形。 */
export interface OpenAiChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: OpenAiToolCallDelta[];
    };
    finish_reason: 'stop' | 'tool_calls' | null;
  }[];
}

/** OpenAI 互換エラーレスポンス ({error:{message,type}})。 */
export interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
  };
}

/**
 * OpenAI messages[] を LlamaChatSession に渡す単一プロンプト文字列へ縮約する。
 *
 * LlamaChatSession.prompt(text) は「1 ユーザーターンのテキスト」を受ける薄い面
 * (local-llm-engine の LoadedSession)。会話履歴 / system は role ラベル付きで
 * 連結し、最後のユーザー発話へ橋渡しする最小変換とする。単一ユーザーローカルの
 * 「無いよりまし」なローカル推論という位置付け (ADR-0025 consequences) に沿う。
 */
export function messagesToPrompt(messages: LlmChatMessage[]): string {
  // 末尾が user なら、その手前までを文脈として前置し、末尾 user を主プロンプトにする。
  const parts: string[] = [];
  for (const m of messages) {
    const text = messageContentToText(m.content);
    if (m.role === 'system') parts.push(`System: ${text}`);
    else if (m.role === 'assistant') parts.push(`Assistant: ${text}`);
    else parts.push(`User: ${text}`);
  }
  return parts.join('\n\n');
}

/**
 * content (文字列 or content パート配列) をプレーンテキストへ縮約する。
 * OpenAI 互換で pi は `[{type:'text', text}]` を送ることがあるため、text パートを
 * 連結する (image_url 等の非テキストパートは無視 — ローカル LLM では扱わない)。
 */
export function messageContentToText(content: LlmChatMessage['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
}

/** リクエストから CompletionOptions を抽出する (未指定キーは渡さない)。 */
export function completionOptionsFromRequest(req: LlmChatRequest): CompletionOptions {
  const opts: CompletionOptions = {};
  if (req.max_tokens !== undefined) opts.maxTokens = req.max_tokens;
  if (req.temperature !== undefined) opts.temperature = req.temperature;
  return opts;
}

/**
 * リクエストから ChatOptions (function calling) を抽出する (ADR-0025 amendment)。
 * tools があれば中立ツール定義へ変換して載せる。tool_choice は現状 passthrough
 * (node-llama-cpp が functions を渡すと自動で functionCalls 停止し得るため、
 * 'none' 以外は functions を広告する。'none' のときは tools を渡さずテキスト専用)。
 */
export function chatOptionsFromRequest(req: LlmChatRequest): ChatOptions {
  const opts: ChatOptions = {};
  if (req.max_tokens !== undefined) opts.maxTokens = req.max_tokens;
  if (req.temperature !== undefined) opts.temperature = req.temperature;
  if (req.tools && req.tools.length > 0 && req.tool_choice !== 'none') {
    opts.tools = toolsToEngineDefs(req.tools);
  }
  return opts;
}

/** 疑似トークン数 (空白区切りの語数)。usage は概算で十分 (ローカル・課金なし)。 */
export function approxTokens(text: string): number {
  const t = text.trim();
  if (t === '') return 0;
  return t.split(/\s+/).length;
}

/** 一意な completion id を生成する。 */
export function newCompletionId(): string {
  return `chatcmpl-local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 非ストリームの OpenAI chat.completion レスポンスを組み立てる。 */
export function buildChatCompletion(
  model: string,
  promptText: string,
  content: string,
): OpenAiChatCompletion {
  const promptTokens = approxTokens(promptText);
  const completionTokens = approxTokens(content);
  return {
    id: newCompletionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * tool_calls 応答 (function calling) の OpenAI chat.completion を組み立てる。
 * message.content は null、tool_calls[] を載せ、finish_reason='tool_calls'。
 * arguments は JSON 文字列 (engine が JSON.stringify 済み)。
 */
export function buildToolCallsCompletion(
  model: string,
  promptText: string,
  toolCalls: EngineToolCall[],
): OpenAiChatCompletion {
  const promptTokens = approxTokens(promptText);
  const openAiToolCalls: OpenAiToolCall[] = toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function',
    function: { name: tc.name, arguments: tc.argumentsJson },
  }));
  return {
    id: newCompletionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: openAiToolCalls },
        finish_reason: 'tool_calls',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 0,
      total_tokens: promptTokens,
    },
  };
}

/** shim が engine.chat へ渡す中立会話履歴を組み立てる (messages → ToolChatMessage[])。 */
export function requestToToolChat(req: LlmChatRequest): ToolChatMessage[] {
  return messagesToToolChat(req.messages);
}

/** ストリーム 1 チャンク (delta.content) を組み立てる。 */
export function buildChatChunk(id: string, model: string, delta: string): OpenAiChatChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
  };
}

/**
 * tool_calls をストリーム delta として送出する 1 チャンク (function calling)。
 * engine はトークン単位のストリームを公開しないため、tool_calls を 1 チャンクに
 * まとめて送る (index/id/name/arguments を一括)。finish_reason はまだ null。
 */
export function buildToolCallsChunk(
  id: string,
  model: string,
  toolCalls: EngineToolCall[],
): OpenAiChatChunk {
  const delta: OpenAiToolCallDelta[] = toolCalls.map((tc, index) => ({
    index,
    id: tc.id,
    type: 'function',
    function: { name: tc.name, arguments: tc.argumentsJson },
  }));
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: delta }, finish_reason: null }],
  };
}

/** ストリーム終端チャンク (delta 空)。finish_reason は 'stop' 既定 / 'tool_calls' 選択可。 */
export function buildFinalChunk(
  id: string,
  model: string,
  finishReason: 'stop' | 'tool_calls' = 'stop',
): OpenAiChatChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
}

/** OpenAI 互換エラーボディを組み立てる。 */
export function buildErrorBody(message: string, type: string): OpenAiErrorBody {
  return { error: { message, type } };
}
