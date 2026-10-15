import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadClient() {
  let plugin;
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
  };
  vm.runInNewContext(fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => {
      plugin = factory((id) => {
        assert.equal(id, 'react');
        return react;
      });
    } } },
  });
  return plugin;
}

function context() {
  const dictionaries = new Set();
  const effects = [];
  let component;
  const ctx = {
    locale: {
      register(ns) {
        assert.equal(dictionaries.has(ns), false, 'locale leaked across reload');
        dictionaries.add(ns);
        return () => dictionaries.delete(ns);
      },
      bind: () => (key) => key,
    },
    remote: { session: {} },
    effect(setup) { effects.push(setup()); },
    slots: {
      inject(name, setup) {
        assert.equal(name, 'conversation.input.dock');
        const dispose = setup();
        assert.equal(typeof dispose, 'function');
        effects.push(dispose);
      },
      register(options, view) {
        component = view;
        return () => { component = undefined; };
      },
    },
  };
  return {
    ctx, dictionaries,
    component: () => component,
    dispose: () => { for (const dispose of effects.splice(0).reverse()) dispose(); },
  };
}

test('client declares both the remote root and session namespace for boot', () => {
  const plugin = loadClient();
  const manifest = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url)));
  for (const dependency of ['remote', 'remote.session', 'slots', 'locale']) {
    assert.ok(plugin.inject.includes(dependency));
    assert.ok(manifest.dsh.client.inject.includes(dependency));
  }
});

test('client unload releases its slot and dictionaries before reactivation', () => {
  const plugin = loadClient();
  const host = context();
  for (let i = 0; i < 2; ++i) {
    plugin.apply(host.ctx);
    assert.equal(host.dictionaries.size, 1);
    assert.equal(typeof host.component(), 'function');
    host.dispose();
    assert.equal(host.dictionaries.size, 0);
    assert.equal(host.component(), undefined);
  }
});

test('session slot handles absent and active projections with fixed hook order', () => {
  const plugin = loadClient();
  const host = context();
  plugin.apply(host.ctx);
  for (const active of [false, true, false]) {
    const calls = [];
    const element = host.component()({
      sessionId: 'session-1',
      useProjection(key) {
        calls.push(key);
        return active && key === 'llmRateLimit' ? {
          pendingModelSwitch: true,
          lastDailyLimit: { at: Date.now(), provider: 'test', message: 'daily quota' },
        } : undefined;
      },
    });
    assert.equal(element.props.sessionId, 'session-1');
    const banner = element.type(element.props);
    assert.deepEqual(calls, ['llmRateLimit', 'modelSelection']);
    if (active) {
      const picker = banner.children.at(-1);
      assert.equal(picker.type(picker.props).type, 'button');
    } else assert.equal(banner, null);
  }
  host.dispose();
});
