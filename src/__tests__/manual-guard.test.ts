import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigSchema } from '../config/schema.js';

/** Mirrors the narrowing applied to manual sends in runAndDeliver. */
function applyGuard(config: ReturnType<typeof ConfigSchema.parse>, trigger: 'scheduled' | 'manual') {
  if (trigger !== 'manual' || !config.manualSendOnlyTo) return config.recipients.filter((r) => r.enabled).map((r) => r.id);
  return config.recipients.filter((r) => r.enabled && r.id === config.manualSendOnlyTo).map((r) => r.id);
}

const five = ['alice', 'bob', 'carol-diaz', 'dan-ito', 'eve-novak'];
const config = ConfigSchema.parse({
  manualSendOnlyTo: 'alice',
  recipients: five.map((id) => ({ id, label: id, teamworkUserId: 1, handles: ['X'], enabled: true })),
});

test('a manual send reaches only the nominated person', () => {
  assert.deepEqual(applyGuard(config, 'manual'), ['alice']);
});

test('scheduled runs are untouched — the real reminder still goes to everyone', () => {
  assert.deepEqual(applyGuard(config, 'scheduled'), five);
});

test('with the guard off, manual sends behave normally', () => {
  const open = ConfigSchema.parse({ ...config, manualSendOnlyTo: '' });
  assert.deepEqual(applyGuard(open, 'manual'), five);
});

test('the guard wins even when another recipient was explicitly requested', () => {
  // The route narrows recipients to the requested id first; the guard then overrides.
  const requested = ConfigSchema.parse({
    ...config,
    recipients: five.map((id) => ({ id, label: id, teamworkUserId: 1, handles: ['X'], enabled: id === 'dan-ito' })),
  });
  assert.deepEqual(applyGuard(requested, 'manual'), []);
});
