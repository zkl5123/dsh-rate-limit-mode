window.__ModuleLoader__.load({
  id: '@local/dsh-rate-limit-mode',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var react = require('react');
    var h = react.createElement;

    /**
     * Client half of the rate-limit-mode plugin.
     *
     * Registers a full-width quota-notice banner in the session-scoped
     * `conversation.input.dock` slot (the allocated space above the composer
     * card). The banner subscribes to the active session's `llmRateLimit`
     * projection face (the host folds `llm/retry` daily-quota 429s and
     * `model/selection` events into a referentially-stable wire view); when
     * the view reports an active daily-limit hit (a recent 429 with no newer
     * model selection) a banner with the provider message is rendered
     * together with an inline model picker. Picking a model submits
     * `remote.session.selectModel`, which appends the durable
     * `model/selection` event: the host retires the family's 1/min pacing
     * and the next request routes to the picked model through the built-in
     * model-selection machinery, and the banner clears itself because the
     * projection view reports `pendingModelSwitch: false`.
     */

    const PROJECTION_KEY = 'llmRateLimit';
    const MODEL_SELECTION_KEY = 'modelSelection';

    const NS = 'rateLimitNotice';
    const zh = {
      'notice.title': '每日额度已用完',
      'notice.message': '{provider}：{detail}',
      'notice.hint': '接下来将按 1 分钟 1 次的节奏自动重试；也可立即切换模型继续。',
      'notice.switchModel': '切换模型',
      'picker.title': '选择模型',
      'picker.loading': '正在加载模型列表…',
      'picker.error': '模型列表加载失败：{message}',
      'picker.empty': '没有可用的模型。',
      'picker.current': '当前'
    };
    const en = {
      'notice.title': 'Daily limit reached',
      'notice.message': '{provider}: {detail}',
      'notice.hint': 'Automatic retries run one per minute; you can also switch models now.',
      'notice.switchModel': 'Switch model',
      'picker.title': 'Select a model',
      'picker.loading': 'Loading models…',
      'picker.error': 'Failed to load models: {message}',
      'picker.empty': 'No models available.',
      'picker.current': 'Current'
    };

    /** Compact provider-grouped model list fed by the host model catalog. */
    function ModelPicker({ sessionId, t, catalog, select, current }) {
      const [open, setOpen] = react.useState(false);
      const [groups, setGroups] = react.useState(null);
      const [error, setError] = react.useState(null);

      const load = () => {
        setOpen(true);
        setError(null);
        setGroups(null);
        catalog().then(
          (value) => {
            if (value && value.ok && value.value) setGroups(value.value.groups || []);
            else setError({ message: value ? `${value.error.code}: ${value.error.message}` : 'unknown' });
          },
          (e) => setError({ message: String((e && e.message) ? e.message : e) })
        );
      };

      const close = () => {
        setOpen(false);
        setGroups(null);
      };

      const pick = (group, model) => {
        select(sessionId, { provider: group.id, model: model.id }).catch(() => {});
        close();
      };

      if (!open) {
        return h(
          'button',
          {
            type: 'button',
            onClick: load,
            'aria-haspopup': 'dialog',
            style: {
              flex: '0 0 auto',
              padding: '4px 12px',
              borderRadius: '6px',
              border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary, currentColor)',
              cursor: 'pointer',
              fontSize: '12px',
              lineHeight: '18px'
            }
          },
          t('notice.switchModel')
        );
      }

      return h(
        'div',
        {
          role: 'dialog',
          'aria-label': t('picker.title'),
          style: {
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            padding: '8px',
            borderRadius: '8px',
            background: 'var(--dsw-alias-bg-l2, var(--dsw-alias-bg-l1, #fff))',
            border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
            boxShadow: 'var(--dsw-elevation-prominent, 0 6px 24px rgba(0,0,0,0.18))',
            color: 'var(--dsw-alias-label-primary, currentColor)',
            fontSize: '12px',
            lineHeight: '18px'
          }
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('span', { style: { flex: '1 1 auto', fontWeight: 600 } }, t('picker.title')),
          h(
            'button',
            {
              type: 'button',
              'aria-label': t('picker.title'),
              onClick: close,
              style: {
                flex: '0 0 auto',
                border: 'none',
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: '14px',
                lineHeight: '18px',
                padding: '0 4px'
              }
            },
            '✕'
          )
        ),
        error
          ? h(
              'div',
              { style: { padding: '4px' } },
              t('picker.error', { message: error.message }),
              h(
                'button',
                {
                  type: 'button',
                  onClick: load,
                  style: {
                    marginTop: '6px',
                    padding: '2px 10px',
                    borderRadius: '6px',
                    border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer'
                  }
                },
                t('notice.switchModel')
              )
            )
          : groups === null
            ? h('div', { style: { padding: '4px' } }, t('picker.loading'))
            : groups.length === 0
              ? h('div', { style: { padding: '4px' } }, t('picker.empty'))
              : groups.map((group) =>
                  h(
                    'div',
                    { key: group.id, style: { marginBottom: '6px' } },
                    h(
                      'div',
                      {
                        style: {
                          color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))',
                          padding: '2px 4px',
                          fontWeight: 600
                        }
                      },
                      group.name || group.id
                    ),
                    (group.models || []).map((model) => {
                      const isCurrent =
                        current !== null &&
                        current !== undefined &&
                        current.provider === group.id &&
                        current.model === model.id;
                      return h(
                        'button',
                        {
                          key: model.id,
                          type: 'button',
                          disabled: isCurrent,
                          onClick: () => pick(group, model),
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            width: '100%',
                            textAlign: 'left',
                            padding: '4px 8px',
                            borderRadius: '6px',
                            border: 'none',
                            background: isCurrent
                              ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))'
                              : 'transparent',
                            color: isCurrent
                              ? 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))'
                              : 'inherit',
                            cursor: isCurrent ? 'default' : 'pointer',
                            fontSize: '12px',
                            lineHeight: '18px'
                          }
                        },
                        h(
                          'span',
                          {
                            style: {
                              flex: '1 1 auto',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }
                          },
                          model.name || model.id
                        ),
                        isCurrent ? h('span', { style: { flex: '0 0 auto' } }, t('picker.current')) : null
                      );
                    })
                  )
                )
      );
    }

    /**
     * The banner itself. Reads the active session's `llmRateLimit` projection
     * face (through the slot's `useProjection`) and the `modelSelection`
     * face for the current model, and renders only while the view reports an
     * active daily-limit hit. The picker's verbs come from the shared
     * `remote.session` namespace.
     *
     * @param props - The slot's session id and projection hook, plus the
     *   bound `t` and the `remote.session` namespace.
     */
    function RateLimitNotice({ sessionId, t, useProjection, remoteSession }) {
      // The session-scoped slot supplies reactive projection hooks, including
      // the loading/absent state. Keep both subscriptions before early returns.
      const view = useProjection(PROJECTION_KEY);
      const modelSelection = useProjection(MODEL_SELECTION_KEY);
      // A key the Host never registered reads `undefined`; there is nothing to
      // show then. Both subscriptions run before this return so the hook order
      // is fixed even while the projection is still absent.
      if (!view) return null;

      const hit = view.lastDailyLimit;
      // Persist until the user switches models. The host flips
      // `pendingModelSwitch` back to false on the durable `model/selection`
      // event, so the banner clears exactly when the user acts. A client-side
      // expiry window used to hide it while a real quota failure was still in
      // force — the user often returns to the tab minutes later, which is
      // precisely when they need the notice.
      if (view.pendingModelSwitch !== true || hit === null || hit === undefined) return null;

      const currentSel = modelSelection?.current ?? null;

      const detail = typeof hit.message === 'string' && hit.message.length > 0 ? hit.message : '';

      return h(
        'div',
        {
          role: 'status',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '10px 14px',
            borderRadius: '8px',
            background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))',
            border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
            color: 'var(--dsw-alias-label-primary, currentColor)',
            fontSize: '13px',
            lineHeight: '20px'
          }
        },
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: '6px' } },
            h('span', { style: { fontWeight: 600, flex: '0 0 auto' } }, t('notice.title')),
            detail
              ? h(
                  'span',
                  {
                    style: {
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))'
                    },
                    title: detail
                  },
                  t('notice.message', { provider: hit.provider || '?', detail })
                )
              : null
          ),
          h(
            'div',
            {
              style: {
                color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))',
                fontSize: '12px',
                marginTop: '2px'
              }
            },
            t('notice.hint')
          )
        ),
        h(ModelPicker, {
          sessionId,
          t,
          current: currentSel,
          catalog: () => remoteSession.modelCatalog(),
          select: (id, selection) =>
            remoteSession.selectModel({
              sessionId: id,
              provider: selection.provider,
              model: selection.model,
              ...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
            })
        })
      );
    }

    /**
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'rate-limit notice: dictionaries');
      const t = ctx.locale.bind(NS);
      const remoteSession = ctx.remote.session;

      ctx.slots.inject('conversation.input.dock', () => {
        return ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'rate-limit-notice',
            order: 0,
            label: t('notice.title')
          },
          function QuotaNotice({ sessionId, useProjection }) {
            if (sessionId === void 0 || sessionId === null) return null;
            return h(RateLimitNotice, {
              sessionId,
              t,
              useProjection,
              remoteSession
            });
          }
        );
      });
    }

    exports.apply = apply;
    exports.inject = ['slots', 'sessions', 'remote', 'remote.session', 'locale'];
    return module.exports;
  }
});
