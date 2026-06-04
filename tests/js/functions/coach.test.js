// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { onRequestPost } from '../../../functions/api/coach.js';

function jsonReq(body) {
  return new Request('https://getwhoof.pages.dev/api/coach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ENV = { ANTHROPIC_API_KEY: 'sk-ant-test' };

// Mock the Anthropic Messages API. Captures the outgoing request body so we can
// assert on the prompt structure (cache breakpoint, message ordering).
function mockClaude(reply = 'Recovery is solid.', { ok = true, status = 200 } = {}) {
  const fn = vi.fn(async (_url, opts) => {
    fn.lastBody = JSON.parse(opts.body);
    fn.lastHeaders = opts.headers;
    return {
      ok, status,
      json: async () => (ok
        ? { content: [{ type: 'thinking', text: '' }, { type: 'text', text: reply }] }
        : { error: { message: 'boom' } }),
    };
  });
  return fn;
}

describe('coach onRequestPost (Claude)', () => {
  let realFetch;
  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('503 when ANTHROPIC_API_KEY is missing', async () => {
    const res = await onRequestPost({ request: jsonReq({ message: 'hi' }), env: {} });
    expect(res.status).toBe(503);
  });

  it('400 on an empty message', async () => {
    const res = await onRequestPost({ request: jsonReq({ message: '   ' }), env: ENV });
    expect(res.status).toBe(400);
  });

  it('400 on a non-JSON body', async () => {
    const bad = new Request('https://x/api/coach', { method: 'POST', body: 'not json' });
    const res = await onRequestPost({ request: bad, env: ENV });
    expect(res.status).toBe(400);
  });

  it('returns the reply and puts the WHOOP data in a cached system block', async () => {
    globalThis.fetch = mockClaude('You are recovering well.');
    const res = await onRequestPost({
      request: jsonReq({ message: 'how am I?', context: { days_of_data: 7, daily_metrics: [{ date: '2026-06-03', recovery_score: 72 }] } }),
      env: ENV,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.reply).toBe('You are recovering well.');

    const body = globalThis.fetch.lastBody;
    expect(body.model).toMatch(/^claude-/);
    // system = [instructions, {data, cache_control}]
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system.length).toBe(2);
    expect(body.system[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[1].text).toContain('recovery_score');
    // auth header carries the key
    expect(globalThis.fetch.lastHeaders['x-api-key']).toBe('sk-ant-test');
  });

  it('clamps history and appends the user message last', async () => {
    globalThis.fetch = mockClaude('ok');
    const history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    await onRequestPost({ request: jsonReq({ message: 'q', history }), env: ENV });
    const body = globalThis.fetch.lastBody;
    expect(body.messages.length).toBeLessThanOrEqual(21); // 20 history + 1 user
    expect(body.messages[body.messages.length - 1]).toEqual({ role: 'user', content: 'q' });
  });

  it('413 when the data snapshot is too large', async () => {
    globalThis.fetch = mockClaude('ok');
    const huge = { blob: 'x'.repeat(500_000) };
    const res = await onRequestPost({ request: jsonReq({ message: 'hi', context: huge }), env: ENV });
    expect(res.status).toBe(413);
  });

  it('502 when Claude returns an error status', async () => {
    globalThis.fetch = mockClaude('', { ok: false, status: 500 });
    const res = await onRequestPost({ request: jsonReq({ message: 'hi' }), env: ENV });
    expect(res.status).toBe(502);
  });

  it('502 (auth) surfaces a clear message on 401', async () => {
    globalThis.fetch = mockClaude('', { ok: false, status: 401 });
    const res = await onRequestPost({ request: jsonReq({ message: 'hi' }), env: ENV });
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.message).toMatch(/key/i);
  });
});
