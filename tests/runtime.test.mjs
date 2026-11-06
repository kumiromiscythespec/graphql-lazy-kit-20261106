import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../dist/runtime.js';

const operation = { query: 'query User($id: ID!) { user(id: $id) { id } }', variables: { id: 'u1' } };

test('client sends variables, custom headers and the abort signal to an injected fetch', async () => {
  const controller = new AbortController();
  let observed;
  const client = createClient({
    url: 'https://example.invalid/graphql',
    headers: { authorization: 'Bearer test-token', 'x-project': 'test' },
    fetch: async (url, init) => {
      observed = { url, init };
      return new Response(JSON.stringify({ data: { user: { id: 'u1' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.deepEqual(await client.execute(operation, { signal: controller.signal }), { user: { id: 'u1' } });
  assert.equal(observed.url, 'https://example.invalid/graphql');
  assert.equal(observed.init.method, 'POST');
  assert.equal(observed.init.signal, controller.signal);
  assert.deepEqual(JSON.parse(observed.init.body), { query: operation.query, variables: operation.variables });
  const headers = new Headers(observed.init.headers);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('authorization'), 'Bearer test-token');
  assert.equal(headers.get('x-project'), 'test');
});

test('GraphQL errors are rejected even when HTTP succeeds and partial data exists', async () => {
  const client = createClient({ url: 'https://example.invalid/graphql', fetch: async () => new Response(JSON.stringify({ data: { user: null }, errors: [{ message: 'Not authorized', path: ['user'] }] }), { status: 200 }) });
  await assert.rejects(client.execute(operation), error => {
    assert.match(error.message, /Not authorized|GraphQL/i);
    assert.deepEqual(error.errors, [{ message: 'Not authorized', path: ['user'] }]);
    assert.deepEqual(error.data ?? error.partialData, { user: null });
    return true;
  });
});

test('HTTP failures are rejected with their status', async () => {
  const client = createClient({ url: 'https://example.invalid/graphql', fetch: async () => new Response('Service unavailable', { status: 503 }) });
  await assert.rejects(client.execute(operation), error => {
    assert.equal(error.status, 503);
    assert.match(error.message, /503|HTTP|Service unavailable/i);
    return true;
  });
});

test('a successful HTTP response containing HTML is rejected as invalid GraphQL JSON', async () => {
  const client = createClient({ url: 'https://example.invalid/graphql', fetch: async () => new Response('<html>upstream proxy</html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(client.execute(operation), /JSON|GraphQL|Unexpected token/i);
});

test('network rejection propagates without losing the original failure', async () => {
  const failure = new TypeError('connection closed');
  const client = createClient({ url: 'https://example.invalid/graphql', fetch: async () => { throw failure; } });
  await assert.rejects(client.execute(operation), error => error === failure || error.cause === failure);
});
