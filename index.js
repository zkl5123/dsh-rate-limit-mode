import z from '@deepseek-ai/schemastery';

export const inject = ['agents', 'sessionProjections'];

/**
 * Runtime schema for {@link Config}.
 *
 * @property {number} [maxPerMinute] - 同一会话族（父会话 + 它启动的所有子/孙会话）内，
 *   每 60 秒滚动窗口允许的模型请求次数（含自动重试）。默认 10。
 * @property {number} [windowMs] - 滚动窗口长度（毫秒）。默认 60000。
 * @property {boolean} [freezeOnDailyLimit] - 检测到提供方每日额度耗尽（429 + 每日上限语义）时，
 *   把整个会话族冻结 1 分钟（1 分钟 1 次节奏），并把该状态同步到会话投影
 *   `llmRateLimit` 的 wire 视图；用户通过内置模型选择器切换模型后，
 *   持久的 `model/selection` 事件会解除该会话族的节奏限制。默认 true。
 */
export const Config = z.object({
  maxPerMinute: z.natural().min(1).default(10),
  windowMs: z.natural().min(1).default(60_000),
  freezeOnDailyLimit: z.boolean().default(true)
});

/** 会话投影 wire 视图：同步到客户端的每日限额状态。
 * 可空字段用 `z.union` 显式放行 `null`（schemastery 没有 `.nullable()`）。 */
export const wireViewSchema = z.object({
  pendingModelSwitch: z.boolean(),
  frozenUntil: z.union([z.number(), z.any()]),
  lastDailyLimit: z.union([
    z.object({
      provider: z.string(),
      message: z.string(),
      at: z.number()
    }),
    z.any()
  ])
});

/** Folded state schema for the `llmRateLimit` projection. Nullable fields are
 * modelled with `z.union([…, z.any()])` because schemastery has no `.nullable()`. */
export const rateLimitStateSchema = z.object({
  lastDailyLimit: z.union([
    z.object({
      provider: z.string(),
      message: z.string(),
      at: z.number()
    }),
    z.any()
  ]),
  lastModelSelectionAt: z.union([z.number(), z.any()]),
  // Remembered so a failure reported without a provider (the finish chunk of
  // `assistant/attempt`, and `turn/end`) still names the provider out of quota.
  lastProvider: z.union([z.string(), z.any()])
});

/**
 * 会话投影：把每日限额冻结状态作为 wire 视图同步给客户端。
 * 投影只能从已提交的会话事件折叠；我们的 live 状态（冻结/等待选择）通过
 * `apply(state, event)` 从 `model/selection` 事件与 live 快照合并重建。
 * 由于投影按 `session/event` 驱动，且宿主进程重启会清空 live 状态，
 * 视图语义为「本宿主代次内是否处于每日限额冻结」。
 */
const projectionKey = 'llmRateLimit';

/** How long the family is paced to one request per minute after a quota 429. */
const DAILY_FREEZE_MS = 60_000;

/** Initial folded state of the `llmRateLimit` projection. */
export function rateLimitInit() {
  return { lastDailyLimit: null, lastModelSelectionAt: null, lastProvider: null };
}

/**
 * Fold one committed session event into the `llmRateLimit` state.
 *
 * Kept pure and at module scope so the notice can be replayed from a stored
 * session log — that replay is how the behaviour is verified without waiting
 * for a provider to run out of quota again.
 *
 * @param state - previous folded state.
 * @param event - committed session event (`{type, time, data}`).
 * @returns the next folded state.
 */
export function foldRateLimit(state, event) {
  if (event.type === 'model/selection') {
    // A durable model selection supersedes an older quota notice: the user
    // picked a live model, so the notice is cleared.
    return { ...state, lastModelSelectionAt: event.time ?? 0 };
  }
  const hit = quotaFailureOf(event, state.lastProvider);
  if (hit) {
    return {
      ...state,
      lastProvider: hit.provider || state.lastProvider,
      lastDailyLimit: { provider: hit.provider, message: hit.message, at: event.time ?? 0 }
    };
  }
  if (event.type === 'llm/retry' && event.data?.provider) {
    return { ...state, lastProvider: event.data.provider };
  }
  return state;
}

