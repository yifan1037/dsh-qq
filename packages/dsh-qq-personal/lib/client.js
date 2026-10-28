/**
 * dsh-qq-personal · client half.
 *
 * Adds a left-sidebar entry ("QQ 管理台") that opens the local management
 * console inside the main panel (iframe), plus a sidebar glyph. The console URL
 * and its one-time token come from the host route
 * `/api/dsh-qq-personal/console-info` (registered by lib/index.js), because the
 * web UI cannot read %USERPROFILE% itself.
 *
 * Bundled in DSH's client ModuleLoader format: no build step, only `react` is
 * required from the host.
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-personal',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    const PANEL_KEY = 'qq-console';
    const LABEL = 'QQ 管理台';

    /** Sidebar glyph: a small chat bubble. */
    function ConsoleGlyph(props) {
      const size = props && props.size ? props.size : 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9l-4.5 3v-3A1.5 1.5 0 0 1 3 15V7a1.5 1.5 0 0 1 1.5-1.5Z' }),
        h('path', { d: 'M7 9h10' }),
        h('path', { d: 'M7 12.5h6.5' }),
      );
    }

    /** Main-panel page: iframe the local console. */
    function ConsolePage() {
      const [state, setState] = React.useState({ status: 'loading', url: '', error: '' });

      React.useEffect(function () {
        let cancelled = false;
        fetch('/api/dsh-qq-personal/console-info', { credentials: 'same-origin' })
          .then(function (response) {
            if (!response.ok) throw new Error('console-info HTTP ' + response.status);
            return response.json();
          })
          .then(function (info) {
            if (cancelled) return;
            if (!info || typeof info.url !== 'string') throw new Error('console-info returned no url');
            setState({ status: 'ready', url: info.url, error: '' });
          })
          .catch(function (error) {
            if (cancelled) return;
            setState({ status: 'error', url: '', error: String(error && error.message ? error.message : error) });
          });
        return function () {
          cancelled = true;
        };
      }, []);

      if (state.status === 'ready') {
        return h('div', { style: { position: 'relative', width: '100%', height: '100%', overflow: 'hidden' } },
          h('iframe', {
            src: state.url,
            title: LABEL,
            style: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: '0', background: 'transparent' },
          }));
      }

      const text = state.status === 'error'
        ? '无法连接 QQ 管理台：' + state.error + '（确认 DSH 插件已启动；日志在 ~/.dsh/qq-personal/）'
        : '正在连接 QQ 管理台…';
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: '100%', padding: '24px', color: '#8b93a7', fontSize: '13px', textAlign: 'center',
        },
      }, text);
    }

    const SNOW_KEY = 'snowluma-panel';
    const SNOW_LABEL = 'SnowLuma';

    /** Sidebar glyph: a small whale-ish spark. */
    function SnowGlyph(props) {
      const size = props && props.size ? props.size : 16;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M3 12c2.5-4.5 6-6.5 9-6.5 3.6 0 6 2.2 6 4.7 0 1.6-1 2.8-2.7 3.2' }),
        h('path', { d: 'M13 17.5c-3 0-6-1.5-8-4' }),
        h('circle', { cx: 16.4, cy: 10.6, r: 0.9, fill: 'currentColor', stroke: 'none' }),
      );
    }

    /** Main-panel page: SnowLuma 状态 + 启动。 */
    function SnowLumaPage() {
      const [info, setInfo] = React.useState({ status: 'loading', data: null, error: '', busy: false, note: '' });

      const load = React.useCallback(function () {
        fetch('/api/dsh-qq-personal/snowluma-status', { credentials: 'same-origin' })
          .then(function (r) { if (!r.ok) throw new Error('status HTTP ' + r.status); return r.json(); })
          .then(function (data) { setInfo(function (s) { return { ...s, status: 'ready', data: data, error: '' }; }); })
          .catch(function (e) { setInfo(function (s) { return { ...s, status: 'error', error: String(e && e.message ? e.message : e) }; }); });
      }, []);

      React.useEffect(function () {
        load();
        const iconv = setInterval(load, 3000);
        return function () { clearInterval(iconv); };
      }, [load]);

      const start = function () {
        setInfo(function (s) { return { ...s, busy: true, note: '正在启动…' }; });
        fetch('/api/dsh-qq-personal/snowluma-start', { method: 'POST', credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            setInfo(function (s) { return { ...s, busy: false, note: data && data.ok ? (data.alreadyRunning ? '已经在运行' : '已启动，等它加载…') : ('失败：' + (data && data.error ? data.error : 'unknown')) }; });
            setTimeout(load, 1200);
          })
          .catch(function (e) { setInfo(function (s) { return { ...s, busy: false, note: '失败：' + String(e) }; }); });
      };

      const d = info.data;
      const running = !!(d && d.running);
      const pill = function (text, ok) {
        return h('span', { style: {
          display: 'inline-block', padding: '2px 8px', borderRadius: '999px', fontSize: '12px',
          background: ok ? 'rgba(48,209,88,0.15)' : 'rgba(255,69,58,0.15)',
          color: ok ? '#30d158' : '#ff453a',
        } }, text);
      };

      return h('div', { style: { padding: '24px', maxWidth: '560px', color: 'inherit' } },
        h('h2', { style: { margin: '0 0 12px', fontSize: '16px' } }, 'SnowLuma（OneBot 网关）'),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' } },
          pill(running ? '在线' : '离线', running),
          h('span', { style: { fontSize: '12px', color: '#8b93a7' } },
            d ? ('HTTP ' + d.httpPort + ' / WS ' + d.wsPort) : '正在读取…'),
        ),
        h('div', { style: { fontSize: '12px', color: '#8b93a7', lineHeight: 1.7, marginBottom: '14px' } },
          h('div', null, '安装目录：' + (d ? (d.dir || '（未配置 snowlumaDir）') : '…')),
          d && !d.hasDir ? h('div', { style: { color: '#ff9f0a' } }, '目录不存在：请改 settings.json 的 snowlumaDir') : null,
          d && d.hasDir && (!d.hasNode || !d.hasEntry) ? h('div', { style: { color: '#ff9f0a' } }, '目录里缺少 node.exe 或 index.mjs') : null,
        ),
        h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
          h('button', {
            onClick: start,
            disabled: info.busy || running || info.status !== 'ready',
            style: {
              padding: '7px 14px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.14)',
              background: running ? 'rgba(255,255,255,0.06)' : 'rgba(10,132,255,0.18)',
              color: 'inherit', cursor: running ? 'default' : 'pointer', fontSize: '13px',
            },
          }, running ? '已在运行' : (info.busy ? '启动中…' : '启动 SnowLuma')),
          running && d && d.webUi ? h('a', {
            href: d.webUi, target: '_blank', rel: 'noreferrer',
            style: { padding: '7px 14px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.14)', textDecoration: 'none', color: 'inherit', fontSize: '13px' },
          }, '打开 WebUI') : null,
          h('button', {
            onClick: load,
            style: { padding: '7px 14px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.14)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '13px' },
          }, '刷新'),
        ),
        info.note ? h('div', { style: { marginTop: '12px', fontSize: '12px', color: '#8b93a7' } }, info.note) : null,
        info.error ? h('div', { style: { marginTop: '12px', fontSize: '12px', color: '#ff453a' } }, '读取失败：' + info.error) : null,
        h('div', { style: { marginTop: '18px', fontSize: '12px', color: '#6b7280', lineHeight: 1.7 } },
          '说明：这里的「启动」是你亲手点的，等价于双击 launcher.bat；它不注册为 AI 工具，模型不能自己拉起或结束 SnowLuma。',
        ),
      );
    }

    /** Services the client half needs. `slots` is where both registrations go. */
    const inject = ['slots'];

    function apply(ctx) {
      ctx.inject(['slots'], function (slotCtx) {
        slotCtx.slots.inject('sidebar.panellist', function () {
          return slotCtx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_KEY, order: 60, label: LABEL },
            ConsoleGlyph,
          );
        });
        slotCtx.slots.inject('main', function () {
          return slotCtx.slots.register(
            { name: 'main', key: PANEL_KEY },
            ConsolePage,
          );
        });
        slotCtx.slots.inject('sidebar.panellist', function () {
          return slotCtx.slots.register(
            { name: 'sidebar.panellist', id: SNOW_KEY, order: 61, label: SNOW_LABEL },
            SnowGlyph,
          );
        });
        slotCtx.slots.inject('main', function () {
          return slotCtx.slots.register(
            { name: 'main', key: SNOW_KEY },
            SnowLumaPage,
          );
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
