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

    /**
     * Styles mirroring the built-in model selector (`dsh-client-ui-model-selection`):
     * same menu metrics (4px padding, `--dsw-elevation-prominent`, 240–420px wide,
     * 360px max height), the same 34px option rows with `--dsw-alias-interactive-bg-hover`,
     * the same 13px/18px model label, and the same tertiary "empty" treatment.
     * Hover/disabled states need real selectors, so they ship as a stylesheet
     * rather than inline styles.
     */
    const STYLE_ID = 'dsh-rate-limit-notice-styles';
    const CSS = `
.dsh-rlm-root { position: relative; flex: 0 0 auto; }
.dsh-rlm-trigger {
  border-radius: var(--dsw-radius-sm);
  min-width: 0;
  height: 28px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  background: 0 0;
  border: none;
  outline: none;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  display: flex;
  flex: 0 0 auto;
}
.dsh-rlm-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-rlm-trigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); }
.dsh-rlm-chevron { color: var(--dsw-alias-label-caption); flex: none; transition: transform .12s; }
.dsh-rlm-chevronOpen { transform: rotate(180deg); }
.dsh-rlm-backdrop { position: fixed; inset: 0; z-index: 1099; }
.dsh-rlm-menu {
  z-index: 1100;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  width: max-content;
  min-width: min(240px, 100vw - 32px);
  max-width: min(420px, 100vw - 32px);
  max-height: min(360px, 100vh - 96px);
  box-shadow: var(--dsw-elevation-prominent);
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  border: 0;
  border-radius: var(--dsw-radius-md);
  flex-direction: column;
  padding: 4px;
  display: flex;
  /* Fixed, like the built-in selector: the composer column clips overflow, so
     an absolutely positioned menu would be cut off. Position comes from the
     measured trigger (inline style). */
  position: fixed;
  overflow: hidden;
}
.dsh-rlm-status, .dsh-rlm-empty {
  color: var(--dsw-alias-label-tertiary);
  padding: 8px;
  font-size: 12px;
  line-height: 18px;
}
.dsh-rlm-error {
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
  justify-content: space-between;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 3px;
  padding: 6px 7px;
  font-size: 11px;
  line-height: 16px;
  display: flex;
}
.dsh-rlm-retry {
  color: inherit;
  font: inherit;
  cursor: pointer;
  background: 0 0;
  border: none;
  flex: none;
  padding: 0;
  font-weight: 600;
}
.dsh-rlm-groups { min-height: 0; overflow-y: auto; }
.dsh-rlm-groupLabel {
  color: var(--dsw-alias-label-tertiary);
  padding: 6px 7px 2px;
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
}
.dsh-rlm-option {
  box-sizing: border-box;
  border-radius: var(--dsw-radius-md);
  width: auto;
  min-width: 100%;
  min-height: 34px;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: 0 0;
  border: none;
  outline: none;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  display: flex;
}
.dsh-rlm-option:hover:not(:disabled), .dsh-rlm-option:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-rlm-option:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dsh-rlm-optionCopy { flex-direction: column; flex: 1; min-width: 0; display: flex; }
.dsh-rlm-modelName {
  color: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 400;
  line-height: 18px;
  overflow: hidden;
}
.dsh-rlm-check { color: var(--dsw-alias-label-primary); flex: 0 0 14px; place-items: center; display: grid; }
.dsh-rlm-check svg { width: 14px; height: 14px; }
.dsh-rlm-banner {
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-left: 3px solid var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 18px;
}
.dsh-rlm-bannerIcon { color: var(--dsw-alias-state-warn-primary); flex: 0 0 auto; display: grid; place-items: center; width: 16px; height: 18px; }
.dsh-rlm-bannerBody { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dsh-rlm-bannerTitle { font-weight: 600; }
.dsh-rlm-bannerDetail { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-rlm-bannerHint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 16px; }
`;

    /**
     * Install the stylesheet once per document. Returns the disposer that
     * removes it; a second live instance gets a no-op disposer so unloading one
     * copy never strips the styles the other still uses.
     */
    function installStyles() {
      if (typeof document === 'undefined') return () => {};
      if (document.getElementById(STYLE_ID) !== null) return () => {};
      const element = document.createElement('style');
      element.id = STYLE_ID;
      element.textContent = CSS;
      document.head.appendChild(element);
      return () => element.remove();
    }

    /** 12px chevron that rotates while the menu is open. */
    function Chevron({ open }) {
      return h(
        'svg',
        {
          className: open ? 'dsh-rlm-chevron dsh-rlm-chevronOpen' : 'dsh-rlm-chevron',
          viewBox: '0 0 16 16',
          width: 12,
          height: 12,
          'aria-hidden': true
        },
        h('path', {
          d: 'M4 6.5 8 10.5 12 6.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round'
        })
      );
    }

    /** 14px check, matching the built-in selector's selected-row affordance. */
    function Check() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', 'aria-hidden': true },
        h('path', {
          d: 'M3.5 8.5 6.5 11.5 12.5 4.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round'
        })
      );
    }

    /** Warning triangle for the banner. */
    function WarnIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
        h('path', { d: 'M8 1.8 15 14H1L8 1.8Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
        h('path', { d: 'M8 6.2v3.4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('circle', { cx: 8, cy: 11.6, r: 0.9, fill: 'currentColor' })
      );
    }

    const NS = 'rateLimitNotice';
    const zh = {
      'notice.title': '每日额度已用完',
      'notice.message': '{provider}：{detail}',
      'notice.hint': '接下来将按 1 分钟 1 次的节奏自动重试；也可立即切换模型继续。',
      'notice.switchModel': '切换模型',
      'picker.title': '选择模型',
      'picker.loading': '正在加载模型列表…',
      'picker.error': '模型列表加载失败：{message}',
      'picker.retry': '重试',
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
      'picker.retry': 'Retry',
      'picker.empty': 'No models available.',
      'picker.current': 'Current'
    };

    /** Compact provider-grouped model list fed by the host model catalog. */
    function ModelPicker({ sessionId, t, catalog, select, current }) {
      const [open, setOpen] = react.useState(false);
      const [groups, setGroups] = react.useState(null);
      const [error, setError] = react.useState(null);
      // Viewport coordinates for the fixed menu, measured from the trigger.
      const [anchor, setAnchor] = react.useState(null);
      const triggerRef = react.useRef(null);

      // The trigger is only mounted while the menu is closed, so measuring must
      // happen on the transition to open. The menu stays hidden until the
      // measurement lands, which avoids a visible jump from the corner.
      react.useEffect(() => {
        if (!open) {
          setAnchor(null);
          return;
        }
        const trigger = triggerRef.current;
        if (!trigger || typeof trigger.getBoundingClientRect !== 'function') return;
        const rect = trigger.getBoundingClientRect();
        setAnchor({
          bottom: Math.max(8, window.innerHeight - rect.top + 6),
          right: Math.max(8, window.innerWidth - rect.right)
        });
      }, [open]);

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
        // Returned bare (not wrapped): the dock reads this element's `type`, and
        // it must stay the trigger button.
        return h(
          'button',
          {
            type: 'button',
            ref: triggerRef,
            className: 'dsh-rlm-trigger',
            onClick: load,
            'aria-haspopup': 'dialog',
            'aria-expanded': false
          },
          h('span', null, t('notice.switchModel')),
          h(Chevron, { open: false })
        );
      }

      return h(
        'div',
        { className: 'dsh-rlm-root' },
        // Click-away sheet behind the menu: dismissing needs no document
        // listener, so the component stays on the hooks the dock provides.
        h('div', { className: 'dsh-rlm-backdrop', onClick: close }),
        h(
          'div',
          {
            className: 'dsh-rlm-menu',
            role: 'dialog',
            'aria-label': t('picker.title'),
            style: anchor === null ? { visibility: 'hidden' } : { bottom: anchor.bottom, right: anchor.right }
          },
          error
            ? h(
                'div',
                { className: 'dsh-rlm-error' },
                h('span', null, t('picker.error', { message: error.message })),
                h('button', { type: 'button', className: 'dsh-rlm-retry', onClick: load }, t('picker.retry'))
              )
            : groups === null
              ? h('div', { className: 'dsh-rlm-status' }, t('picker.loading'))
              : groups.length === 0
                ? h('div', { className: 'dsh-rlm-empty' }, t('picker.empty'))
                : h(
                    'div',
                    { className: 'dsh-rlm-groups' },
                    groups.map((group) =>
                      h(
                        'div',
                        { key: group.id },
                        h('div', { className: 'dsh-rlm-groupLabel' }, group.name || group.id),
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
                              className: 'dsh-rlm-option',
                              disabled: isCurrent,
                              onClick: () => pick(group, model)
                            },
                            h(
                              'span',
                              { className: 'dsh-rlm-optionCopy' },
                              h('span', { className: 'dsh-rlm-modelName' }, model.name || model.id)
                            ),
                            isCurrent
                              ? h('span', { className: 'dsh-rlm-check', title: t('picker.current') }, h(Check, null))
                              : null
                          );
                        })
                      )
                    )
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
        { className: 'dsh-rlm-banner', role: 'status' },
        h('span', { className: 'dsh-rlm-bannerIcon' }, h(WarnIcon, null)),
        h(
          'div',
          { className: 'dsh-rlm-bannerBody' },
          h('div', { className: 'dsh-rlm-bannerTitle' }, t('notice.title')),
          detail
            ? h(
                'div',
                { className: 'dsh-rlm-bannerDetail', title: detail },
                t('notice.message', { provider: hit.provider || '?', detail })
              )
            : null,
          h('div', { className: 'dsh-rlm-bannerHint' }, t('notice.hint'))
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
      ctx.effect(() => installStyles(), 'rate-limit notice: styles');
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