/**
 * Project the folded state to the client wire view. Referentially stable: the
 * view recomputes only when the folded state changes and exposes raw facts, so
 * the client compares timestamps itself and no host clock is involved.
 *
 * @param state - folded `llmRateLimit` state.
 */
export function rateLimitView(state) {
  const hit = state.lastDailyLimit;
  const picked = state.lastModelSelectionAt;
  const active =
    hit !== null &&
    hit !== undefined &&
    (picked === null || picked === undefined || hit.at >= picked);
  return {
    pendingModelSwitch: active,
    frozenUntil: active ? hit.at + DAILY_FREEZE_MS : null,
    lastDailyLimit: hit ?? null
  };
}

export function apply(ctx, config = {}) {
  const maxPerMinute = config.maxPerMinute ?? 10;
  const windowMs = config.windowMs ?? 60_000;
  const freezeOnDailyLimit = config.freezeOnDailyLimit ?? true;

  // --- sliding-window limiter: one shared bucket per session family.
  const optedIn = new Set(); // family root session ids
  const buckets = new Map(); // rootSessionId -> { timestamps: number[] }
  const queues = new Map(); // rootSessionId -> Array<(value) => void>
  const timers = new Map(); // rootSessionId -> pending release timer

  // --- daily-limit freeze: when the provider reports the account's quota is
  // spent (a 429 the retry policy cannot clear), hold the family's next model
  // request for a full minute so pacing becomes one-per-minute. The freeze
  // state is mirrored into the `llmRateLimit` session projection wire view
  // so the client UI can surface a notice / model-picker affordance.
  const frozen = new Map(); // rootSessionId -> number (epoch ms freeze end)
  // Root ids that have ever been under a daily-limit freeze this generation.
  // A durable `model/selection` (the user picked a model through the picker)
  // retires the whole family's pacing: the new model is a live provider.
  const everFrozen = new Set(); // rootSessionId
  // Last provider seen per family. `assistant/attempt` and `turn/end` report a
  // quota failure without naming the provider, so it is recalled from here.
  const lastProvider = new Map(); // rootSessionId -> provider

  // --- agent/created: mark family opt-in for the limiter.
  const disposeCreated = ctx.on('agent/created', ({ agent }) => {
    optedIn.add(rootOf(agent));
  });

  function rootOf(agent) {
    // Walk up the live parent chain (each subagent child records its parent's
    // session id in the session header's parentSession field); the top-level
    // session of the family is the bucket owner.
    let current = agent;
    let session = agent.session;
    while (true) {
      const parentId = session?.parentSession;
      if (!parentId) break;
      const parent = ctx.agents.get(parentId);
      if (!parent) break; // parent no longer live: this branch is a family root
      current = parent;
      session = parent.session;
    }
    return current.id;
  }

  function bucketOf(rootId) {
    let b = buckets.get(rootId);
    if (!b) {
      b = { timestamps: [] };
      buckets.set(rootId, b);
    }
    return b;
  }

  function liveCount(bucket) {
    const t = Date.now();
    let count = 0;
    for (const ts of bucket.timestamps) if (t - ts < windowMs) count++;
    return count;
  }

  function nextExpiry(bucket) {
    const t = Date.now();
    let min = Infinity;
    for (const ts of bucket.timestamps) min = Math.min(min, ts);
    if (min === Infinity) return t;
    return Math.max(t, min + windowMs);
  }

  function earliestExpiry(bucket) {
    const t = Date.now();
    for (const ts of bucket.timestamps) if (t - ts >= windowMs) return 0;
    if (bucket.timestamps.length === 0) return 0;
    return nextExpiry(bucket) - t;
  }

  function scheduleRelease(rootId, delayMs) {
    if (timers.get(rootId)) return;
    const timer = setTimeout(() => release(rootId), Math.max(delayMs, 50));
    if (timer.unref) timer.unref();
    timers.set(rootId, timer);
  }

  function release(rootId) {
    timers.delete(rootId);
    const queue = queues.get(rootId);
    const bucket = buckets.get(rootId);
    if (!queue || !bucket) return;
    const expiry = nextExpiry(bucket);
    const surviving = bucket.timestamps.filter((ts) => expiry - ts < windowMs);
    const free = Math.max(0, maxPerMinute - surviving.length);
    bucket.timestamps = surviving;
    const n = Math.min(free, queue.length);
    for (let i = 0; i < n; i++) {
      const resolve = queue.shift();
      bucket.timestamps.push(expiry);
      resolve();
    }
    if (queue.length > 0) {
      scheduleRelease(rootId, Math.max(earliestExpiry(bucket), 50));
    }
  }

  function admit(agent, signal) {
    const rootId = rootOf(agent);
    if (!optedIn.has(rootId)) return Promise.resolve();
    const bucket = bucketOf(rootId);
    if (liveCount(bucket) < maxPerMinute) {
      bucket.timestamps.push(Date.now());
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let queue = queues.get(rootId);
      if (!queue) {
        queue = [];
        queues.set(rootId, queue);
      }
      queue.push(resolve);
      if (queue.length === 1) scheduleRelease(rootId, earliestExpiry(bucket));
    });
  }

  // --- daily-limit freeze state helpers.
  function setFrozen(rootId, provider, message) {
    const until = Date.now() + DAILY_FREEZE_MS;
    frozen.set(rootId, until);
    everFrozen.add(rootId);
    ctx.logger?.info?.(
      '[llm-rate-limit] daily-limit freeze on provider "%s"; family %s waits %dms',
      provider, rootId, DAILY_FREEZE_MS
    );
  }

  function clearFrozen(rootId) {
    frozen.delete(rootId);
  }

  function retirePacing(rootId) {
    const had = frozen.delete(rootId);
    const wasTracked = everFrozen.delete(rootId);
    return had || wasTracked;
  }

  // Resolve the family root for a session handle (the `session/event`
  // listener only receives the session, not the live agent). Walk the live
  // parent chain the same way `rootOf` does; when no live agent owns the
  // session, the session itself is the family root.
  function familyRootOfSession(session) {
    let current = session;
    while (true) {
      const parentId = current?.parentSession;
      if (!parentId) break;
      const parent = ctx.agents.get(parentId);
      if (!parent) break; // no live parent: this branch is the family root
      current = parent.session;
    }
    return current?.id;
  }

  // Wait out an active daily-limit freeze on this family's bucket.
  function holdDailyFreeze(agent, signal) {
    const rootId = rootOf(agent);
    const until = frozen.get(rootId);
    if (until === void 0) return Promise.resolve();
    const waitMs = until - Date.now();
    if (waitMs <= 0) {
      clearFrozen(rootId);
      return Promise.resolve();
    }
    // The user picked a model through the built-in picker: a durable
    // `model/selection` event retires this family's pacing, so release the
    // freeze and let the next request route to the picked model.
    if (!everFrozen.has(rootId)) {
      clearFrozen(rootId);
      return Promise.resolve();
    }
    if (ctx.logger?.debug) {
      ctx.logger.debug('[llm-rate-limit] holding next request %dms for family %s', waitMs, rootId);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        clearFrozen(rootId);
        resolve();
      }, waitMs);
      if (timer.unref) timer.unref();
      signal?.addEventListener?.('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  // --- agent/request: admit each model request (first attempt and every
  // auto-retry re-enter this waterfall, so retries count), and hold the
  // request while the family is under a daily-limit freeze (one-per-minute
  // pacing). Routing a request to a user-picked model is handled by the
  // built-in model-selection machinery; this plugin only paces the
  // follow-up attempts after a daily-quota 429.
  const disposeRequest = ctx.on('agent/request', async ({ agent, signal }, next) => {
    if (signal.aborted) return next();
    await admit(agent, signal).catch(() => {});
    if (signal.aborted) return next(); // cancelled while parked: drop out
    await holdDailyFreeze(agent, signal).catch(() => {});
    if (signal.aborted) return next();
    return next();
  });

  // --- Quota freezes are driven by the COMMITTED `llm/retry` session event,
  // NOT by an `agent/request-error` waterfall seat. `llm-retry` (which the
  // preset mounts ahead of this plugin) owns that waterfall: as soon as it
  // decides to retry it returns `{kind:'retry'}` WITHOUT calling `next()`, so
  // any seat after it never runs. Its appended `llm/retry` event carries
  // exactly `{provider, failure}` — the same facts the projection folds — so
  // deriving the freeze from that event keeps the live pacing and the client
  // notice same-sourced, and independent of waterfall order.
  const disposeSessionEvent = ctx.on('session/event', (session, event) => {
    if (event.type === 'model/selection') {
      // A durable `model/selection` (the user picked a model through the
      // built-in picker) retires this family's pacing. The picked model routes
      // the next request through the built-in model-selection machinery, so the
      // switch is not held behind a minute.
      const rootId = familyRootOfSession(session);
      if (rootId === void 0) return;
      if (retirePacing(rootId)) {
        ctx.logger?.info?.('[llm-rate-limit] family %s pacing retired by model selection', rootId);
      }
      return;
    }
    if (!freezeOnDailyLimit) return;
    const rootId = familyRootOfSession(session);
    if (rootId === void 0) return;
    const hit = quotaFailureOf(event, lastProvider.get(rootId));
    if (hit) {
      lastProvider.set(rootId, hit.provider);
      setFrozen(rootId, hit.provider, hit.message);
      return;
    }
    if (event.type === 'llm/retry' && event.data?.provider) lastProvider.set(rootId, event.data.provider);
  });

  // --- session projection: a PURE durable fold over committed `llm/retry`
  // and `model/selection` events, exposed to the client as a wire view. The
  // client notice renders when the log shows a recent daily-limit 429 with
  // no newer model selection; the user switches models through the existing
  // model picker, whose durable `model/selection` event clears the notice.
  // `frozenUntil` is derived from the last daily-limit retry time plus the
  // 60-second pacing window, matching the live freeze duration.
  if (ctx.sessionProjections?.register) {
    const disposeProjection = ctx.sessionProjections.register({
      key: projectionKey,
      stateSchema: rateLimitStateSchema,
      init: rateLimitInit,
      apply: foldRateLimit,
      wire: {
        viewSchema: wireViewSchema,
        view: (state) => wireViewSchema.parse(rateLimitView(state))
      },
      stateVersion: 1
    });
    ctx.effect(() => {
      disposeProjection();
    }, `llm-rate-limit: drop rate-limit projection`);
  }

  ctx.effect(() => {
    disposeCreated();
    disposeRequest();
    disposeSessionEvent();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const queue of queues.values()) {
      for (const resolve of queue.splice(0, queue.length)) resolve();
    }
    queues.clear();
    buckets.clear();
    optedIn.clear();
    frozen.clear();
    everFrozen.clear();
    lastProvider.clear();
  }, `llm-rate-limit: drop parked rate-limit waiters`);
}

