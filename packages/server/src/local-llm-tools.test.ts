/**
 * local-llm-tools.ts の純粋変換ロジックのユニットテスト (ADR-0025 amendment)。
 * JSON Schema → GbnfJsonSchema 変換、OpenAI messages → engine 会話履歴、
 * tools → engine ツール定義。addon 非依存 (pure) で検証する。
 */
import { describe, it, expect } from 'vitest';
import {
  jsonSchemaToGbnf,
  toolsToEngineDefs,
  messagesToToolChat,
} from './local-llm-tools.js';
import type { LlmChatMessage, LlmChatTool } from '@loamium/shared';

describe('jsonSchemaToGbnf', () => {
  it('object + properties + description を写す (required は写さない)', () => {
    const g = jsonSchemaToGbnf({
      type: 'object',
      description: 'search args',
      properties: {
        query: { type: 'string', description: 'search query' },
        limit: { type: 'integer' },
      },
      required: ['query'],
    });
    expect(g).toEqual({
      type: 'object',
      description: 'search args',
      properties: {
        query: { type: 'string', description: 'search query' },
        limit: { type: 'integer' },
      },
    });
    // required は GbnfJsonSchema に載せない (node-llama-cpp が全 key を required 扱い)。
    expect('required' in g).toBe(false);
  });

  it('array + items を再帰変換する', () => {
    expect(jsonSchemaToGbnf({ type: 'array', items: { type: 'string' } })).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('enum を写す (type と併記されても enum を優先)', () => {
    expect(jsonSchemaToGbnf({ type: 'string', enum: ['a', 'b', 3] })).toEqual({
      enum: ['a', 'b', 3],
    });
  });

  it('複数 type (["string","null"]) は oneOf へ展開する', () => {
    expect(jsonSchemaToGbnf({ type: ['string', 'null'] })).toEqual({
      oneOf: [{ type: 'string' }, { type: 'null' }],
    });
  });

  it('スキーマ無し / 不正は自由 object へフォールバック', () => {
    expect(jsonSchemaToGbnf(undefined)).toEqual({ type: 'object', additionalProperties: true });
    expect(jsonSchemaToGbnf({ type: 'weird' })).toEqual({
      type: 'object',
      additionalProperties: true,
    });
  });

  it('additionalProperties(boolean) を写す', () => {
    expect(jsonSchemaToGbnf({ type: 'object', additionalProperties: false })).toEqual({
      type: 'object',
      additionalProperties: false,
    });
  });
});

describe('toolsToEngineDefs', () => {
  it('OpenAI tools[] を name/description/params の中立形へ変換する', () => {
    const tools: LlmChatTool[] = [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'search the web',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      },
    ];
    expect(toolsToEngineDefs(tools)).toEqual([
      {
        name: 'web_search',
        description: 'search the web',
        params: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ]);
  });

  it('parameters 無しなら params を付けない', () => {
    const tools: LlmChatTool[] = [{ type: 'function', function: { name: 'ping' } }];
    expect(toolsToEngineDefs(tools)).toEqual([{ name: 'ping' }]);
  });
});

describe('messagesToToolChat', () => {
  it('system/user/assistant(text) を中立形へ写す', () => {
    const msgs: LlmChatMessage[] = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(messagesToToolChat(msgs)).toEqual([
      { role: 'system', text: 'be brief' },
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ]);
  });

  it('assistant.tool_calls + role:tool 結果を写す (content:null 許容)', () => {
    const msgs: LlmChatMessage[] = [
      { role: 'user', content: 'search loamium' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"q":"loamium"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'RESULT: found 3 pages' },
    ];
    expect(messagesToToolChat(msgs)).toEqual([
      { role: 'user', text: 'search loamium' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'call_1', name: 'web_search', argumentsJson: '{"q":"loamium"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', text: 'RESULT: found 3 pages' },
    ]);
  });

  it('content パート配列を縮約する', () => {
    const msgs: LlmChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    ];
    expect(messagesToToolChat(msgs)).toEqual([{ role: 'user', text: 'ab' }]);
  });
});
