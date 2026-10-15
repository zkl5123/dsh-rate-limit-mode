import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apply,
  rateLimitInit,
  foldRateLimit,
  rateLimitView,
  rateLimitStateSchema,
  wireViewSchema
} from './index.js';

/**
 * Minimal stand-in for the Host context, mirroring the one cordis behaviour
 * these lifecycle tests exist to pin down: `ctx.effect(execute)` runs `execute`
 * IMMEDIATELY and collects the function it RETURNS as the disposer. Calling a
 * disposer inside that callback therefore unregisters everything during apply,
 * which is exactly the bug that made the projection absent and the limiter inert.
 */
function createFakeCtx() {
  const state = { registrations: [], listeners: [], effects: [] };
  const ctx = {
    logger: { info() {}, debug() {} },
    agents: { get: () => undefined },
    get: () => undefined,
    on(event, handler) {
      const entry = { event, handler, live: true };
      state.listeners.push(entry);
      return () => {
        entry.live = false;
      };
    },
    effect(execute, label) {
      const disposer = execute();
      state.effects.push({ label, disposer });
      return disposer;
    },
    sessionProjections: {
      register(definition) {
        const registration = { key: definition.key, definition, live: true };
        state.registrations.push(registration);
        return () => {
          registration.live = false;
        };
      }
    }
  };
  return { ctx, state };
}

// The two wordings the `agnes` provider actually returns for a spent free quota.
// Neither contains "daily", which is why the first implementation — matching
// only daily/quota wording — silently missed every one of them.
const AGNES_RATE_LIMIT = {
  message:
    '429: {"code":"","message":"You\u2019ve reached the API rate limit for free users. Upgrade to a Token Plan to unlock higher limits and continue using the API without interruption. (request id: 20261015040934854696726nbCARLMc)","type":"AgnesAI_error"}',
  code: 'RATE_LIMIT'
};
const AGNES_DAILY_QUOTA = {
  message:
    '429: {"message":"You have used up today\'s text quota and are now limited to 1 request every minute. Try again after 06:15:04. (request id: 20261015061439633037020megmqc4q)","type":"AgnesAI_error","param":"","code":"rate_limit_exceeded"}',
  code: 'RATE_LIMIT'
};

const retryEvent = (failure, provider, time) => ({
  type: 'llm/retry',
  seq: 1,
  time,
  data: { retryId: 'r1', turn: 1, step: 1, provider, mode: 'normal', retry: 1, maxRetries: 5, delayMs: 500, failure }
});
const attemptEvent = (failure, time) => ({
  type: 'assistant/attempt',
  seq: 2,
  time,
  data: { turn: 1, step: 1, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure } } }] }
});
const turnEndEvent = (error, time) => ({
  type: 'turn/end',
  seq: 3,
  time,
  data: { turn: 1, reason: { kind: 'error', error } }
});
const selectionEvent = (time) => ({
  type: 'model/selection',
  seq: 4,
  time,
  data: { provider: 'aisi', model: 'agnes-3.0-flash' }
});
const completedTurnEnd = (time) => ({
  type: 'turn/end',
  seq: 5,
  time,
  data: { turn: 1, reason: { kind: 'completed' } }
});

test('an agnes free-tier 429 opens the model-switch banner', () => {
  const state = foldRateLimit(rateLimitInit(), retryEvent(AGNES_RATE_LIMIT, 'agnes', 1000));
  const view = rateLimitView(state);
  assert.equal(view.pendingModelSwitch, true);
  assert.equal(view.lastDailyLimit.provider, 'agnes');
  assert.equal(view.frozenUntil, 1000 + 60_000);
});

test('a terminal failure recorded only by assistant/attempt still opens the banner', () => {
  // No `llm/retry` event: the retries were exhausted, so the finish chunk is
  // the only record. Folding `llm/retry` alone would leave the user with a
  // dead turn and no way to switch models.
  const state = foldRateLimit(rateLimitInit(), attemptEvent(AGNES_RATE_LIMIT, 1000));
  assert.equal(rateLimitView(state).pendingModelSwitch, true);
});

test('a terminal turn/end daily-quota failure opens the banner', () => {
  const state = foldRateLimit(rateLimitInit(), turnEndEvent(AGNES_DAILY_QUOTA, 1000));
  assert.equal(rateLimitView(state).pendingModelSwitch, true);
});

test('the provider is recalled when an event does not name one', () => {
  let state = rateLimitInit();
  state = foldRateLimit(state, retryEvent(AGNES_RATE_LIMIT, 'agnes', 1000));
  state = foldRateLimit(state, turnEndEvent(AGNES_DAILY_QUOTA, 2000));
  const view = rateLimitView(state);
  assert.equal(view.pendingModelSwitch, true);
  assert.equal(view.lastDailyLimit.provider, 'agnes', 'assistant/attempt and turn/end carry no provider');
  assert.match(view.lastDailyLimit.message, /text quota/);
});

test('the latest failure wins so the freshest wording is shown', () => {
  let state = rateLimitInit();
  state = foldRateLimit(state, retryEvent(AGNES_RATE_LIMIT, 'agnes', 1000));
  state = foldRateLimit(state, turnEndEvent(AGNES_DAILY_QUOTA, 2000));
  assert.equal(rateLimitView(state).lastDailyLimit.at, 2000);
});

test('picking a model retires the banner (unfreeze)', () => {
  let state = rateLimitInit();
  state = foldRateLimit(state, retryEvent(AGNES_RATE_LIMIT, 'agnes', 1000));
  assert.equal(rateLimitView(state).pendingModelSwitch, true);
  state = foldRateLimit(state, selectionEvent(2000));
  const view = rateLimitView(state);
  assert.equal(view.pendingModelSwitch, false);
  assert.equal(view.frozenUntil, null);
});