/**
 * Extract the quota failure a committed session event records, or `null`.
 *
 * Three event kinds can carry one, and they are NOT redundant. `llm/retry`
 * covers a failure the retry policy is about to act on and is the only one that
 * names the provider. A failure that EXHAUSTS the retries — or arrives when the
 * policy declines to retry — is recorded only by the finish chunk of
 * `assistant/attempt` and by `turn/end`. A notice folded from `llm/retry` alone
 * would therefore miss exactly the terminal case in which the user must switch
 * models, which is the case observed in practice:
 *
 *   assistant/attempt -> stream[].chunk(Finish).reason.failure
 *   turn/end          -> reason.error   (message "429: … text quota …")
 *   llm/retry         -> failure        (plus the provider)
 *
 * @param event - a committed session event (`{type, time, data}`).
 * @param fallbackProvider - provider to attribute a failure to when the event
 *   does not name one.
 * @returns `{provider, message}`, or `null` when the event records no quota failure.
 */
function quotaFailureOf(event, fallbackProvider) {
  const data = event?.data;
  if (!data) return null;
  const hit = (failure, provider) => {
    const named = provider ?? fallbackProvider ?? '';
    if (!isDailyLimitFailure(named, failure)) return null;
    return { provider: named, message: failure?.message ?? '' };
  };

  if (event.type === 'llm/retry') return hit(data.failure, data.provider);

  if (event.type === 'assistant/attempt') {
    if (!Array.isArray(data.stream)) return null;
    for (const entry of data.stream) {
      const chunk = entry?.chunk;
      if (chunk?.type !== 'finish') continue;
      const found = hit(chunk.reason?.failure, data.provider);
      if (found) return found;
    }
    return null;
  }

  if (event.type === 'turn/end') return hit(data.reason?.error, data.provider);

  return null;
}

