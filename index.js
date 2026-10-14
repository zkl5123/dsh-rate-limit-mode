import z from '@deepseek-ai/schemastery';

const name = 'llm-rate-limit';

export const inject = ['agents'];

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

/** 会话投影 wire 视图：同步到客户端的每日限额状态。 */
const wireViewSchema = z.object({
  pendingModelSwitch: z.boolean(),
  frozenUntil: z.number().nullable(),
  lastDailyLimit: z.object({
    provider: z.string(),
    message: z.string(),
    at: z.number()
  }).nullable()
});

/**
 * 会话投影：把每日限额冻结状态作为 wire 视图同步给客户端。
 * 投影只能从已提交的会话事件折叠；我们的 live 状态（冻结/等待选择）通过
 * `apply(state, event)` 从 `model/selection` 事件与 live 快照合并重建。
 * 由于投影按 `session/event` 驱动，且宿主进程重启会清空 live 状态，
 * 视图语义为「本宿主代次内是否处于每日限额冻结」。
 */
const projectionKey = 'llmRateLimit';

export function apply(ctx, config = {}) {
  const maxPerMinute = config.maxPerMinute ?? 10;
  const windowMs = config.windowMs ?? 60_000;
  const freezeOnDailyLimit = config.freezeOnDailyLimit ?? true;

  // --- sliding-window limiter: one shared bucket per session family.
  const optedIn = new Set(); // family root session ids
  const buckets = new Map(); // rootSessionId -> { timestamps: number[] }
  const queues = new Map(); // rootSessionId -> Array<(value) => void>
  const timers = new Map(); // rootSessionId -> pending release timer

  // --- daily-limit freeze: when the provider reports the account's DAILY
  // quota is spent (429 + daily-limit wording), hold the family's next model
  // request for a full minute so pacing becomes one-per-minute. The freeze
  // state is mirrored into the `llmRateLimit` session projection wire view
  // so the client UI can surface a notice / model-picker affordance.
  const DAILY_FREEZE_MS = 60_000;
  const frozen = new Map(); // rootSessionId -> number (epoch ms freeze end)
  // Root ids that have ever been under a daily-limit freeze this generation.
  // A durable `model/selection` (the user picked a model through the picker)
  // retires the whole family's pacing: the new model is a live provider.
  const everFrozen = new Set(); // rootSessionId

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

  // --- agent/request-error: recognise a daily-limit failure. Because the
  // preset mounts llm-retry ahead of this plugin, llm-retry's auto-retry
  // already governs ordinary 429s; for a DAILY-quota 429 we additionally
  // freeze the family for a full minute (one-per-minute pacing) and mirror
  // the state into the `llmRateLimit` projection so the client can surface
  // a notice / model-picker. We always return `{kind:'retry'}` so the step
  // stays alive (never kill the turn with a non-retry action) — the pacing
  // freeze in `agent/request` then spaces the follow-up attempts.
  const disposeRequestError = ctx.on('agent/request-error', async ({ agent, provider, failure, signal }, next) => {
    if (freezeOnDailyLimit && isDailyLimitFailure(provider, failure)) {
      const rootId = rootOf(agent);
      setFrozen(rootId, provider, failure.message);
      // Keep the step alive; the pacing freeze paces the follow-up attempt.
      return { kind: 'retry' };
    }
    // Ordinary failure: keep the standard llm-retry behaviour.
    return next();
  });

  // --- session/event: a durable `model/selection` (the user picked a model
  // through the built-in picker) retires this family's pacing. The picked
  // model routes the next request through the built-in model-selection
  // machinery, so the switch is not held behind a minute.
  const disposeSessionEvent = ctx.on('session/event', (session, event) => {
    if (event.type !== 'model/selection') return;
    const rootId = familyRootOfSession(session);
    if (rootId === void 0) return;
    if (retirePacing(rootId)) {
      ctx.logger?.info?.('[llm-rate-limit] family %s pacing retired by model selection', rootId);
    }
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
      stateSchema: z.object({
        lastDailyLimit: z.object({
          provider: z.string(),
          message: z.string(),
          at: z.number()
        }).nullable(),
        lastModelSelectionAt: z.number().nullable()
      }).strict(),
      init: () => ({
        lastDailyLimit: null,
        lastModelSelectionAt: null
      }),
      apply: (state, event) => {
        if (event.type === 'llm/retry') {
          const failure = event.data?.failure;
          if (failure && isDailyLimitFailure(event.data?.provider, failure)) {
            return {
              ...state,
              lastDailyLimit: {
                provider: event.data?.provider ?? '',
                message: failure.message ?? '',
                at: event.time ?? 0
              }
            };
          }
          return state;
        }
        if (event.type === 'model/selection') {
          // A durable model selection supersedes an older daily-limit notice:
          // the user picked a live model, so the notice is cleared.
          return { ...state, lastModelSelectionAt: event.time ?? 0 };
        }
        return state;
      },
      wire: {
        viewSchema: wireViewSchema,
        // Referentially stable: the view recomputes only when the folded
        // state changes, and exposes the raw facts. The client decides
        // freshness (hit older than the last model selection, or outside the
        // pacing window) without a host-side Date.now().
        view: (state) => {
          const hit = state.lastDailyLimit;
          const picked = state.lastModelSelectionAt;
          const active = hit !== null && (picked === null || hit.at >= picked);
          return wireViewSchema.parse({
            pendingModelSwitch: active,
            frozenUntil: active ? hit.at + DAILY_FREEZE_MS : null,
            lastDailyLimit: hit
          });
        }
      },
      stateVersion: 1
    });
    ctx.effect(() => {
      disposeProjection();
    }, `${name}: drop rate-limit projection`);
  }

  ctx.effect(() => {
    disposeCreated();
    disposeRequest();
    disposeRequestError();
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
  }, `${name}: drop parked rate-limit waiters`);
}

