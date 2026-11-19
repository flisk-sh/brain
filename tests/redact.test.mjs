import assert from 'node:assert/strict';
import test from 'node:test';
import { redact, tidyPaths } from '../lib/redact.mjs';

test('redacts AWS access keys', () => {
  assert.equal(redact('key AKIA1234567890ABCDEF here'), 'key [aws-key] here');
});

test('redacts GitHub tokens', () => {
  assert.equal(redact(`token ghp_${'a'.repeat(40)} here`), 'token [github-token] here');
});

test('redacts Anthropic keys', () => {
  assert.equal(redact(`key sk-ant-${'a'.repeat(25)} here`), 'key [anthropic-key] here');
});

test('redacts Stripe live and test keys', () => {
  assert.equal(redact(`sk_live_${'a'.repeat(20)}`), '[stripe-key]');
  assert.equal(redact(`sk_test_${'a'.repeat(20)}`), '[stripe-key]');
});

test('redacts generic API keys', () => {
  assert.equal(redact(`sk-${'a'.repeat(40)}`), '[api-key]');
});

test('redacts a private key block', () => {
  const input = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
  assert.equal(redact(input), '[private-key]');
});

test('unwraps a markdown link', () => {
  assert.equal(redact('[docs](https://example.com/a)'), 'docs');
});

test('redacts a bare link', () => {
  assert.equal(redact('see https://x.com/a?t=1 now'), 'see [link] now');
});

test('redacts email addresses', () => {
  assert.equal(redact('mail a@b.io'), 'mail [email]');
});

test('redacts home paths', () => {
  assert.equal(redact('/Users/bob/p'), '~/p');
  assert.equal(redact('/home/bob/p'), '~/p');
});

test('redacts bearer tokens but keeps the scheme', () => {
  assert.equal(redact(`Bearer ${'a'.repeat(30)}`), 'Bearer [token]');
});

test('leaves non-strings unchanged', () => {
  for (const value of [null, undefined, 42, true]) assert.equal(redact(value), value);
  const object = { secret: 'value' };
  assert.equal(redact(object), object);
});

test('leaves text without secrets unchanged', () => {
  assert.equal(redact('plain text with no secrets'), 'plain text with no secrets');
});

test('tidyPaths makes a path inside cwd relative', () => {
  assert.equal(tidyPaths('/home/project/src/a', '/home/project'), 'src/a');
});

test('tidyPaths shortens a path outside cwd', () => {
  assert.equal(tidyPaths('/opt/other/x/y', '/home/project'), '.../y');
});

test('tidyPaths shortens an absolute path when no cwd is given', () => {
  assert.equal(tidyPaths('/opt/other/x/y'), '.../y');
});