/**
 * A provider failure that means "stop hammering this account's quota": the
 * condition the freeze, the one-per-minute pacing and the client's
 * model-switch notice all exist for.
 *
 * The status/code decides, because provider wording is not dependable. A real
 * agnes 429 reports `code: "RATE_LIMIT"` with the text "You've reached the API
 * rate limit for free users. Upgrade to a Token Plan…" — which contains no
 * "daily", "quota" or "today" at all, so a wording-only test silently misses
 * exactly the failure this plugin is built for. Wording is therefore used only
 * as a fallback when the adapter surfaced neither a status nor a code.
 */
function isDailyLimitFailure(provider, failure) {
  if (!failure) return false;
  const status = failure.status;
  const code = String(failure.code ?? '');
  const text = `${provider ?? ''} ${failure.message ?? ''}`.toLowerCase();
  const rateLimited =
    status === 429 ||
    code === 'RATE_LIMIT' ||
    /(^|\D)429(\D|$)/.test(text) ||
    /\brate[-\s_]?limit/.test(text);
  if (rateLimited) return true;
  // A 5xx is a provider fault, not a spent quota: switching models may help,
  // but it is not the condition this notice speaks about.
  if (status !== void 0 && status >= 500) return false;
  // No usable status or code: fall back to explicit quota wording (English and
  // Chinese daily-cap phrasings).
  const en =
    /daily[-_ ]?limit/.test(text) ||
    /daily[-_ ]?(quota|allowance|usage)/.test(text) ||
    /used (all|the|your|up) (daily|today)/.test(text) ||
    /used up (all|the|your|today|daily)/.test(text) ||
    /used up today'?s/.test(text) ||
    /(daily|today)'?s (limit|quota|usage|text quota)/.test(text) ||
    /limit (reached|exceeded) (for )?(today|daily)/.test(text) ||
    /(quota|limit) (exceeded|reached) (today|daily)/.test(text) ||
    /exceeds (the )?daily/.test(text) ||
    /quota.{0,30}(exceeded|reached|limit|used up)/.test(text) ||
    /daily.{0,30}(limit|exceeded|quota|reached)/.test(text);
  const zh = /今日上限|每日上限|今日限额|每日限额|今日配额|每日配额|今日额度|每日额度|已?使用完(今|每)?日|今.{0,3}额度已满|每日限额已满|今日限额已满|超过.{0,6}(每日|今日)(限额|上限|配额)|已达.{0,4}(每日|今日)(上限|限额|配额)/.test(text);
  return en || zh;
}
