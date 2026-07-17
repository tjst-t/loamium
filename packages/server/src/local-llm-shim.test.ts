/**
 * local-llm-shim.ts の純粋変換ロジックのユニットテスト (S8a3f2e-2)。
 * OpenAI messages → prompt 縮約、chat.completion / chunk 組み立て、エラー形。
 */
import { describe, it, expect } from 'vitest';
import {
  messagesToPrompt,
  messageContentToText,
  completionOptionsFromRequest,
  chatOptionsFromRequest,
  buildChatCompletion,
  buildToolCallsCompletion,
  buildChatChunk,
  buildFinalChunk,
  buildErrorBody,
  approxTokens,
} from './local-llm-shim.js';
import type { LlmChatRequest } from '@loamium/shared';

describe('messagesToPrompt', () => {
  it('role ラベル付きで連結する', () => {
    const p = messagesToPrompt([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'more' },
    ]);
    expect(p).toBe('System: be brief\n\nUser: hello\n\nAssistant: hi\n\nUser: more');
  });
});

describe('messageContentToText / content パート配列 (OpenAI 互換)', () => {
  it('文字列 content はそのまま', () => {
    expect(messageContentToText('hello')).toBe('hello');
  });
  it('content パート配列は text を連結 (非テキストは無視)', () => {
    expect(
      messageContentToText([
        { type: 'text', text: 'a' },
        { type: 'image_url', text: undefined },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab');
  });
  it('messagesToPrompt は配列 content も縮約する (pi の送信形)', () => {
    const p = messagesToPrompt([
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'ping' }] },
    ]);
    expect(p).toBe('System: sys\n\nUser: ping');
  });
});

describe('completionOptionsFromRequest', () => {
  it('max_tokens / temperature を写す (未指定は渡さない)', () => {
    const base: LlmChatRequest = { model: 'm', messages: [{ role: 'user', content: 'x' }] };
    expect(completionOptionsFromRequest(base)).toEqual({});
    expect(
      completionOptionsFromRequest({ ...base, max_tokens: 10, temperature: 0.5 }),
    ).toEqual({ maxTokens: 10, temperature: 0.5 });
  });
});

describe('chatOptionsFromRequest (function calling)', () => {
  const base: LlmChatRequest = { model: 'm', messages: [{ role: 'user', content: 'x' }] };

  it('tools を中立ツール定義へ変換して載せる', () => {
    const opts = chatOptionsFromRequest({
      ...base,
      max_tokens: 5,
      tools: [
        {
          type: 'function',
          function: {
            name: 'web_search',
            description: 'search',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
          },
        },
      ],
    });
    expect(opts.maxTokens).toBe(5);
    expect(opts.tools).toEqual([
      {
        name: 'web_search',
        description: 'search',
        params: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ]);
  });

  it('tool_choice=none なら tools を渡さない (テキスト専用)', () => {
    const opts = chatOptionsFromRequest({
      ...base,
      tool_choice: 'none',
      tools: [{ type: 'function', function: { name: 'f' } }],
    });
    expect(opts.tools).toBeUndefined();
  });

  it('tools 未指定なら tools を渡さない', () => {
    expect(chatOptionsFromRequest(base).tools).toBeUndefined();
  });
});

describe('buildToolCallsCompletion', () => {
  it('tool_calls 応答 (content:null, finish_reason:tool_calls) を組み立てる', () => {
    const r = buildToolCallsCompletion('m', 'a b', [
      { id: 'call_0', name: 'web_search', argumentsJson: '{"q":"x"}' },
    ]);
    expect(r.object).toBe('chat.completion');
    expect(r.choices[0]?.finish_reason).toBe('tool_calls');
    expect(r.choices[0]?.message.content).toBeNull();
    expect(r.choices[0]?.message.tool_calls).toEqual([
      { id: 'call_0', type: 'function', function: { name: 'web_search', arguments: '{"q":"x"}' } },
    ]);
  });
});

describe('buildChatCompletion', () => {
  it('OpenAI chat.completion 形を組み立てる', () => {
    const r = buildChatCompletion('m', 'a b c', 'x y');
    expect(r.object).toBe('chat.completion');
    expect(r.model).toBe('m');
    expect(r.choices[0]?.message).toEqual({ role: 'assistant', content: 'x y' });
    expect(r.choices[0]?.finish_reason).toBe('stop');
    expect(r.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    expect(r.id).toMatch(/^chatcmpl-local-/);
  });
});

describe('buildChatChunk / buildFinalChunk', () => {
  it('delta チャンクと終端チャンクを組み立てる', () => {
    const chunk = buildChatChunk('id1', 'm', 'hi');
    expect(chunk.object).toBe('chat.completion.chunk');
    expect(chunk.choices[0]?.delta.content).toBe('hi');
    expect(chunk.choices[0]?.finish_reason).toBeNull();

    const fin = buildFinalChunk('id1', 'm');
    expect(fin.choices[0]?.delta).toEqual({});
    expect(fin.choices[0]?.finish_reason).toBe('stop');
  });
});

describe('buildErrorBody / approxTokens', () => {
  it('OpenAI エラー形 {error:{message,type}}', () => {
    expect(buildErrorBody('boom', 'x')).toEqual({ error: { message: 'boom', type: 'x' } });
  });
  it('approxTokens は語数概算 (空は 0)', () => {
    expect(approxTokens('')).toBe(0);
    expect(approxTokens('  ')).toBe(0);
    expect(approxTokens('one two three')).toBe(3);
  });
});