test('a quota failure after a model switch re-opens the banner', () => {
  let state = rateLimitInit();
  state = foldRateLimit(state, retryEvent(AGNES_RATE_LIMIT, 'agnes', 1000));
  state = foldRateLimit(state, selectionEvent(2000));
  assert.equal(rateLimitView(state).pendingModelSwitch, false);
  state = foldRateLimit(state, retryEvent(AGNES_RATE_LIMIT, 'agnes', 3000));
  assert.equal(rateLimitView(state).pendingModelSwitch, true);
});

test('a 5xx server fault does not open the banner', () => {
  const state = foldRateLimit(
    rateLimitInit(),
    retryEvent({ status: 500, message: '请求上游失败，请稍后重试' }, 'agnes', 1000)
  );
  assert.equal(rateLimitView(state).pendingModelSwitch, false);
});

test('ordinary progress events leave the banner untouched', () => {
  let state = rateLimitInit();
  state = foldRateLimit(state, completedTurnEnd(1000));
  state = foldRateLimit(state, { type: 'step/end', seq: 6, time: 1100, data: { turn: 1, step: 1 } });
  assert.equal(rateLimitView(state).pendingModelSwitch, false);
  assert.equal(state.lastDailyLimit, null);
});

test('the banner persists indefinitely until the user acts', () => {
  // The client used to hide the notice after 60s, so a user returning to the
  // tab later saw nothing while the quota was still spent.
  const state = foldRateLimit(rateLimitInit(), retryEvent(AGNES_RATE_LIMIT, 'agnes', 1000));
  assert.equal(rateLimitView(state).pendingModelSwitch, true);
});

test('every folded state and wire view satisfies its schema', () => {
  const events = [
    retryEvent(AGNES_RATE_LIMIT, 'agnes', 1000),
    attemptEvent(AGNES_RATE_LIMIT, 1100),
    turnEndEvent(AGNES_DAILY_QUOTA, 1200),
    completedTurnEnd(1300),
    selectionEvent(1400)
  ];
  let state = rateLimitInit();
  rateLimitStateSchema.parse(state);
  wireViewSchema.parse(rateLimitView(state));
  for (const event of events) {
    state = foldRateLimit(state, event);
    rateLimitStateSchema.parse(state);
    wireViewSchema.parse(rateLimitView(state));
  }
  assert.equal(rateLimitView(state).pendingModelSwitch, false);
});

test('apply keeps the projection registered and the listeners attached', () => {
  const { ctx, state } = createFakeCtx();
  apply(ctx, {});

  assert.equal(state.registrations.length, 1, 'exactly one projection unit registers');
  assert.equal(state.registrations[0].key, 'llmRateLimit');
  assert.equal(
    state.registrations[0].live,
    true,
    'the projection must NOT be disposed during apply: ctx.effect collects the returned disposer'
  );

  const events = state.listeners.map((listener) => listener.event);
  for (const expected of ['agent/created', 'agent/request', 'session/event']) {
    assert.ok(events.includes(expected), `expected an ${expected} listener`);
  }
  for (const listener of state.listeners) {
    assert.equal(listener.live, true, `${listener.event} must stay attached after apply`);
  }

  // Both cleanups were registered as effects, and each returned a callable.
  assert.equal(state.effects.length, 2);
  for (const effect of state.effects) {
    assert.equal(typeof effect.disposer, 'function', `effect ${effect.label} must return a disposer`);
  }
});

test('unloading the plugin detaches the projection and every listener', () => {
  const { ctx, state } = createFakeCtx();
  apply(ctx, {});

  for (const effect of state.effects) effect.disposer();

  assert.equal(state.registrations[0].live, false, 'unload removes the projection key');
  for (const listener of state.listeners) {
    assert.equal(listener.live, false, `unload detaches ${listener.event}`);
  }
});

test('the limiter admits within the window and parks beyond it', async () => {
  const { ctx, state } = createFakeCtx();
  apply(ctx, { maxPerMinute: 2 });

  // Mark the family as opted in, exactly as the `agent/created` listener does.
  const agent = { id: 'session-root', session: { id: 'session-root', parentSession: undefined } };
  state.listeners.find((listener) => listener.event === 'agent/created').handler({ agent });

  const request = state.listeners.find((listener) => listener.event === 'agent/request');
  const signal = new AbortController().signal;
  const next = async () => {};

  await request.handler({ agent, signal }, next);
  await request.handler({ agent, signal }, next);

  let settled = false;
  const parked = request.handler({ agent, signal }, next).then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false, 'the third request inside the window must wait');

  // Unloading must release parked waiters rather than hang them.
  for (const effect of state.effects) effect.disposer();
  await parked;
  assert.equal(settled, true);
});

test('registered wire callback projects replayed history after restart', () => {
  const { ctx, state } = createFakeCtx();
  apply(ctx, {});
  const projection = state.registrations[0].definition;
  let folded = projection.init();
  assert.deepEqual(projection.wire.view(folded), rateLimitView(folded));
  for (const event of [
    retryEvent(AGNES_DAILY_QUOTA, 'agnes', 1000),
    selectionEvent(2000)
  ]) {
    folded = projection.apply(folded, event);
    assert.deepEqual(projection.wire.view(folded), rateLimitView(folded));
    projection.wire.viewSchema.parse(projection.wire.view(folded));
  }
  assert.equal(projection.wire.view(folded).pendingModelSwitch, false);
});