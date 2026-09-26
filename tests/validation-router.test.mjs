import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGateDeterministically } from '../dist/quality/validation.js';

test('Jest assertion containing application sandbox identifiers is code', () => {
  const result = classifyGateDeterministically({
    name: 'test',
    command: 'pnpm run test',
    ok: false,
    exitCode: 1,
    stdout: '> jest\nELIFECYCLE Test failed. SandboxBillingProviderService',
    stderr: [
      '● J-02 — Webhook Stripe handler',
      'expect(received).toEqual(expected)',
      'Expected: { error: "Webhook processing failed" }',
      'Received: {}',
      'at tests/integration/Webhook.J02.test.ts:241:22',
      'Test Suites: 5 failed, 42 passed',
      'Tests: 17 failed, 308 passed',
    ].join('\n'),
  });
  assert.equal(result?.kind, 'code');
  assert.equal(result?.confidence, 1);
});

test('specific port-binding failure is environment', () => {
  const result = classifyGateDeterministically({
    name: 'test', command: 'pnpm run test', ok: false, exitCode: 1,
    stdout: '', stderr: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:3000',
  });
  assert.equal(result?.kind, 'environment');
});

test('conflicting strong code and environment evidence defers deterministic classification', () => {
  const result = classifyGateDeterministically({
    name: 'test', command: 'pnpm run test', ok: false, exitCode: 1,
    stdout: '', stderr: 'expect(received).toBe(expected)\nExpected: 1\nReceived: 2\nError: listen EADDRINUSE',
  });
  assert.equal(result, null);
});
