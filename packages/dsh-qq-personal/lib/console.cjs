/**
 * 本地管理控制台：给 dsh-qq-personal 一个「单独窗口」。
 *
 * 纯 Node http + 内联单页（无构建、无依赖）。插件在宿主进程里启动它，页面通过
 * 同源 /api 读写 settings.json、触发桥接重启、查看日志；窗口本身由
 * `打开QQ管理窗口.cmd` 用 Edge/Chrome 的 --app 方式打开（独立窗口，无地址栏）。
 *
 * 安全：只绑定 127.0.0.1，并且所有请求都要带 consoleToken（页面从 URL 的
 * ?token= 拿一次，之后用 X-Token 头）。
 *
 * @module dsh-qq-personal/console
 */
'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>QQ 管理台 · DSH</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --card:#171a21; --line:#262b36; --fg:#e6e9ef; --dim:#8b93a7; --accent:#4f8cff; --ok:#3ecf8e; --bad:#ff6b6b; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  header { display:flex; align-items:center; gap:12px; padding:14px 20px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:2; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  header .spacer { flex:1; }
  .chip { font-size:12px; padding:3px 9px; border-radius:999px; border:1px solid var(--line); color:var(--dim); white-space:nowrap; }
  .chip.ok { color:var(--ok); border-color:#1d4d3a; }
  .chip.bad { color:var(--bad); border-color:#4d1d1d; }
  main { display:grid; grid-template-columns: 220px 1fr; gap:20px; padding:20px; max-width:1180px; margin:0 auto; }
  nav { display:flex; flex-direction:column; gap:6px; position:sticky; top:64px; align-self:start; }
  nav button { text-align:left; background:transparent; border:1px solid transparent; color:var(--dim); padding:9px 12px; border-radius:8px; cursor:pointer; font-size:14px; }
  nav button:hover { color:var(--fg); background:#1b1f28; }
  nav button.active { color:var(--fg); background:#1f2531; border-color:var(--line); }
  section { display:none; }
  section.active { display:block; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin-bottom:16px; }
  .card h2 { font-size:15px; margin:0 0 12px; }
  .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:10px; }
  .row label { color:var(--dim); min-width:120px; }
  input[type=text], input[type=number], textarea, select { background:#0d1016; color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:7px 10px; font:inherit; }
  textarea { width:100%; min-height:84px; resize:vertical; font-family:Consolas, monospace; font-size:12px; }
  input[type=range] { width:260px; }
  button.primary { background:var(--accent); color:#fff; border:0; padding:9px 18px; border-radius:8px; font:inherit; cursor:pointer; }
  button.ghost { background:#20242e; color:var(--fg); border:1px solid var(--line); padding:8px 14px; border-radius:8px; cursor:pointer; font:inherit; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:middle; }
  th { color:var(--dim); font-weight:500; font-size:12px; }
  .muted { color:var(--dim); font-size:12px; }
  .toast { position:fixed; right:20px; bottom:20px; background:#1f2531; border:1px solid var(--line); padding:10px 16px; border-radius:10px; opacity:0; transition:.2s; }
  .toast.show { opacity:1; }
  pre.log { background:#0b0d12; border:1px solid var(--line); border-radius:10px; padding:12px; max-height:520px; overflow:auto; font:12px/1.45 Consolas, monospace; white-space:pre-wrap; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  @media (max-width: 900px) { main { grid-template-columns:1fr; } nav { flex-direction:row; flex-wrap:wrap; position:static; } .grid2 { grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <h1>QQ 管理台</h1>
  <span class="chip" id="chipDsh">DSH …</span>
  <span class="chip" id="chipSnow">SnowLuma …</span>
  <span class="chip" id="chipBridge">桥接 …</span>
  <span class="chip" id="chipMode">模式 …</span>
  <span class="spacer"></span>
  <button class="ghost" id="btnRestart">重启桥接</button>
  <button class="primary" id="btnSave">保存设置</button>
</header>
<main>
  <nav>
    <button data-tab="overview" class="active">总览</button>
    <button data-tab="groups">群聊与档位</button>
    <button data-tab="persona">人设</button>
    <button data-tab="mode">模式与私聊</button>
    <button data-tab="logs">日志</button>
    <button data-tab="cost">成本</button>
      <button data-tab="sessions">会话</button>
      <button data-tab="memory">记忆</button>
      <button data-tab="caps">权限</button>
      <button data-tab="explore">探索</button>
      <button data-tab="tasks">任务</button>
  </nav>
  <div>
    <section id="tab-overview" class="active">
      <div class="card"><h2>运行状态</h2><div id="overview" class="muted">加载中…</div></div>
      <div class="card"><h2>当前生效</h2><div id="applied" class="muted">—</div></div>
    </section>

    <section id="tab-groups">
      <div class="card">
        <h2>群聊白名单</h2>
        <table><thead><tr><th>群号</th><th>响应档位（0-100）</th><th>关键词（逗号分隔）</th><th>静音</th><th></th></tr></thead><tbody id="groupRows"></tbody></table>
        <div class="row" style="margin-top:12px">
          <input type="text" id="newGroup" placeholder="新群号" />
          <button class="ghost" id="btnAddGroup">添加群</button>
          <span class="muted">档位：0-10 仅@/叫名字/引用；10-20 +关键词；20-90 +按概率；90-100 全响应</span>
        </div>
      </div>
      <div class="card">
        <h2>默认档位与默认关键词</h2>
        <div class="row"><label>默认档位</label><input type="range" id="defaultTier" min="0" max="100" step="1" /><span id="defaultTierVal" class="muted"></span></div>
        <div class="row"><label>默认关键词</label><input type="text" id="defaultKeywords" style="flex:1" /></div>
        <p class="muted">新加群未单独设档位时用默认值；关键词用于档位 10 以上。</p>
      </div>
    </section>

    <section id="tab-persona">
      <div class="card">
        <h2>人设（角色卡）</h2>
        <div class="row"><label>当前人设</label><select id="personaSelect"></select></div>
        <div class="row"><label>自定义文件</label><input type="text" id="personaFile" style="flex:1" placeholder="留空则用选中的人设卡；填 .md 绝对路径可覆盖" /></div>
        <div class="row"><label>或直接粘贴</label></div>
        <textarea id="personaText" placeholder="留空则不用内联文本；填写后优先于文件"></textarea>
        <p class="muted" id="personaMeta"></p>
      </div>
    </section>

    <section id="tab-mode">
      <div class="card">
        <h2>运行模式</h2>
        <div class="row"><label><input type="radio" name="mode" value="chat" /> chat（白名单聊天）</label></div>
        <div class="row"><label><input type="radio" name="mode" value="closed-agent" /> closed-agent（仅 owner 私聊，完整工具）</label></div>
          <div class="row"><label><input type="radio" name="mode" value="reserved" /> reserved（一代仿真：桥接拆条）</label></div>
          <div class="row"><label><input type="radio" name="mode" value="reserved2" /> reserved2（二代仿真：自主工具 · 记忆 · 唤醒）</label></div>
          <p class="muted" style="color:#ff9f0a">⚠️ 模式改动会重启桥接并建立新会话（聊天上下文会重置，长期印象保留）。切到 reserved2 需要预设 qq-chat-v2；切回 chat/closed-agent 用 qq-chat。</p>
        <div class="row"><label>owner QQ</label><input type="text" id="ownerQQ" /></div>
        <p class="muted">closed-agent = 只有 ownerQQ 私聊能用；群聊和其它人一律不响应。</p>
      </div>
      <div class="card">
        <h2>私聊白名单</h2>
        <textarea id="allowPrivate" placeholder="每行一个 QQ 号"></textarea>
        <p class="muted">留空则谁都不回。</p>
      </div>
      <div class="card">
        <h2>高级</h2>
        <div class="row"><label>模型</label><input type="text" id="modelName" placeholder="deepseek-flash" /></div>
        <div class="row"><label>推理强度</label><select id="reasoningEffort">
          <option value="off">off（最省，推荐聊天）</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="max">max</option>
        </select></div>
        <div class="row"><label>人设注入上限</label><input type="number" id="roleMax" min="1000" max="20000" step="500" /></div>
        <div class="row"><label>会话工作目录</label><input type="text" id="sessionCwd" style="flex:1" /></div>
        <div class="row"><label>电脑操作</label><label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" id="desktopTools" /> 允许 computer / computer_batch（关闭更省 token；重启 DSH 后工具描述也会消失）</label></div>
      </div>
    </section>

    <section id="tab-cost">
      <div class="card">
        <h2>成本</h2>
        <div class="row"><button class="ghost" id="btnRefreshCost">刷新</button><span class="muted" id="costMeta"></span></div>
        <div id="costBox" class="muted">加载中…</div>
      </div>
      <div class="card">
        <h2>每日明细</h2>
        <div id="costTable" class="muted">—</div>
      </div>
    </section>

    <section id="tab-sessions">
      <div class="card">
        <h2>会话</h2>
        <div class="row"><button class="ghost" id="btnRefreshSessions">刷新</button><span class="muted" id="sessionsMeta"></span></div>
        <div id="sessionsBox" class="muted">加载中…</div>
      </div>
    </section>

    <section id="tab-memory">
      <div class="card">
        <h2>记忆库</h2>
        <div class="row"><button class="ghost" id="btnRefreshMemory">刷新</button><span class="muted" id="memoryMeta"></span></div>
        <div class="row">
          <input id="memQuery" placeholder="搜记忆：考试 / 情绪 / 约定…" style="flex:1" />
          <button id="btnMemSearch">搜索</button>
          <button class="ghost" id="btnMemClear">看全部</button>
        </div>
        <div id="memoryBox" class="muted">加载中…</div>
      </div>
      <div class="card">
        <h2>添加一条记忆</h2>
        <div class="row"><textarea id="memText" rows="3" placeholder="写清楚：什么时候、谁、发生了什么（不超过 4000 字）" style="width:100%"></textarea></div>
        <div class="row">
          <label class="muted">重要度</label>
          <select id="memWeight"><option value="5">5 极重要</option><option value="4">4 重要</option><option value="3" selected>3 一般</option><option value="2">2 琐碎</option><option value="1">1 可忽略</option></select>
          <input id="memTags" placeholder="标签，逗号分隔，如 情绪,考试" style="flex:1" />
          <button id="btnMemAdd">存入</button>
        </div>
        <div class="muted" id="memAddMsg"></div>
      </div>
    </section>

    <section id="tab-caps">
      <div class="card">
        <h2>她能做什么（权限）</h2>
        <div class="muted" style="margin-bottom:10px">改完立即生效（电脑操作下次会话生效）。她可以「申请」前两项，等你批准；探索模式只能你手动开。</div>
        <div class="row" style="align-items:center;gap:10px">
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="capDesktop" /> <b>L2 电脑操作</b></label>
          <span class="muted">截图 / 鼠标 / 键盘</span>
        </div>
        <div class="row" style="align-items:center;gap:10px">
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="capFullRead" /> <b>L3 全盘只读</b></label>
          <span class="muted">C:\ D:\ 都能读（仍拒绝凭据类文件）</span>
        </div>
        <div class="row" style="align-items:center;gap:10px">
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="capExplore" /> <b>L4 探索模式</b></label>
          <span class="muted">命令执行 + 读写文件（危险，只能手动开）</span>
        </div>
        <div class="row"><button class="ghost" id="btnRefreshCaps">刷新</button><span class="muted" id="capsMeta"></span></div>
        <div id="capsPending" class="muted"></div>
      </div>
      <div class="card" id="workModeCard" style="border:1px solid #2e7d32">
        <h2>工作模式（像 Lead 一样干活）</h2>
        <div class="row" style="gap:12px;align-items:center">
          <label style="display:flex;align-items:center;gap:8px;font-size:16px">
            <input type="checkbox" id="workModeToggle" style="width:20px;height:20px" /> <b>打开工作模式</b>
          </label>
          <span class="muted" id="workModeMsg"></span>
        </div>
        <div class="muted" style="margin-top:8px">打开后她会换一套工具：<b>pwsh</b>（执行命令）、<b>read / write / edit</b>（读写改文件）、<b>glob / grep</b>（找文件搜内容）、<b>todo_write</b>（任务清单）。<br>会重建会话（当前对话上下文重开，印象和记忆库还在）。<br>建议配合：允许目录写进提示词（工作区为主）、紧急停止随时可用。</div>
      </div>
      <div class="card" id="panicCard">
        <h2>紧急停止</h2>
        <div class="row" style="gap:10px;align-items:center">
          <button id="btnPanic" style="background:#c0392b;color:#fff;border:none;padding:10px 18px;border-radius:8px;font-weight:700">⛔ 立即停止一切电脑能力</button>
          <button class="ghost" id="btnPanicReset">解除停止</button>
        </div>
        <div class="muted" id="panicBar" style="margin-top:8px"></div>
        <div class="muted" style="margin-top:4px">停止后：电脑操作 / 全盘只读 / 探索模式 / L5 全部失效，她也无法执行命令；正常聊天不受影响。</div>
      </div>
      <div class="card">
        <h2>L5 自主探索（她自己醒来逛电脑）</h2>
        <div class="row" style="gap:14px;align-items:center;flex-wrap:wrap">
          <label style="display:flex;align-items:center;gap:6px"><input type="radio" name="l5mode" value="off" /> 关</label>
          <label style="display:flex;align-items:center;gap:6px"><input type="radio" name="l5mode" value="readonly" /> <b>只读</b>（只能看，不能写）</label>
          <label style="display:flex;align-items:center;gap:6px"><input type="radio" name="l5mode" value="full" /> <b style="color:#c0392b">全自主</b>（可以写）</label>
        </div>
        <div class="row" style="margin-top:8px;gap:10px;flex-wrap:wrap">
          <label class="muted">时间点（逗号分隔，如 12:30,21:00）</label><input id="l5Times" style="width:220px" />
          <label class="muted">每天最多</label><input id="l5MaxRuns" type="number" min="1" max="12" style="width:70px" /> <span class="muted">次</span>
          <label class="muted">每次最多</label><input id="l5MaxSteps" type="number" min="3" max="60" style="width:70px" /> <span class="muted">步</span>
        </div>
        <div class="row" style="margin-top:8px;gap:10px;flex-wrap:wrap">
          <label class="muted">允许探索的目录（每行一个）</label>
        </div>
        <div class="row"><textarea id="l5Dirs" rows="3" style="width:100%" placeholder="D:\\课件&#10;C:\\Users\\<you>\\Documents"></textarea></div>
        <div class="row" style="margin-top:6px;gap:10px;align-items:center">
          <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="l5LongTask" /> 允许长任务（你指路后她可以连续干很多步）</label>
          <button id="btnL5Save">保存 L5 设置</button>
          <span class="muted" id="l5Msg"></span>
        </div>
        <div class="muted" style="margin-top:6px">只读模式：她能看、能读、能记，但不能写文件、不能改命令；全自主才有写权限。</div>
      </div>
      <div class="card">
        <h2>最近改动</h2>
        <div id="capsHistory" class="muted">（无）</div>
      </div>
    </section>

    <section id="tab-explore">
      <div class="card">
        <h2>她干了什么</h2>
        <div class="row"><button class="ghost" id="btnRefreshExplore">刷新</button><span class="muted" id="exploreMeta"></span></div>
        <div id="exploreBox" class="muted">加载中…</div>
      </div>
      <div class="card">
        <h2>命令记录（最近 120 条）</h2>
        <div id="exploreShell" class="muted">加载中…</div>
      </div>
    </section>

    <section id="tab-tasks">
      <div class="card">
        <h2>任务队列</h2>
        <div class="row"><button class="ghost" id="btnRefreshTasks">刷新</button><span class="muted" id="tasksMeta"></span></div>
        <div class="muted" style="margin-bottom:8px">长任务在这里跨轮推进（需要工作模式打开）。暂停/取消立刻生效。</div>
        <div id="tasksBox" class="muted">加载中…</div>
      </div>
    </section>

    <section id="tab-logs">
      <div class="card">
        <h2>桥接日志</h2>
        <div class="row"><button class="ghost" id="btnRefreshLog">刷新</button><span class="muted" id="logMeta"></span></div>
        <pre class="log" id="logBox">加载中…</pre>
      </div>
    </section>
  </div>
</main>
<div class="toast" id="toast"></div>
<script>
const token = new URLSearchParams(location.search).get('token') || localStorage.getItem('qqToken') || '';
if (token) localStorage.setItem('qqToken', token);
const state = { settings: null, meta: null };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
let toastTimer;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200); }
async function api(path, options = {}) {
  const r = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Token': token, ...(options.headers || {}) } });
  if (!r.ok) throw new Error((await r.text()).slice(0, 300) || ('HTTP ' + r.status));
  return r.json();
}
function setChip(id, text, ok) { const el = $(id); el.textContent = text; el.className = 'chip ' + (ok ? 'ok' : 'bad'); }
async function load() {
  const data = await api('/api/state');
  state.settings = data.settings; state.meta = data;
  render();
}
function render() {
  const s = state.settings, m = state.meta;
  setChip('chipDsh', 'DSH :' + (m.dshPort ?? '?'), !!m.dshPort);
  setChip('chipSnow', m.snowluma?.ws ? 'SnowLuma 在线' : 'SnowLuma 未连接', !!m.snowluma?.ws);
  setChip('chipBridge', m.bridge?.running ? '桥接运行中 (pid ' + m.bridge.pid + ')' : '桥接未运行', !!m.bridge?.running);
  setChip('chipMode', s.mode, true);
  $('overview').innerHTML =
    '<div class="grid2">' +
    '<div>模式：<b>' + esc(s.mode) + '</b><br>owner：' + esc(s.ownerQQ) + '<br>私聊白名单：' + (s.allowPrivate || []).length + ' 个</div>' +
    '<div>群白名单：' + (s.allowGroups || []).length + ' 个<br>人设：' + esc(s.persona?.name || '（关闭）') + '<br>注入上限：' + esc(s.roleMaxInjectChars) + '</div>' +
    '</div>' +
    '<div style="margin-top:10px">最近日志：<br><code>' + esc(m.logFile || '') + '</code></div>';
  const a = m.applied || {};
  $('applied').innerHTML = '<pre style="white-space:pre-wrap;margin:0">' + esc(JSON.stringify(a, null, 2)) + '</pre>';
  renderGroups(s);
  $('defaultTier').value = s.groupTierSlider ?? 95;
  $('defaultTierVal').textContent = String(s.groupTierSlider ?? 95) + ' · ' + tierLabel(s.groupTierSlider ?? 95);
  $('defaultKeywords').value = (s.tierKeywords || []).join('，');
  renderPersona(s);
  document.querySelectorAll('input[name=mode]').forEach((el) => { el.checked = el.value === s.mode; });
  $('ownerQQ').value = s.ownerQQ ?? '';
  $('allowPrivate').value = (s.allowPrivate || []).join('\n');
  $('modelName').value = s.model ?? 'deepseek-flash';
  $('reasoningEffort').value = s.reasoningEffort ?? 'off';
  $('roleMax').value = s.roleMaxInjectChars ?? 4000;
  $('sessionCwd').value = s.sessionCwd ?? '';
    $('desktopTools').checked = s.desktopTools === true;
}
function tierLabel(pos) { const p = Number(pos); if (p <= 10) return '仅@/叫名字'; if (p <= 20) return '加关键词'; if (p <= 90) return '概率 ' + Math.round((p - 20) / 70 * 100) + '%'; return '全响应'; }
function renderGroups(s) {
  const rows = [];
  const overrides = s.groupTierOverrides || {};
  const muted = new Set(s.groupMuted || []);
  for (const g of s.allowGroups || []) {
    const pos = overrides[g] ?? s.groupTierSlider ?? 95;
    rows.push('<tr data-group="' + esc(g) + '">' +
      '<td><b>' + esc(g) + '</b></td>' +
      '<td><input type="range" class="g-tier" min="0" max="100" step="1" value="' + esc(pos) + '" /> <span class="muted g-tier-val">' + pos + ' · ' + tierLabel(pos) + '</span></td>' +
      '<td><input type="text" class="g-kw" style="width:200px" value="' + esc((s.tierKeywords || []).join('，')) + '" /></td>' +
      '<td><input type="checkbox" class="g-mute" ' + (muted.has(String(g)) ? 'checked' : '') + ' /></td>' +
      '<td><button class="ghost g-del">移除</button></td></tr>');
  }
  $('groupRows').innerHTML = rows.join('') || '<tr><td colspan="5" class="muted">还没有群，添加一个吧</td></tr>';
  document.querySelectorAll('.g-tier').forEach((el) => el.addEventListener('input', () => {
    const td = el.closest('tr'); td.querySelector('.g-tier-val').textContent = el.value + ' · ' + tierLabel(el.value);
  }));
  document.querySelectorAll('.g-del').forEach((el) => el.addEventListener('click', () => {
    const group = el.closest('tr').dataset.group;
    state.settings.allowGroups = (state.settings.allowGroups || []).filter((g) => String(g) !== group);
    delete (state.settings.groupTierOverrides || {})[group];
    renderGroups(state.settings);
  }));
}
function renderPersona(s) {
  const options = ['助手'];
  const sel = $('personaSelect');
  sel.innerHTML = options.map((n) => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('') + '<option value="__off">（关闭角色扮演）</option>';
  sel.value = s.persona?.name || '__off';
  $('personaFile').value = s.persona?.file || '';
  $('personaText').value = s.persona?.text || '';
  $('personaMeta').textContent = '人设卡：' + (s.persona?.file || '（内联文本）') + '；卡片也可放到 ~/.dsh/qq-personal/personas/<名字>.md';
}
function collect() {
  const s = JSON.parse(JSON.stringify(state.settings));
  s.groupTierSlider = Number($('defaultTier').value);
  s.tierKeywords = $('defaultKeywords').value.split(/[，,]/).map((x) => x.trim()).filter(Boolean);
  s.mode = document.querySelector('input[name=mode]:checked')?.value || 'chat';
  s.ownerQQ = Number($('ownerQQ').value) || null;
  s.allowPrivate = $('allowPrivate').value.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
  s.model = $('modelName').value.trim();
  s.reasoningEffort = $('reasoningEffort').value;
  s.roleMaxInjectChars = Number($('roleMax').value) || 4000;
  s.sessionCwd = $('sessionCwd').value.trim();
    s.desktopTools = $('desktopTools').checked;
  s.groupTierOverrides = s.groupTierOverrides || {};
  s.groupMuted = [];
  const allow = [];
  document.querySelectorAll('#groupRows tr[data-group]').forEach((tr) => {
    const g = tr.dataset.group; allow.push(Number(g));
    s.groupTierOverrides[g] = Number(tr.querySelector('.g-tier').value);
    if (tr.querySelector('.g-mute').checked) s.groupMuted.push(g);
  });
  s.allowGroups = allow;
  const p = $('personaSelect').value;
  const file = $('personaFile').value.trim();
  const text = $('personaText').value;
  s.persona = p === '__off' && !file && !text.trim() ? { name: '', file: '', text: '' } : { name: p === '__off' ? '' : p, file: file || (p === '助手' ? state.settings.persona?.file || '' : ''), text };
  return s;
}
async function save() {
  const s = collect();
    // 模式改动是破坏性的（要重启桥接并重建会话），必须二次确认。
    const prevMode = (state.settings && state.settings.mode) || 'chat';
    if (s.mode !== prevMode) {
      const label = {
        chat: 'chat（白名单聊天）',
        'closed-agent': 'closed-agent（仅 owner 私聊）',
        reserved: 'reserved（一代仿真）',
        reserved2: 'reserved2（二代仿真）'
      };
      const ok = window.confirm('模式将从「' + (label[prevMode] || prevMode) + '」改为「' + (label[s.mode] || s.mode) + '」。\n\n这会重启桥接并建立新会话，当前聊天上下文会重置（长期印象保留）。\n确定要改吗？');
      if (!ok) { toast('已取消：模式未修改'); return; }
    }
  await api('/api/settings', { method: 'POST', body: JSON.stringify(s) });
  toast('已保存，正在重启桥接…');
  setTimeout(load, 1500);
}
async function restart() { await api('/api/restart', { method: 'POST', body: '{}' }); toast('桥接重启中…'); setTimeout(load, 1500); }
function fmtMoney(v) { return '¥' + (Number(v) || 0).toFixed(4); }
function fmtInt(v) { return (Number(v) || 0).toLocaleString('en-US'); }
async function loadCost() {
  const box = $('costBox');
  const table = $('costTable');
  if (!box) return;
  box.textContent = '加载中…';
  try {
    const d = await api('/api/cost');
    if (d.error) { box.textContent = d.error; if (table) table.textContent = '—'; return; }
    const today = d.today || {};
    const last = d.last;
    box.innerHTML =
      '<div style="display:flex;gap:24px;flex-wrap:wrap">' +
        '<div><div class="muted">今日花费</div><div style="font-size:22px"><b>' + fmtMoney(today.cost) + '</b></div></div>' +
        '<div><div class="muted">今日步骤</div><div style="font-size:22px">' + fmtInt(today.steps) + '</div></div>' +
        '<div><div class="muted">平均每步</div><div style="font-size:22px">' + fmtMoney(today.avg) + '</div></div>' +
        '<div><div class="muted">余额</div><div style="font-size:22px">' + (d.balance == null ? '—' : '¥' + Number(d.balance).toFixed(2)) + '</div></div>' +
      '</div>' +
      '<div class="muted" style="margin-top:10px">今日输入未命中 ' + fmtInt(today.miss) + ' · 命中 ' + fmtInt(today.hit) + ' · 输出 ' + fmtInt(today.out) + ' tokens' +
        (last ? '；最近一步 ' + fmtMoney(last.cost) + '（' + new Date(last.at).toLocaleTimeString() + '）' : '') + '</div>' +
      '<div class="muted" style="margin-top:6px">' + esc(d.note || '') + '</div>';
    if (table) {
      if (!d.days || !d.days.length) table.textContent = '还没有记录';
      else {
        const rows = d.days.map(function (x) {
          return '<tr><td>' + esc(x.date) + '</td><td>' + fmtMoney(x.cost) + '</td><td>' + fmtInt(x.steps) + '</td><td>' + fmtInt(x.miss) + '</td><td>' + fmtInt(x.hit) + '</td><td>' + fmtInt(x.out) + '</td></tr>';
        }).join('');
        table.innerHTML = '<table><thead><tr><th>日期</th><th>花费</th><th>步骤</th><th>未命中</th><th>命中</th><th>输出</th></tr></thead><tbody>' + rows + '</tbody></table>';
      }
    }
    if ($('costMeta')) $('costMeta').textContent = '价格：命中 ¥0.02 / 未命中 ¥1 / 输出 ¥4（每百万 token）';
  } catch (e) {
    box.textContent = '读取失败：' + (e && e.message ? e.message : e);
  }
}

function fmtTok(v) { const n = Number(v) || 0; return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
async function loadSessions() {
  const box = $('sessionsBox');
  if (!box) return;
  box.textContent = '加载中…';
  try {
    const d = await api('/api/sessions');
    if (d.error) { box.textContent = d.error; return; }
    const list = d.list || [];
    if (!list.length) { box.textContent = '还没有会话记录'; return; }
    const rows = list.map(function (s) {
      const when = s.lastAt ? new Date(s.lastAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
      return '<div class="card" style="margin:0 0 10px;padding:12px 14px">' +
        '<div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline">' +
          '<b>' + esc(s.label) + '</b><span class="muted">' + esc(when) + '</span></div>' +
        '<div class="muted" style="margin:6px 0">' + (s.summary ? esc(s.summary) : '（无消息摘要）') + '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;font-size:12px">' +
          '<span class="chip ok">' + fmtTok(s.tokens) + ' tok</span>' +
          '<span class="chip">' + (s.rounds || 0) + ' 轮</span>' +
          '<span class="chip">¥' + (Number(s.cost) || 0).toFixed(4) + '</span>' +
          (s.unread ? '<span class="chip bad">未读 ' + s.unread + '</span>' : '') +
          (s.mode ? '<span class="chip">' + esc(s.mode) + (s.preset ? ' · ' + esc(s.preset) : '') + '</span>' : '') +
        '</div></div>';
    }).join('');
    const t = d.total || {};
    box.innerHTML = '<div class="muted" style="margin-bottom:10px">合计 ' + fmtTok(t.tokens) + ' tok · ' + (t.rounds || 0) + ' 轮 · ¥' + (Number(t.cost) || 0).toFixed(4) + '</div>' + rows;
    if ($('sessionsMeta')) $('sessionsMeta').textContent = d.note || '';
  } catch (e) {
    box.textContent = '读取失败：' + (e && e.message ? e.message : e);
  }
}

function memTime(t) { return new Date(Number(t) || Date.now()).toLocaleString('zh-CN', { hour12: false }); }
async function loadMemory(q) {
  const box = $('memoryBox');
  if (!box) return;
  box.textContent = '加载中…';
  try {
    const url = '/api/memory' + (q ? '?q=' + encodeURIComponent(q) : '');
    const d = await api(url);
    if (d.error) { box.textContent = d.error; return; }
    let stats = {};
    try { stats = await api('/api/memory/stats'); } catch (e) { stats = {}; }
    if ($('memoryMeta')) $('memoryMeta').textContent = stats.count === undefined ? '' : ('共 ' + stats.count + ' 条 · ' + (stats.sizeKB || 0) + ' KB · ' + (stats.file || ''));
    const list = d.memories || [];
    if (!list.length) { box.textContent = q ? '没搜到相关记忆' : '记忆库还是空的'; return; }
    box.innerHTML = list.map(function (m) {
      return '<div class="card" style="margin:0 0 10px;padding:12px 14px">' +
        '<div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline">' +
          '<b>' + esc(m.kind || '事件') + ' · 权重' + (m.weight || 3) + '</b><span class="muted">' + memTime(m.at) + '</span></div>' +
        '<div style="margin:6px 0">' + esc(m.text) + '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;font-size:12px;align-items:center">' +
          (m.tags || []).map(function (tg) { return '<span class="chip">' + esc(tg) + '</span>'; }).join('') +
          '<span class="chip">被想起 ' + (m.uses || 0) + ' 次</span>' +
          '<button class="ghost" data-memdel="' + esc(m.id) + '">删除</button>' +
        '</div></div>';
    }).join('');
    Array.from(box.querySelectorAll('[data-memdel]')).forEach(function (btn) {
      btn.addEventListener('click', async function () {
        if (!window.confirm('确定删除这条记忆？删了不可恢复。')) return;
        try { await api('/api/memory/forget', { method: 'POST', body: JSON.stringify({ id: btn.getAttribute('data-memdel') }) }); await loadMemory(q); toast('已删除'); }
        catch (e) { toast('删除失败：' + e.message); }
      });
    });
  } catch (e) {
    box.textContent = '读取失败：' + (e && e.message ? e.message : e);
  }
}
async function addMemory() {
  const text = ($('memText') && $('memText').value || '').trim();
  if (!text) { toast('先写点内容'); return; }
  const weight = Number(($('memWeight') && $('memWeight').value) || 3);
  const tags = ($('memTags') && $('memTags').value || '').split(/[,，、]/).map(function (s) { return s.trim(); }).filter(Boolean);
  try {
    const r = await api('/api/memory/add', { method: 'POST', body: JSON.stringify({ text: text, weight: weight, tags: tags, kind: '事件' }) });
    if ($('memAddMsg')) $('memAddMsg').textContent = r && r.deduped ? '已合并到已有记忆' : '已存入';
    if ($('memText')) $('memText').value = '';
    await loadMemory($('memQuery') ? $('memQuery').value.trim() : '');
  } catch (e) { toast('存入失败：' + e.message); }
}

async function loadCaps() {
  try { const st = await api('/api/state'); if ($('workModeToggle')) $('workModeToggle').checked = st.settings?.workMode === true; } catch (e) { /* ignore */ }
  try {
    const c = await api('/api/capabilities');
    if ($('capDesktop')) $('capDesktop').checked = c.desktop === true;
    if ($('capFullRead')) $('capFullRead').checked = c.fullRead === true;
    if ($('capExplore')) $('capExplore').checked = c.explore === true;
    if ($('l5Times')) $('l5Times').value = ((c.l5 && c.l5.times) || []).join(',');
    if ($('l5MaxRuns')) $('l5MaxRuns').value = (c.l5 && c.l5.maxRunsPerDay) || 3;
    if ($('l5MaxSteps')) $('l5MaxSteps').value = (c.l5 && c.l5.maxSteps) || 12;
    if ($('l5Dirs')) $('l5Dirs').value = ((c.l5 && c.l5.dirs) || []).join('\n');
    if ($('l5LongTask')) $('l5LongTask').checked = !!(c.l5 && c.l5.longTask);
    Array.from(document.querySelectorAll('input[name="l5mode"]')).forEach(function (el) { el.checked = el.value === (c.autonomous || 'off'); });
    if ($('workModeToggle')) $('workModeToggle').checked = c.workMode === true;
    if ($('panicBar')) $('panicBar').textContent = c.panic ? ('⛔ 紧急停止中（' + new Date(c.panic).toLocaleString('zh-CN', { hour12: false }) + '），点右边按钮解除') : '当前没有紧急停止';
    const on = [];
    if (c.desktop) on.push('L2 电脑操作');
    if (c.fullRead) on.push('L3 全盘只读');
    if (c.explore) on.push('L4 探索模式');
    if ($('capsMeta')) $('capsMeta').textContent = on.length ? ('当前开启：' + on.join(' / ')) : '当前全部关闭（她只能读桌面/文档/下载/工作区）';
    if ($('capsPending')) {
      $('capsPending').innerHTML = c.pending
        ? ('<div class="chip bad" style="margin-right:8px">等待批准：' + esc(c.pending.name) + '</div>' +
           '<button id="btnCapApprove">允许</button> <button class="ghost" id="btnCapDeny">拒绝</button>' +
           '<div class="muted" style="margin-top:6px">她申请的理由：' + esc(c.pending.note || '（没写）') + '</div>')
        : '<span class="muted">没有待批准的申请</span>';
      if ($('btnCapApprove')) $('btnCapApprove').addEventListener('click', async () => {
        await api('/api/capabilities', { method: 'POST', body: JSON.stringify({ action: 'approve', by: 'console' }) });
        toast('已允许'); loadCaps().catch(() => {});
      });
      if ($('btnCapDeny')) $('btnCapDeny').addEventListener('click', async () => {
        await api('/api/capabilities', { method: 'POST', body: JSON.stringify({ action: 'deny', by: 'console' }) });
        toast('已拒绝'); loadCaps().catch(() => {});
      });
    }
    if ($('capsHistory')) {
      const h = (c.history || []).slice().reverse().slice(0, 10);
      $('capsHistory').innerHTML = h.length
        ? h.map(function (x) {
            return '<div class="muted">' + esc((x.at || '').replace('T', ' ').slice(0, 16)) + ' · ' + esc(x.name) + ' → ' + (x.value ? '开' : '关') + ' · ' + esc(x.by || '') + (x.note ? ' · ' + esc(x.note) : '') + '</div>';
          }).join('')
        : '<span class="muted">（无）</span>';
    }
  } catch (e) {
    if ($('capsMeta')) $('capsMeta').textContent = '读取失败：' + (e && e.message ? e.message : e);
  }
}
async function setCap(name, value) {
  if (name === 'explore' && value) {
    if (!window.confirm('L4 探索模式 = 她可以执行命令、读写任意文件。确定要开？')) return;
  }
  try {
    await api('/api/capabilities', { method: 'POST', body: JSON.stringify({ name: name, value: value, by: 'console' }) });
    toast((value ? '已开启 ' : '已关闭 ') + name);
    loadCaps().catch(() => {});
  } catch (e) { toast('切换失败：' + e.message); loadCaps().catch(() => {}); }
}

async function loadExplore() {
  const box = $('exploreBox');
  if (!box) return;
  box.textContent = '加载中…';
  try {
    const d = await api('/api/explore');
    if (d.error) { box.textContent = d.error; return; }
    const c = d.capabilities || {};
    const on = [];
    if (c.panic) on.push('⛔ 紧急停止中');
    if (c.desktop) on.push('L2 电脑操作');
    if (c.fullRead) on.push('L3 全盘只读');
    if (c.explore) on.push('L4 探索模式');
    if (c.autonomous === 'readonly') on.push('L5 只读自主');
    if (c.autonomous === 'full') on.push('L5 全自主');
    if ($('exploreMeta')) $('exploreMeta').textContent = on.length ? on.join(' / ') : '当前所有能力关闭';
    const runs = d.runs || [];
    if (!runs.length) { box.textContent = '还没有自主探索记录（L5 开着的时候才会产生）'; }
    else {
      box.innerHTML = runs.slice(0, 60).map(function (r) {
        const when = (r.at || '').replace('T', ' ').slice(0, 16);
        if (r.kind === 'start') {
          return '<div class="card" style="margin:0 0 8px;padding:10px 12px"><b>开始探索</b> <span class="muted">' + esc(when) + ' · ' + esc(r.mode || '') + ' · ' + esc(r.time || '') + '</span><div class="muted">目录：' + esc((r.dirs || []).join(' ; ') || '（无）') + '</div></div>';
        }
        return '<div class="card" style="margin:0 0 8px;padding:10px 12px"><b>结束</b> <span class="muted">' + esc(when) + ' · ' + esc(r.mode || '') + ' · ' + (r.steps || 0) + ' 步 · ' + (r.seconds || 0) + ' 秒</span></div>';
      }).join('');
    }
    const shell = d.shellLog || [];
    if ($('exploreShell')) {
      $('exploreShell').innerHTML = shell.length
        ? shell.slice(0, 120).map(function (x) {
            const when = (x.at || '').replace('T', ' ').slice(0, 19);
            const kind = x.kind || 'run';
            const txt = String(x.text || x.raw || '').slice(0, 160);
            const bad = kind.indexOf('denied') >= 0;
            return '<div style="margin:2px 0;' + (bad ? 'color:#e67e22' : '') + '"><span class="muted">' + esc(when) + '</span> ' + esc(kind) + ' · ' + esc(txt) + '</div>';
          }).join('')
        : '<span class="muted">（还没有命令记录）</span>';
    }
  } catch (e) {
    box.textContent = '读取失败：' + (e && e.message ? e.message : e);
  }
}
async function saveL5() {
  const mode = (document.querySelector('input[name="l5mode"]:checked') || {}).value || 'off';
  const times = ($('l5Times').value || '').split(/[,，\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  const dirs = ($('l5Dirs').value || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  const patch = {
    autonomous: mode,
    times: times,
    dirs: dirs,
    maxRunsPerDay: Number($('l5MaxRuns').value) || 3,
    maxSteps: Number($('l5MaxSteps').value) || 12,
    longTask: !!$('l5LongTask').checked,
  };
  if (mode === 'full' && !window.confirm('全自主 = 她可以自己写文件、跑命令。确定？')) return;
  try {
    await api('/api/l5', { method: 'POST', body: JSON.stringify({ patch: patch, by: 'console' }) });
    if ($('l5Msg')) $('l5Msg').textContent = '已保存';
    loadCaps().catch(function () {});
  } catch (e) { if ($('l5Msg')) $('l5Msg').textContent = '保存失败：' + e.message; }
}
async function panicNowUI() {
  if (!window.confirm('立刻停止她所有电脑能力？（电脑操作/全盘只读/探索/L5 全部关闭）')) return;
  try {
    await api('/api/panic', { method: 'POST', body: JSON.stringify({ reason: '管理台紧急停止' }) });
    toast('已紧急停止');
    loadCaps().catch(function () {});
  } catch (e) { toast('停止失败：' + e.message); }
}
async function panicResetUI() {
  try {
    await api('/api/panic', { method: 'POST', body: JSON.stringify({ reset: true }) });
    toast('已解除紧急停止（各项能力仍是关，需要手动打开）');
    loadCaps().catch(function () {});
  } catch (e) { toast('解除失败：' + e.message); }
}

const TASK_STATUS = { pending: '待开始', running: '进行中', paused: '暂停', done: '完成', failed: '失败', cancelled: '取消' };
async function loadTasks() {
  const box = $('tasksBox');
  if (!box) return;
  box.textContent = '加载中…';
  try {
    const d = await api('/api/tasks');
    if (d.error) { box.textContent = d.error; return; }
    const st = d.stats || {};
    if ($('tasksMeta')) $('tasksMeta').textContent = '共 ' + (st.total || 0) + ' 个 · 进行中 ' + (st.active || 0) + ' 个';
    const list = d.tasks || [];
    if (!list.length) { box.textContent = '还没有任务。工作模式打开后，让她 task_create 建任务就行。'; return; }
    box.innerHTML = list.map(function (t) {
      const done = (t.steps || []).filter(function (s) { return s.done; }).length;
      const steps = (t.steps || []).map(function (s) {
        return '<div class="muted">' + (s.done ? '✅' : '⬜') + ' ' + s.n + '. ' + esc(s.text) + '</div>';
      }).join('');
      const prog = (t.progress || []).slice(-4).map(function (p) {
        return '<div class="muted">· ' + esc(String(p.text).slice(0, 120)) + '</div>';
      }).join('');
      const act = t.status === 'paused' ? '<button data-tact="resume" data-id="' + t.id + '">继续</button>'
        : (t.status === 'pending' || t.status === 'running') ? '<button class="ghost" data-tact="pause" data-id="' + t.id + '">暂停</button>' : '';
      const cancel = ['done', 'cancelled'].includes(t.status) ? '' : '<button class="ghost" data-tact="cancel" data-id="' + t.id + '">取消</button>';
      return '<div class="card" style="margin:0 0 10px;padding:12px 14px">' +
        '<div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline">' +
          '<b>#' + t.id + ' ' + esc(t.title) + '</b>' +
          '<span class="chip">' + (TASK_STATUS[t.status] || t.status) + '</span></div>' +
        '<div class="muted" style="margin:6px 0">' + esc(t.goal || '') + '</div>' +
        '<div class="muted">轮次 ' + (t.rounds || 0) + '/' + (t.maxRounds || 0) + ' · 步骤 ' + done + '/' + (t.steps || []).length + '</div>' +
        '<div style="margin:6px 0">' + steps + '</div>' +
        '<div>' + prog + '</div>' +
        (t.result ? '<div style="margin-top:6px">结果：' + esc(t.result) + '</div>' : '') +
        '<div class="row" style="margin-top:8px;gap:8px">' + act + cancel + '</div></div>';
    }).join('');
    Array.from(box.querySelectorAll('[data-tact]')).forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const action = btn.getAttribute('data-tact');
        const id = btn.getAttribute('data-id');
        if (action === 'cancel' && !window.confirm('取消任务 #' + id + '？')) return;
        try { await api('/api/tasks/action', { method: 'POST', body: JSON.stringify({ action: action, id: id }) }); await loadTasks(); }
        catch (e) { toast('操作失败：' + e.message); }
      });
    });
  } catch (e) {
    box.textContent = '读取失败：' + (e && e.message ? e.message : e);
  }
}

async function refreshLog() {
  const data = await api('/api/log?lines=300');
  $('logBox').textContent = data.text || '（空）';
  $('logMeta').textContent = data.file || '';
}
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.tab === 'cost') loadCost();
  if (b.dataset.tab === 'sessions') loadSessions();
  if (b.dataset.tab === 'memory') loadMemory('');
  if (b.dataset.tab === 'caps') loadCaps();
  if (b.dataset.tab === 'explore') loadExplore();
  if (b.dataset.tab === 'tasks') loadTasks();
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + b.dataset.tab));
}));
$('btnAddGroup').addEventListener('click', () => {
  const g = $('newGroup').value.trim(); if (!/^\d{5,12}$/.test(g)) return toast('群号看起来不对');
  state.settings.allowGroups = [...new Set([...(state.settings.allowGroups || []).map(Number), Number(g)])];
  $('newGroup').value = ''; renderGroups(state.settings);
});
$('btnSave').addEventListener('click', () => save().catch((e) => toast('保存失败：' + e.message)));
$('btnRestart').addEventListener('click', () => restart().catch((e) => toast('重启失败：' + e.message)));
$('btnRefreshLog').addEventListener('click', () => refreshLog().catch((e) => toast('读取失败：' + e.message)));
$('defaultTier').addEventListener('input', () => { $('defaultTierVal').textContent = $('defaultTier').value + ' · ' + tierLabel($('defaultTier').value); });
$('btnRefreshSessions').addEventListener('click', () => loadSessions().catch((e) => toast('读取失败：' + e.message)));
$('btnRefreshMemory').addEventListener('click', () => loadMemory($('memQuery').value.trim()).catch((e) => toast('读取失败：' + e.message)));
$('btnMemSearch').addEventListener('click', () => loadMemory($('memQuery').value.trim()).catch((e) => toast('读取失败：' + e.message)));
$('btnMemClear').addEventListener('click', () => { $('memQuery').value = ''; loadMemory('').catch((e) => toast('读取失败：' + e.message)); });
$('btnMemAdd').addEventListener('click', () => addMemory().catch((e) => toast('存入失败：' + e.message)));
$('btnRefreshCaps').addEventListener('click', () => loadCaps());
$('capDesktop').addEventListener('change', () => setCap('desktop', $('capDesktop').checked));
$('capFullRead').addEventListener('change', () => setCap('fullRead', $('capFullRead').checked));
$('capExplore').addEventListener('change', () => setCap('explore', $('capExplore').checked));
$('btnRefreshExplore').addEventListener('click', () => loadExplore());
$('btnPanic').addEventListener('click', panicNowUI);
$('btnPanicReset').addEventListener('click', panicResetUI);
$('btnL5Save').addEventListener('click', saveL5);
$('workModeToggle').addEventListener('change', async function () {
  const on = $('workModeToggle').checked;
  if (on && !window.confirm('打开工作模式？她会获得命令执行 + 读写文件能力，并且会话会重建。')) { $('workModeToggle').checked = false; return; }
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ workMode: on }) });
    if ($('workModeMsg')) $('workModeMsg').textContent = on ? '已打开，正在重启桥接…' : '已关闭，正在重启桥接…';
    await api('/api/restart', { method: 'POST' });
    if ($('workModeMsg')) $('workModeMsg').textContent = on ? '工作模式已开（会话已重建）' : '工作模式已关';
  } catch (e) { toast('切换失败：' + e.message); }
});
$('btnRefreshTasks').addEventListener('click', () => loadTasks());
load().catch((e) => { document.body.innerHTML = '<p style="padding:24px;color:#ff6b6b">无法连接管理 API：' + esc(e.message) + '</p>'; });
</script>
</body>
</html>`;

/**
 * Start the management console.
 *
 * @param {object} options
 * @param {number} options.port - loopback port (default 3101).
 * @param {string} options.token - required request token.
 * @param {() => Promise<object>} options.getState - returns the state object.
 * @param {(settings: object) => Promise<void>} options.saveSettings
 * @param {() => Promise<void>} options.restartBridge
 * @param {(lines: number) => Promise<{text: string, file: string}>} options.logTail
 * @param {(message: string) => void} [options.log]
 * @returns {{ close: () => Promise<void>, port: number }}
 */
function startConsole(options) {
  const { port, token, getState, saveSettings, restartBridge, logTail, log = () => {}, costInfo, sessionsInfo, memoryStats, memoryList, memorySearch, memoryAdd, memoryUpdate, memoryForget, capabilityInfo, capabilitySet, l5Set, panicNow, panicReset, exploreActivity, tasksInfo, tasksAction } = options;
  const authorized = (req, url) => {
    if (token.length === 0) return true;
    const header = req.headers['x-token'];
    if (typeof header === 'string' && header === token) return true;
    return url.searchParams.get('token') === token;
  };

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return send(res, 400, 'bad url');
    }
    if (!authorized(req, url)) return send(res, 401, 'unauthorized');

    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, PAGE, 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const state = await getState();
        return send(res, 200, JSON.stringify(state));
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        await saveSettings(parsed);
        return send(res, 200, JSON.stringify({ ok: true }));
      }
      if (req.method === 'POST' && url.pathname === '/api/restart') {
        await restartBridge();
        return send(res, 200, JSON.stringify({ ok: true }));
      }
      if (req.method === 'GET' && url.pathname === '/api/tasks') {
        const data = typeof tasksInfo === 'function' ? await tasksInfo() : { error: 'tasksInfo 未注入' };
        return send(res, 200, JSON.stringify(data));
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks/action') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const data = typeof tasksAction === 'function' ? await tasksAction(body) : { error: 'tasksAction 未注入' };
        return send(res, 200, JSON.stringify({ ok: true, task: data }));
      }
      if (req.method === 'GET' && url.pathname === '/api/explore') {
        const data = typeof exploreActivity === 'function' ? await exploreActivity() : { error: 'exploreActivity 未注入' };
        return send(res, 200, JSON.stringify(data));
      }
      if (req.method === 'POST' && url.pathname === '/api/l5') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const data = typeof l5Set === 'function' ? await l5Set(body) : { error: 'l5Set 未注入' };
        return send(res, 200, JSON.stringify({ ok: true, capabilities: data }));
      }
      if (req.method === 'POST' && url.pathname === '/api/panic') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const data = body.reset === true
          ? await panicReset()
          : await panicNow({ reason: body.reason || '管理台紧急停止', by: 'console' });
  // [patch] 紧急停止同时关闭工作模式（否则 pwsh/读写文件还能用）
  if (body.reset !== true) { try { await saveSettings({ workMode: false }); } catch { /* ignore */ } }
        return send(res, 200, JSON.stringify({ ok: true, capabilities: data }));
      }
      if (req.method === 'GET' && url.pathname === '/api/capabilities') {
        const data = typeof capabilityInfo === 'function' ? await capabilityInfo() : { error: 'capabilityInfo 未注入' };
        return send(res, 200, JSON.stringify(data));
      }
      if (req.method === 'POST' && url.pathname === '/api/capabilities') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const data = typeof capabilitySet === 'function' ? await capabilitySet(body) : { error: 'capabilitySet 未注入' };
        return send(res, 200, JSON.stringify({ ok: true, capabilities: data }));
      }
      if (req.method === 'GET' && url.pathname === '/api/memory') {
        const q = url.searchParams.get('q') || '';
        const limit = Number(url.searchParams.get('limit')) || 50;
        const data = q
          ? await (typeof memorySearch === 'function' ? memorySearch({ query: q, limit }) : { error: 'memorySearch 未注入' })
          : await (typeof memoryList === 'function' ? memoryList({ limit }) : { error: 'memoryList 未注入' });
        return send(res, 200, JSON.stringify(data));
      }
      if (req.method === 'GET' && url.pathname === '/api/memory/stats') {
        const data = typeof memoryStats === 'function' ? await memoryStats() : { error: 'memoryStats 未注入' };
        return send(res, 200, JSON.stringify(data));
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/memory/')) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const action = url.pathname.slice('/api/memory/'.length);
        let data;
        if (action === 'add' && typeof memoryAdd === 'function') data = await memoryAdd(body);
        else if (action === 'update' && typeof memoryUpdate === 'function') data = await memoryUpdate(body);
        else if (action === 'forget' && typeof memoryForget === 'function') data = await memoryForget(body);
        else return send(res, 404, JSON.stringify({ ok: false, error: 'unknown action' }));
        return send(res, 200, JSON.stringify(data));
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        const data = typeof sessionsInfo === 'function' ? await sessionsInfo() : { error: 'sessionsInfo 未注入' };
        return send(res, 200, JSON.stringify(data));
      }
      if (req.method === 'GET' && url.pathname === '/api/cost') {
        const data = typeof costInfo === 'function' ? await costInfo() : { error: 'costInfo 未注入' };
        return send(res, 200, JSON.stringify(data));
      }
      if (req.method === 'GET' && url.pathname === '/api/log') {
        const lines = Math.min(2000, Math.max(20, Number(url.searchParams.get('lines')) || 200));
        return send(res, 200, JSON.stringify(await logTail(lines)));
      }
      return send(res, 404, 'not found');
    } catch (error) {
      log(`console: ${req.method} ${url.pathname} failed: ${error?.message ?? error}`);
      return send(res, 500, JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
    }
  });

  let listening = false;
  server.on('error', (error) => {
    if (!listening) log(`console: cannot listen on 127.0.0.1:${port} (${error.message}) — is another console running?`);
  });
  server.listen(port, '127.0.0.1', () => {
    listening = true;
    log(`console: management window at http://127.0.0.1:${port}/?token=…`);
  });

  return {
    port,
    close: () => new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    }),
  };
}

module.exports = { startConsole, PAGE };
