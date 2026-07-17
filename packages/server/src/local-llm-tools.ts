/**
 * 内蔵オフライン LLM の function calling 変換ロジック (ADR-0025 amendment / 2026-07-17)。
 *
 * pi は OpenAI `/v1/chat/completions` プロトコルで tools (function 定義) と、モデルが
 * 呼んだツールの結果 (role:'tool') を会話履歴に載せて再送する。shim はステートレス
 * (各リクエストにフル履歴) なので、ここで:
 *   1. OpenAI function.parameters (JSON Schema) → node-llama-cpp GbnfJsonSchema へ変換
 *   2. OpenAI messages[] → node-llama-cpp chatHistory (system/user/model + functionCall+result)
 * の純粋変換を提供する。エンジン (local-llm-engine.ts) がこれを使って履歴を復元し、
 * promptWithMeta で「実行せず functionCalls で停止」させて OpenAI tool_calls を得る。
 *
 * node-llama-cpp の型 (GbnfJsonSchema / ChatHistoryItem 等) は any を含む面があるため、
 * この層では **中立な自前型** (ToolChatMessage / GbnfSchemaValue) を境界に置き、
 * エンジン層で node-llama-cpp 型へ受け渡す。ここは pure で addon 非依存 (テスト可能)。
 */
import type { LlmChatMessage, LlmChatTool } from '@loamium/shared';
import { messageContentToText } from './local-llm-shim.js';

/**
 * node-llama-cpp の GbnfJsonSchema に構造上対応する中立表現。
 * 変換出力の受け皿。エンジン層で GbnfJsonSchema へ (構造同型なので) 受け渡す。
 */
export type GbnfSchemaValue =
  | {
      type: 'object';
      properties?: Record<string, GbnfSchemaValue>;
      additionalProperties?: boolean;
      description?: string;
    }
  | {
      type: 'array';
      items?: GbnfSchemaValue;
      description?: string;
    }
  | {
      type: 'string' | 'number' | 'integer' | 'boolean' | 'null';
      description?: string;
    }
  | {
      enum: (string | number | boolean | null)[];
      description?: string;
    }
  | {
      // 複数型 (JSON Schema の type:['string','null'] 等) や oneOf を表現。
      oneOf: GbnfSchemaValue[];
      description?: string;
    };

/** 変換後のツール定義 (engine が defineChatSessionFunction へ渡す中立形)。 */
export interface EngineToolDef {
  name: string;
  description?: string;
  params?: GbnfSchemaValue;
}

/** 会話履歴の 1 メッセージ (OpenAI から中立化した engine 入力)。 */
export type ToolChatMessage =
  | { role: 'system'; text: string }
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: EngineToolCall[] }
  | { role: 'tool'; toolCallId: string; text: string };

/** assistant が呼んだツール (arguments は JSON 文字列)。 */
export interface EngineToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

const IMMUTABLE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/**
 * JSON Schema (OpenAI function.parameters) を GbnfSchemaValue へ変換する。
 * 最低限カバー: type (string/number/integer/boolean/null/array/object)、複数 type、
 * enum、properties、items、description、additionalProperties。required は
 * node-llama-cpp 側が properties 全キーを required 扱いするため写さない (契約に従う)。
 * 未対応/未知は object へフォールバック (握りつぶさずガードは呼び出し側の検証で担保)。
 */
export function jsonSchemaToGbnf(schema: unknown): GbnfSchemaValue {
  if (!isRecord(schema)) {
    // スキーマが無い/不正 → 制約なし object (additionalProperties 許可) として扱う。
    return { type: 'object', additionalProperties: true };
  }

  const description = typeof schema.description === 'string' ? schema.description : undefined;

  // enum を最優先 (type と併記されることがあるが enum が最も強い制約)。
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter(isEnumPrimitive);
    return withDesc({ enum: values }, description);
  }

  const rawType = schema.type;

  // 複数 type (例: ['string','null']) → oneOf。
  if (Array.isArray(rawType)) {
    const branches = rawType
      .filter((t): t is string => typeof t === 'string')
      .map((t) => jsonSchemaToGbnf({ ...schema, type: t }));
    if (branches.length === 1) return branches[0]!;
    if (branches.length > 1) return withDesc({ oneOf: branches }, description);
  }

  if (rawType === 'object' || (rawType === undefined && isRecord(schema.properties))) {
    const out: GbnfSchemaValue = { type: 'object' };
    if (isRecord(schema.properties)) {
      const props: Record<string, GbnfSchemaValue> = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        props[key] = jsonSchemaToGbnf(value);
      }
      out.properties = props;
    }
    if (typeof schema.additionalProperties === 'boolean') {
      out.additionalProperties = schema.additionalProperties;
    }
    if (description !== undefined) out.description = description;
    return out;
  }

  if (rawType === 'array') {
    const out: GbnfSchemaValue = { type: 'array' };
    if (schema.items !== undefined) out.items = jsonSchemaToGbnf(schema.items);
    if (description !== undefined) out.description = description;
    return out;
  }

  if (typeof rawType === 'string' && IMMUTABLE_TYPES.has(rawType)) {
    return withDesc(
      { type: rawType as 'string' | 'number' | 'integer' | 'boolean' | 'null' },
      description,
    );
  }

  // 型不明 → 自由 object。
  return { type: 'object', additionalProperties: true };
}

/** OpenAI tools[] を engine 用の中立ツール定義へ変換する。 */
export function toolsToEngineDefs(tools: LlmChatTool[]): EngineToolDef[] {
  return tools.map((t) => {
    const def: EngineToolDef = { name: t.function.name };
    if (t.function.description !== undefined) def.description = t.function.description;
    if (t.function.parameters !== undefined) {
      def.params = jsonSchemaToGbnf(t.function.parameters);
    }
    return def;
  });
}

/**
 * OpenAI messages[] を engine 用の中立会話履歴へ変換する。
 * - system → system、user → user、assistant(text) → assistant、
 *   assistant.tool_calls → assistant.toolCalls、role:'tool' → tool(結果)。
 * content パート配列 / null はテキスト縮約する。
 */
export function messagesToToolChat(messages: LlmChatMessage[]): ToolChatMessage[] {
  const out: ToolChatMessage[] = [];
  for (const m of messages) {
    const text = m.content == null ? '' : messageContentToText(m.content);
    if (m.role === 'system') {
      out.push({ role: 'system', text });
    } else if (m.role === 'user') {
      out.push({ role: 'user', text });
    } else if (m.role === 'assistant') {
      const msg: ToolChatMessage = { role: 'assistant', text };
      if (m.tool_calls && m.tool_calls.length > 0) {
        msg.toolCalls = m.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          argumentsJson: tc.function.arguments,
        }));
      }
      out.push(msg);
    } else {
      // role:'tool'
      out.push({ role: 'tool', toolCallId: m.tool_call_id ?? '', text });
    }
  }
  return out;
}

function withDesc(base: GbnfSchemaValue, description: string | undefined): GbnfSchemaValue {
  if (description === undefined) return base;
  return { ...base, description };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isEnumPrimitive(v: unknown): v is string | number | boolean | null {
  return (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  );
}