/**
 * A provider failure that reads as "the account has used up its DAILY quota"
 * (the 429 + daily-limit-keyword combination the user asked for): we stop
 * hammering that provider and let the family's 1-per-minute freeze do the
 * pacing instead of the provider's backoff.
 */
function isDailyLimitFailure(provider, failure) {
  if (!failure) return false;
  // Accept a daily-limit 429 even when the provider does not expose an HTTP
  // status on the failure object (several adapters report only a message and
  // the RATE_LIMIT code). Require either status 429, or the RATE_LIMIT code,
  // before the keyword match decides.
  const status = failure.status;
  const code = String(failure.code ?? '');
  const rateLimited = status === 429 || (status !== void 0 && status >= 500) || code === 'RATE_LIMIT';
  if (!rateLimited) return false;
  const text = `${provider ?? ''} ${failure.message ?? ''}`.toLowerCase();
  // English daily-quota phrasings.
  const en =
    /daily[-_ ]?limit/.test(text) ||
    /daily[-_ ]?(quota|allowance|usage)/.test(text) ||
    /used (all|the|your|up) (daily|today)/.test(text) ||
    /used up (all|the|your|today|daily)/.test(text) ||
    /used up today'?s/.test(text) ||
    /used up today'?s (text )?quota/.test(text) ||
    /(daily|today)'?s (limit|quota|usage|text quota)/.test(text) ||
    /limit (reached|exceeded) (for )?(today|daily)/.test(text) ||
    /(quota|limit) (exceeded|reached) (today|daily)/.test(text) ||
    /exceeds (the )?daily/.test(text) ||
    /limited to 1 request every minute/.test(text) ||
    /quota.{0,30}(exceeded|reached|limit|used up)/.test(text) ||
    /daily.{0,30}(limit|exceeded|quota|reached)/.test(text) ||
    /used up .{0,20}(quota|limit)/.test(text);
  // Chinese daily-quota phrasings.
  const zh = /今日上限|每日上限|今日限额|每日限额|今日配额|每日配额|今日额度|每日额度|已?使用完(今|每)?日|今.{0,3}额度已满|每日限额已满|今日限额已满|超过.{0,6}(每日|今日)(限额|上限|配额)|已达.{0,4}(每日|今日)(上限|限额|配额)/.test(text);
  return en || zh;
}
