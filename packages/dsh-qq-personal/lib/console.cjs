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
const fsx = require('node:fs');
const pathx = require('node:path');
const osx = require('node:os');

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
    /* ── 视觉增强 ─────────────────────────────── */
    :root {
      --bg:#0b0d12; --bg2:#0f1219; --card:#141822; --card2:#171c27; --line:#232a38;
      --fg:#e8ecf4; --dim:#8b95a8; --accent:#5b8cff; --accent2:#7aa2ff;
      --ok:#3ecf8e; --bad:#ff6b6b; --warn:#f5b94a;
      --shadow:0 6px 24px rgba(0,0,0,.35);
    }
    body {
      background:
        radial-gradient(1200px 600px at 15% -10%, rgba(91,140,255,.10), transparent 60%),
        radial-gradient(900px 500px at 110% 0%, rgba(126,87,255,.08), transparent 55%),
        var(--bg);
      min-height:100vh;
    }
    header {
      background:linear-gradient(180deg, rgba(19,23,32,.96), rgba(15,18,25,.92));
      backdrop-filter: blur(10px);
      border-bottom:1px solid var(--line);
      box-shadow:0 1px 0 rgba(255,255,255,.03), 0 8px 24px rgba(0,0,0,.25);
    }
    .brand { display:flex; flex-direction:column; gap:1px; }
    .brand h1 { letter-spacing:.02em; }
    .brand .sub { font-size:11px; color:var(--dim); }
    .chip {
      display:inline-flex; align-items:center; gap:6px;
      background:rgba(255,255,255,.03); border:1px solid var(--line);
      transition:border-color .15s ease, color .15s ease, background .15s ease;
    }
    .chip::before { content:''; width:6px; height:6px; border-radius:50%; background:currentColor; opacity:.65; }
    .chip.ver { color:var(--accent2); border-color:rgba(91,140,255,.35); background:rgba(91,140,255,.08); }
    .chip.ver::before { display:none; }
    .chip.ok { background:rgba(62,207,142,.08); }
    .chip.bad { background:rgba(255,107,107,.08); }
    main { max-width:1240px; }
    nav { gap:4px; }
    nav button {
      position:relative; border-radius:10px; padding:10px 13px;
      transition:background .15s ease, color .15s ease, transform .06s ease;
    }
    nav button:hover { transform:translateX(2px); }
    nav button.active {
      background:linear-gradient(90deg, rgba(91,140,255,.16), rgba(91,140,255,.04));
      border-color:rgba(91,140,255,.35);
      color:#fff;
    }
    nav button.active::after {
      content:''; position:absolute; left:0; top:20%; bottom:20%;
      width:3px; border-radius:3px; background:var(--accent);
    }
    section.active { animation:fadeIn .18s ease; }
    @keyframes fadeIn { from { opacity:0; transform:translateY(3px); } to { opacity:1; transform:none; } }
    .card {
      background:linear-gradient(180deg, var(--card), var(--card2));
      border:1px solid var(--line);
      border-radius:14px;
      padding:18px 20px;
      box-shadow:var(--shadow);
      transition:border-color .15s ease;
    }
    .card:hover { border-color:#2c3547; }
    .card h2 { display:flex; align-items:center; gap:8px; font-size:14.5px; letter-spacing:.01em; }
    .card h2::before { content:''; width:3px; height:14px; border-radius:2px; background:var(--accent); opacity:.8; }
    table tbody tr { transition:background .12s ease; }
    table tbody tr:hover { background:rgba(255,255,255,.02); }
    th { text-transform:uppercase; letter-spacing:.06em; font-size:11px; }
    button.primary {
      background:linear-gradient(180deg, var(--accent2), var(--accent));
      box-shadow:0 4px 14px rgba(91,140,255,.28);
      transition:transform .06s ease, box-shadow .15s ease, filter .15s ease;
    }
    button.primary:hover { filter:brightness(1.06); box-shadow:0 6px 18px rgba(91,140,255,.36); }
    button.primary:active { transform:translateY(1px); }
    button.ghost { transition:background .15s ease, border-color .15s ease; }
    button.ghost:hover { background:#242b38; border-color:#323c4f; }
    input[type=text], input[type=number], textarea, select { border-radius:9px; transition:border-color .15s ease, box-shadow .15s ease; }
    input[type=text]:focus, input[type=number]:focus, textarea:focus, select:focus {
      outline:none; border-color:rgba(91,140,255,.55); box-shadow:0 0 0 3px rgba(91,140,255,.12);
    }
    pre.log { background:#090b10; border-radius:12px; }
    ::-webkit-scrollbar { width:10px; height:10px; }
    ::-webkit-scrollbar-thumb { background:#2a3242; border-radius:8px; border:2px solid var(--bg); }
    ::-webkit-scrollbar-track { background:transparent; }
</style>
</head>
<body>
<header>
  <div class="brand">
    <h1>QQ 管理台</h1>
    <span class="sub">原生链路 · made for DSH</span>
  </div>
  <span class="chip ver" id="chipVersion">v …</span>
  <span class="chip" id="chipDsh">DSH …</span>
  <span class="chip" id="chipSnow">SnowLuma …</span>
  <span class="chip" id="chipBridge">桥接 …</span>
  <span class="chip" id="chipMode">模式 …</span>
  <span class="spacer"></span>
  <button class="ghost" id="btnRestart">重连 QQ</button>
  <button class="primary" id="btnSave">保存设置</button>
</header>
<main>
  <nav>
    <button data-tab="overview" class="active">总览</button>
    <button data-tab="groups">群聊（未启用）</button>
    <button data-tab="persona">人设</button>
    <button data-tab="mode">原生链路</button>
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
        <div class="muted" style="margin:8px 0 12px">⚠️ 原生插件目前只处理<b>私聊</b>；群聊功能未实现，下面的群号/档位配置暂不生效。</div>
<h2>群聊白名单（未生效）</h2>
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
          <h2>自述层（她自己能改的那一层）</h2>
          <div class="muted" id="selfMeta">加载中…</div>
          <textarea id="selfText" placeholder="她还没写自述" style="margin-top:8px;min-height:120px"></textarea>
          <div class="row" style="margin-top:8px">
            <button class="ghost" id="btnSelfSave">保存自述</button>
            <button class="ghost" id="btnSelfRollback">回滚到上一个备份</button>
            <span class="muted" id="selfMsg"></span>
          </div>
          <div class="muted" id="selfHistory" style="margin-top:8px">—</div>
        </div>
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
        <h2>原生链路说明</h2>
<div class="muted" id="nativeInfo">加载中…</div>
        <div class="row"><label><input type="radio" name="mode" value="chat" /> chat（白名单聊天）</label></div>
        <div class="row"><label><input type="radio" name="mode" value="closed-agent" /> closed-agent（仅 owner 私聊，完整工具）</label></div>
          <div class="row"><label><input type="radio" name="mode" value="reserved" /> reserved（一代仿真：桥接拆条）</label></div>
          <div class="row"><label><input type="radio" name="mode" value="reserved2" /> reserved2（二代仿真：自主工具 · 记忆 · 唤醒）</label></div>
          <p class="muted" style="color:#ff9f0a">⚠️ 模式改动会重连 QQ并建立新会话（聊天上下文会重置，长期印象保留）。切到 reserved2 需要预设 qq-chat-v2；切回 chat/closed-agent 用 qq-chat。</p>
        <div class="row"><label>owner QQ</label><input type="text" id="ownerQQ" /></div>
        <p class="muted">closed-agent = 只有 ownerQQ 私聊能用；群聊和其它人一律不响应。</p>
      </div>
      <div class="card">
        <h2>私聊白名单（原生链路不生效，只看 ownerQQ）</h2>
        <textarea id="allowPrivate" placeholder="每行一个 QQ 号"></textarea>
        <p class="muted">留空则谁都不回。</p>
      </div>
      <div class="card">
        <div class="muted" style="margin:8px 0">以下选项属于旧桥接；原生插件用 preset 默认值，改动不影响插件。</div>
<h2>高级（旧桥接遗留）</h2>
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
          <h2>记忆总库（所有操作永久留档）</h2>
          <div class="row"><input type="text" id="vaultQuery" placeholder="搜总库…" style="flex:1" />
            <button class="ghost" id="btnVaultSearch">搜索</button><button class="ghost" id="btnVaultRefresh">刷新</button>
            <span class="muted" id="vaultMeta">—</span></div>
          <div class="muted" id="vaultBox">加载中…</div>
        </div>
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
        <div class="row"><textarea id="l5Dirs" rows="3" style="width:100%" placeholder="D:\\课件&#10;C:\\Users\\Lenovo\\Documents"></textarea></div>
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
          <h2>群聊配置</h2>
          <div class="row"><label style="display:flex;align-items:center;gap:8px;font-size:13px">
            <input type="checkbox" id="groupsEnabled" /><span>启用群聊</span></label>
            <label style="display:flex;align-items:center;gap:8px;font-size:13px">
            <input type="checkbox" id="groupsActionEnabled" /><span>允许群消息动作</span></label></div>
          <div class="row"><label>群号白名单（逗号分隔）</label><input type="text" id="groupsAllow" style="flex:1" placeholder="123456789,987654321" /></div>
          <div class="row"><label>关键词（逗号分隔）</label><input type="text" id="groupsKeywords" style="flex:1" placeholder="小助手,deepseek" /></div>
          <div class="row"><label>档位 0-100</label><input type="number" id="groupsTier" min="0" max="100" style="width:100px" /></div>
          <div class="row"><label>冷却(秒)</label><input type="number" id="groupsCooldown" min="0" style="width:100px" />
            <label>每小时上限</label><input type="number" id="groupsMaxHour" min="1" style="width:100px" /></div>
          <div class="row"><button class="ghost" id="btnGroupsSave">保存群聊配置</button><span class="muted" id="groupsMsg"></span></div>
        </div>
  <div class="card">
    <h2>屏幕监控（只读）</h2>
    <div class="row"><label style="display:flex;align-items:center;gap:8px;font-size:13px">
      <input type="checkbox" id="screenWatchToggle" /><span>持续看屏幕（只截图，不动鼠标键盘）</span></label></div>
    <div class="row"><label>间隔(分钟)</label><input type="number" id="screenInterval" min="1" max="60" step="1" style="width:90px" /></div>
    <div class="row"><label style="display:flex;align-items:center;gap:8px;font-size:13px">
      <input type="checkbox" id="screenComment" /><span>看到变化时主动发一句（默认只记在心里）</span></label></div>
    <div class="row"><button class="ghost" id="btnScreenSave">保存</button><button class="ghost" id="btnScreenRefresh">刷新</button>
      <span class="muted" id="screenMeta">—</span></div>
    <div class="muted" id="screenLatest" style="margin:8px 0">—</div>
    <div id="screenObs" class="muted">加载中…</div>
  </div>
  <div class="card">
    <h2>爱好（她自己的时间）</h2>
    <div class="muted" id="hobbyMeta">加载中…</div>
    <div id="hobbyList" style="margin:10px 0"></div>
    <div class="row"><label>新增爱好</label><input type="text" id="hobbyName" placeholder="名字" style="width:140px" />
      <input type="text" id="hobbyWhy" placeholder="为什么喜欢（可空）" style="flex:1" />
      <button class="ghost" id="btnHobbyAdd">添加</button><button class="ghost" id="btnHobbyRefresh">刷新</button></div>
    <div class="muted" id="hobbyNotes" style="margin-top:12px">—</div>
  </div>


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
          <h2>动作审计（最近 50 条）</h2>
          <div class="row"><button class="ghost" id="btnActionsRefresh">刷新</button><span class="muted" id="actionsMeta">—</span></div>
          <div class="muted" id="actionsBox">加载中…</div>
        </div>
      <div class="card">
        <h2>运行日志</h2>
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
  const nativeOn = !!(m.native && (m.native.connected || m.native.config));
  if (m.versions) {
    const v = m.versions.native || m.versions.console || '';
    setChip('chipVersion', v ? ('v' + v) : 'v 未知', true);
    if ($('chipVersion')) $('chipVersion').title = '插件 ' + (m.versions.native || '-') + ' / 管理台 ' + (m.versions.console || '-') + ' / 预设 ' + (m.versions.presets || '-');
  }
  setChip('chipDsh', nativeOn ? 'DSH ⇄ 原生插件已连接' : 'DSH 未连接', nativeOn);
    const ni = document.getElementById('nativeInfo');
  if (ni) {
    const nc = m.native || {};
    const cfgLine = nc.config ? [
      '会话：' + (nc.sessionId || '（首次回复后生成）'),
      '触发：所有私聊消息（无需前缀）',
      '合并窗口：' + (nc.config.batchWindowMs || 1600) + 'ms',
      '主动找话题：' + (nc.config.proactive?.enabled ? '开（空闲 ' + (nc.config.proactive.idleMinutes||240) + ' 分钟，每天 ≤' + (nc.config.proactive.maxPerDay||3) + ' 次）' : '关'),
      'L5 探索：' + (m.capabilities?.explore ? '开' : '关'),
      '桥接：已退役（不再运行）',
    ].join('<br>') : '插件状态未知';
    ni.innerHTML = cfgLine;
  }
setChip('chipSnow', m.snowluma?.ws ? 'SnowLuma 在线' : 'SnowLuma 未连接', !!m.snowluma?.ws);
  setChip('chipBridge', (m.bridge?.running ? (m.bridge?.native ? 'QQ 已连接（原生插件）' : 'QQ 已连接 (pid ' + m.bridge.pid + ')') : 'QQ 未连接'), !!m.bridge?.running || !!m.snowluma?.ws);
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
  const options = ['小助手'];
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
  s.persona = p === '__off' && !file && !text.trim() ? { name: '', file: '', text: '' } : { name: p === '__off' ? '' : p, file: file || (p === '小助手' ? state.settings.persona?.file || '' : ''), text };
  return s;
}
async function save() {
  const s = collect();
    // 模式改动是破坏性的（要重连 QQ并重建会话），必须二次确认。
    const prevMode = (state.settings && state.settings.mode) || 'chat';
    if (s.mode !== prevMode) {
      const label = {
        chat: 'chat（白名单聊天）',
        'closed-agent': 'closed-agent（仅 owner 私聊）',
        reserved: 'reserved（一代仿真）',
        reserved2: 'reserved2（二代仿真）'
      };
      const ok = window.confirm('模式将从「' + (label[prevMode] || prevMode) + '」改为「' + (label[s.mode] || s.mode) + '」。\n\n这会重连 QQ并建立新会话，当前聊天上下文会重置（长期印象保留）。\n确定要改吗？');
      if (!ok) { toast('已取消：模式未修改'); return; }
    }
  await api('/api/settings', { method: 'POST', body: JSON.stringify(s) });
  toast('已保存，正在重连 QQ…');
  setTimeout(load, 1500);
}
async function restart() { await api('/api/restart', { method: 'POST', body: '{}' }); toast('原生链路无需重启，已忽略'); setTimeout(load, 1500); }
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
  async function loadPersonaSelf() {
    try {
      const d = await api('/api/persona-self');
      if ($('selfText')) $('selfText').value = d.text || '';
      if ($('selfMeta')) $('selfMeta').textContent = (d.chars || 0) + ' / ' + (d.maxChars || 4096) + ' 字 · 备份 ' + (d.backups || []).length + ' 个';
      const h = $('selfHistory');
      if (h) h.innerHTML = (d.history || []).length
        ? '<b>变更历史</b><br>' + d.history.map((x) => new Date(x.at).toLocaleString('zh-CN', { hour12: false }) + ' · ' + (x.action || '') + ' · ' + (x.by || '') + (x.chars ? ' · ' + x.chars + ' 字' : '')).join('<br>')
        : '（还没有变更记录）';
    } catch (e) { /* ignore */ }
  }
  async function savePersonaSelf() {
    const text = ($('selfText')?.value || '').trim();
    try {
      const r = await api('/api/persona-self', { method: 'POST', body: JSON.stringify({ action: 'write', text }) });
      if (r.ok) { toast('自述已保存'); await loadPersonaSelf(); } else toast(r.error || '保存失败');
    } catch (e) { toast('保存失败：' + e.message); }
  }
  async function rollbackPersonaSelf() {
    if (!window.confirm('回滚到上一个备份？')) return;
    try {
      const r = await api('/api/persona-self', { method: 'POST', body: JSON.stringify({ action: 'rollback' }) });
      if (r.ok) { toast('已回滚到 ' + r.from); await loadPersonaSelf(); } else toast(r.error || '回滚失败');
    } catch (e) { toast('回滚失败：' + e.message); }
  }

  async function loadGroupsCfg() {
    try {
      const d = await api('/api/groups');
      const g = d.groups || {};
      if ($('groupsEnabled')) $('groupsEnabled').checked = !!g.enabled;
      if ($('groupsActionEnabled')) $('groupsActionEnabled').checked = !!d.actionGroupEnabled;
      if ($('groupsAllow')) $('groupsAllow').value = (g.allow || []).join(',');
      if ($('groupsKeywords')) $('groupsKeywords').value = (g.keywords || []).join(',');
      if ($('groupsTier')) $('groupsTier').value = String(g.defaultTier ?? 20);
      if ($('groupsCooldown')) $('groupsCooldown').value = String(g.cooldownSeconds ?? 20);
      if ($('groupsMaxHour')) $('groupsMaxHour').value = String(g.maxPerHour ?? 30);
    } catch (e) { /* ignore */ }
  }
  async function saveGroupsCfg() {
    const split = (v) => String(v || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    const groups = {
      enabled: !!$('groupsEnabled')?.checked,
      allow: split($('groupsAllow')?.value),
      keywords: split($('groupsKeywords')?.value),
      defaultTier: Number($('groupsTier')?.value) || 0,
      cooldownSeconds: Number($('groupsCooldown')?.value) || 0,
      maxPerHour: Number($('groupsMaxHour')?.value) || 30,
    };
    try {
      await api('/api/groups', { method: 'POST', body: JSON.stringify({ groups, enableActionGroup: !!$('groupsActionEnabled')?.checked }) });
      if ($('groupsMsg')) $('groupsMsg').textContent = '已保存（重启 DSH 生效）';
      toast('群聊配置已保存');
    } catch (e) { toast('保存失败：' + e.message); }
  }

  async function loadActions() {
    try {
      const d = await api('/api/actions');
      if ($('actionsMeta')) $('actionsMeta').textContent = '最近 ' + (d.total || 0) + ' 条';
      const box = $('actionsBox');
      if (box) box.innerHTML = (d.actions || []).length
        ? d.actions.map((a) => '<div style="padding:5px 0;border-bottom:1px solid #262b36">' + new Date(a.at).toLocaleString('zh-CN', { hour12: false }) + ' · ' + (a.action || '') + ' · ' + (a.ok ? '<span style="color:#3ecf8e">ok</span>' : '<span style="color:#ff6b6b">fail</span>') + (a.error ? ' · ' + a.error : '') + (a.ms !== undefined ? ' · ' + a.ms + 'ms' : '') + '</div>').join('')
        : '（还没有动作记录）';
    } catch (e) { /* ignore */ }
  }

  async function loadVault() {
    try {
      const q = $('vaultQuery')?.value || '';
      const d = await api('/api/vault' + (q ? '?q=' + encodeURIComponent(q) : ''));
      if ($('vaultMeta')) $('vaultMeta').textContent = '共 ' + (d.total || 0) + ' 条事件 · ' + (d.sizeKB || 0) + ' KB' + (q ? ' · 匹配 ' + d.matched : '');
      const box = $('vaultBox');
      if (box) box.innerHTML = (d.recent || []).length
        ? d.recent.map((r) => '<div style="padding:5px 0;border-bottom:1px solid #262b36"><span class="muted">' + new Date(r.at).toLocaleString('zh-CN', { hour12: false }) + ' · ' + (r.op || '') + ' · ' + (r.origin || '') + '</span><br>' + String(r.text || '').slice(0, 200) + '</div>').join('')
        : '（总库还没有记录）';
    } catch (e) { /* ignore */ }
  }

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
  if ($('btnHobbyAdd')) $('btnHobbyAdd').addEventListener('click', addHobby);
  if ($('btnHobbyRefresh')) $('btnHobbyRefresh').addEventListener('click', loadHobbies);
  loadHobbies();
  if ($('btnSelfSave')) $('btnSelfSave').addEventListener('click', savePersonaSelf);
  if ($('btnSelfRollback')) $('btnSelfRollback').addEventListener('click', rollbackPersonaSelf);
  if ($('btnGroupsSave')) $('btnGroupsSave').addEventListener('click', saveGroupsCfg);
  if ($('btnActionsRefresh')) $('btnActionsRefresh').addEventListener('click', loadActions);
  if ($('btnVaultSearch')) $('btnVaultSearch').addEventListener('click', loadVault);
  if ($('btnVaultRefresh')) $('btnVaultRefresh').addEventListener('click', loadVault);
  loadPersonaSelf();
  loadGroupsCfg();
  loadActions();
  loadVault();
  if ($('btnScreenSave')) $('btnScreenSave').addEventListener('click', saveScreen);
  if ($('btnScreenRefresh')) $('btnScreenRefresh').addEventListener('click', loadScreen);
  loadScreen();
  setInterval(loadScreen, 15000);

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

  async function loadHobbies() {
    try {
      const d = await api('/api/hobbies');
      const box = $('hobbyList');
      if ($('hobbyMeta')) $('hobbyMeta').textContent = '今天已经玩过 ' + (d.runsToday || 0) + ' 次 · 每天最多 2 次（白天）';
      if (box) {
        box.innerHTML = (d.items || []).map((h) => {
          const stars = '★'.repeat(Math.max(1, Math.min(5, Math.round(h.level))));
          const last = h.lastAt ? new Date(h.lastAt).toLocaleDateString('zh-CN') : '还没玩过';
          return '<div style="padding:6px 0;border-bottom:1px solid #262b36"><b>' + h.name + '</b> <span class="muted">' + stars + ' · ' + last + (h.why ? ' · ' + h.why : '') + '</span></div>';
        }).join('') || '<span class="muted">还没有爱好</span>';
      }
      const notes = $('hobbyNotes');
      if (notes) {
        const recent = (d.recent || []).slice(0, 8);
        notes.innerHTML = recent.length
          ? '<b>她最近写的</b>' + recent.map((r) => '<div style="padding:6px 0;border-bottom:1px solid #262b36"><span class="muted">' + new Date(r.at).toLocaleString('zh-CN', { hour12: false }) + ' · ' + (r.hobby || '') + '</span><br>' + String(r.text || '').slice(0, 200) + '</div>').join('')
          : '（还没有笔记，等她自己的时间）';
      }
    } catch (e) { /* ignore */ }
  }

  async function addHobby() {
    const name = ($('hobbyName')?.value || '').trim();
    if (!name) { toast('先写个名字'); return; }
    try {
      await api('/api/hobbies', { method: 'POST', body: JSON.stringify({ action: 'add', name, why: $('hobbyWhy')?.value || '' }) });
      if ($('hobbyName')) $('hobbyName').value = '';
      if ($('hobbyWhy')) $('hobbyWhy').value = '';
      toast('加好了'); await loadHobbies();
    } catch (e) { toast('失败：' + e.message); }
  }

  async function loadScreen() {
    try {
      const d = await api('/api/screen');
      if ($('screenWatchToggle')) $('screenWatchToggle').checked = !!d.enabled;
      if ($('screenInterval') && !$('screenInterval').value) $('screenInterval').value = String(d.everyMinutes || 5);
      if ($('screenComment')) $('screenComment').checked = !!d.comment;
      if ($('screenMeta')) $('screenMeta').textContent = d.enabled ? ('运行中 · 每 ' + (d.everyMinutes||5) + ' 分钟') : '已关闭';
      if ($('screenLatest')) $('screenLatest').textContent = d.latestExists
        ? ('最近截图：' + new Date(d.latestAt).toLocaleString('zh-CN', { hour12: false }) + ' · 累计变化 ' + (d.changes||0) + ' 次')
        : '还没有截图';
      const box = $('screenObs');
      if (box) {
        const obs = (d.observations || []).slice(0, 10);
        box.innerHTML = obs.length
          ? '<h2 style="margin-top:12px">她最近看到的</h2>' + obs.map((o) => '<div style="padding:6px 0;border-bottom:1px solid #262b36">' + new Date(o.at).toLocaleString('zh-CN', { hour12: false }) + ' — ' + String(o.text || '').slice(0, 200) + '</div>').join('')
          : '（还没有观察记录）';
      }
    } catch (e) { /* ignore */ }
  }

  async function saveScreen() {
    const body = {
      enabled: !!$('screenWatchToggle')?.checked,
      everyMinutes: Number($('screenInterval')?.value) || 5,
      comment: !!$('screenComment')?.checked,
    };
    try { await api('/api/screen', { method: 'POST', body: JSON.stringify(body) }); toast('已保存'); await loadScreen(); }
    catch (e) { toast('保存失败：' + e.message); }
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
    if ($('workModeMsg')) $('workModeMsg').textContent = on ? '已打开，正在重连 QQ…' : '已关闭，正在重连 QQ…';
    await api('/api/restart', { method: 'POST' });
    if ($('workModeMsg')) $('workModeMsg').textContent = on ? '工作模式已开（会话已重建）' : '工作模式已关';
  } catch (e) { toast('切换失败：' + e.message); }
});
$('btnRefreshTasks').addEventListener('click', () => loadTasks());
load().catch((e) => { document.body.innerHTML = '<p style="padding:24px;color:#ff6b6b">无法连接管理 API：' + esc(e.message) + '</p>'; });
</script>

<style id="native-clean-style">
  /* 原生链路：隐藏桥接时代的界面 */
  button[data-tab="groups"], #tab-groups { display: none !important; }
</style>
<script id="native-clean">
document.addEventListener('DOMContentLoaded', () => {
  const hide = (el) => { if (el) el.style.display = 'none'; };
  hide(document.querySelector('button[data-tab="groups"]'));
  hide(document.getElementById('tab-groups'));
  // 隐藏桥接遗留的卡片（高级 / 私聊白名单 / 运行模式单选）
  document.querySelectorAll('.card').forEach((card) => {
    const h = card.querySelector('h2');
    if (!h) return;
    const txt = h.textContent || '';
    if (txt.includes('高级') || txt.includes('私聊白名单') || txt.includes('群聊白名单')) hide(card);
  });
  document.querySelectorAll('input[name="mode"]').forEach((el) => {
    const row = el.closest('.row');
    if (row) hide(row);
  });
  // 高级卡片没有 h2 的被上面覆盖不到时，按文本再兜底一次
  document.querySelectorAll('.muted').forEach((el) => {
    if ((el.textContent || '').includes('旧桥接遗留') || (el.textContent || '').includes('以下选项属于旧桥接')) {
      const card = el.closest('.card');
      if (card) hide(card);
    }
  });
});
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
      const HOBBY_DIR = pathx.join(osx.homedir(), '.dsh', 'qq-native', 'data');
      const readHobbiesRaw = () => {
        try { return JSON.parse(fsx.readFileSync(pathx.join(HOBBY_DIR, 'hobbies.json'), 'utf8')); } catch { return { items: [] }; }
      };
      
      
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
      // ── 屏幕监控 / 爱好（原生链路新增）────────────────────────────
      const nativeHome = () => osx.homedir();
      const nativeStateDir = () => pathx.join(nativeHome(), '.dsh', 'qq-native', 'state');
      const nativeDataDir = () => pathx.join(nativeHome(), '.dsh', 'qq-native', 'data');
      const readJsonFile = (f) => { try { return JSON.parse(fsx.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
      const readScreenState = () => {
        const dir = pathx.join(nativeHome(), '.dsh', 'qq-native', 'screen');
        const cfg = readJsonFile(pathx.join(nativeHome(), '.dsh', 'qq-native', 'config.json')) || {};
        const sw = cfg.screenWatch || { enabled: false, everyMinutes: 5, comment: false };
        const st = readJsonFile(pathx.join(dir, 'state.json')) || {};
        const readLines = (name, limit) => { try { return fsx.readFileSync(pathx.join(dir, name), 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse(); } catch { return []; } };
        let latestAt = 0; try { latestAt = fsx.statSync(pathx.join(dir, 'latest.png')).mtimeMs; } catch { /* none */ }
        return { enabled: Boolean(sw.enabled), everyMinutes: Number(sw.everyMinutes) || 5, comment: Boolean(sw.comment), lastAt: Number(st.lastAt) || 0, changes: Number(st.changes) || 0, lastChangeAt: Number(st.lastChangeAt) || 0, latestExists: latestAt > 0, latestAt, observations: readLines('observations.jsonl', 20), changesLog: readLines('watch.jsonl', 20) };
      };
      const readHobbiesState = () => {
        const dir = nativeDataDir();
        const j = readJsonFile(pathx.join(dir, 'hobbies.json')) || { items: [] };
        const rows = (() => { try { return fsx.readFileSync(pathx.join(dir, 'hobby-log.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse(); } catch { return []; } })();
        const today = new Date().toDateString();
        return { items: (j.items || []).map((h) => ({ name: h.name, why: h.why || '', level: Number(h.level) || 3, lastAt: Number(h.lastAt) || 0, notes: (h.notes || []).slice(-3) })), recent: rows.slice(0, 20), runsToday: rows.filter((r) => new Date(r.at).toDateString() === today).length };
      };
      const addHobbyItem = (name, why) => {
        const dir = nativeDataDir();
        const j = readJsonFile(pathx.join(dir, 'hobbies.json')) || { items: [] };
        if ((j.items || []).some((h) => h.name === name)) return;
        j.items = [...(j.items || []), { id: 'h' + Date.now().toString(36), name, why, level: 3, createdAt: Date.now(), lastAt: 0, notes: [] }];
        fsx.mkdirSync(dir, { recursive: true });
        fsx.writeFileSync(pathx.join(dir, 'hobbies.json'), JSON.stringify(j, null, 2) + '\n', 'utf8');
      };
      if (req.method === 'GET' && url.pathname === '/api/screen') { return send(res, 200, JSON.stringify(readScreenState())); }
      if (req.method === 'POST' && url.pathname === '/api/screen') {
        const chunks = []; for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const cfgFile = pathx.join(nativeHome(), '.dsh', 'qq-native', 'config.json');
        const cfg = readJsonFile(cfgFile) || {};
        const cur = cfg.screenWatch || { enabled: false, everyMinutes: 5, comment: false };
        cfg.screenWatch = { ...cur, ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}), ...(Number(body.everyMinutes) > 0 ? { everyMinutes: Number(body.everyMinutes) } : {}), ...(typeof body.comment === 'boolean' ? { comment: body.comment } : {}) };
        fsx.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
        return send(res, 200, JSON.stringify({ ok: true, screen: readScreenState() }));
      }
      if (req.method === 'GET' && url.pathname === '/api/hobbies') { return send(res, 200, JSON.stringify(readHobbiesState())); }
      if (req.method === 'POST' && url.pathname === '/api/hobbies') {
        const chunks = []; for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (body.action === 'add') { const name = String(body.name || '').trim(); if (!name) return send(res, 400, JSON.stringify({ error: 'name 不能为空' })); addHobbyItem(name, String(body.why || '')); }
        return send(res, 200, JSON.stringify({ ok: true, hobbies: readHobbiesState() }));
      }

      // ── 新增：自述层 / 群聊配置 / 动作审计 / 记忆总库 ──────────────
      const qqNativeDir = pathx.join(osx.homedir(), '.dsh', 'qq-native');
      const readJsonSafe = (f) => { try { return JSON.parse(fsx.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
      const readTextSafe = (f) => { try { return fsx.readFileSync(f, 'utf8'); } catch { return ''; } };
      
      if (req.method === 'GET' && url.pathname === '/api/persona-self') {
        const selfFile = pathx.join(qqNativeDir, 'data', 'persona-self.md');
        const auditFile = pathx.join(qqNativeDir, 'state', 'persona-changes.jsonl');
        const dataDir = pathx.join(qqNativeDir, 'data');
        let backups = [];
        try { backups = fsx.readdirSync(dataDir).filter((f) => f.startsWith('persona-self.md.bak-')).sort().reverse().slice(0, 10); } catch { /* none */ }
        let history = [];
        try { history = fsx.readFileSync(auditFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-20).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse(); } catch { /* none */ }
        return send(res, 200, JSON.stringify({ text: readTextSafe(selfFile), chars: readTextSafe(selfFile).length, maxChars: 4096, backups, history }));
      }
      if (req.method === 'POST' && url.pathname === '/api/persona-self') {
        const chunks = []; for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const dataDir = pathx.join(qqNativeDir, 'data');
        const selfFile = pathx.join(dataDir, 'persona-self.md');
        if (body.action === 'rollback') {
          let backups = [];
          try { backups = fsx.readdirSync(dataDir).filter((f) => f.startsWith('persona-self.md.bak-')).sort(); } catch { /* none */ }
          if (!backups.length) return send(res, 200, JSON.stringify({ ok: false, error: '没有备份可回滚' }));
          const src = pathx.join(dataDir, backups[backups.length - 1]);
          fsx.copyFileSync(src, selfFile);
          try { fsx.appendFileSync(pathx.join(qqNativeDir, 'state', 'persona-changes.jsonl'), JSON.stringify({ at: new Date().toISOString(), action: 'rollback', by: 'console', reason: 'rollback to ' + backups[backups.length - 1] }) + '\n', 'utf8'); } catch { /* none */ }
          return send(res, 200, JSON.stringify({ ok: true, from: backups[backups.length - 1] }));
        }
        if (body.action === 'write') {
          const text = String(body.text || '').trim();
          if (!text) return send(res, 400, JSON.stringify({ ok: false, error: '内容为空' }));
          if (text.length > 4096) return send(res, 400, JSON.stringify({ ok: false, error: '超过 4096 字' }));
          try { fsx.mkdirSync(dataDir, { recursive: true }); } catch { /* none */ }
          try { if (fsx.existsSync(selfFile)) fsx.copyFileSync(selfFile, selfFile + '.bak-' + Date.now()); } catch { /* none */ }
          fsx.writeFileSync(selfFile, text + '\n', 'utf8');
          try { fsx.appendFileSync(pathx.join(qqNativeDir, 'state', 'persona-changes.jsonl'), JSON.stringify({ at: new Date().toISOString(), action: 'write', by: 'console', chars: text.length }) + '\n', 'utf8'); } catch { /* none */ }
          return send(res, 200, JSON.stringify({ ok: true, chars: text.length }));
        }
        return send(res, 400, JSON.stringify({ ok: false, error: '未知 action' }));
      }
      
      if (req.method === 'GET' && url.pathname === '/api/groups') {
        const cfg = readJsonSafe(pathx.join(qqNativeDir, 'config.json')) || {};
        const g = cfg.groups || {};
        return send(res, 200, JSON.stringify({ groups: g, actionGroupEnabled: !!(cfg.actions && cfg.actions.enabled && cfg.actions.enabled.group) }));
      }
      if (req.method === 'POST' && url.pathname === '/api/groups') {
        const chunks = []; for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const cfgFile = pathx.join(qqNativeDir, 'config.json');
        const cfg = readJsonSafe(cfgFile) || {};
        cfg.groups = { ...(cfg.groups || {}), ...(body.groups || {}) };
        if (typeof body.enableActionGroup === 'boolean') {
          cfg.actions = cfg.actions || {};
          cfg.actions.enabled = { ...(cfg.actions.enabled || {}), group: body.enableActionGroup };
        }
        fsx.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
        return send(res, 200, JSON.stringify({ ok: true, groups: cfg.groups }));
      }
      
      if (req.method === 'GET' && url.pathname === '/api/actions') {
        const f = pathx.join(qqNativeDir, 'state', 'actions.jsonl');
        let rows = [];
        try { rows = fsx.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-200).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse(); } catch { /* none */ }
        return send(res, 200, JSON.stringify({ total: rows.length, actions: rows.slice(0, 50) }));
      }
      
      if (req.method === 'GET' && url.pathname === '/api/vault') {
        const dir = process.env.QQ_MEMORY_DIR || pathx.join(osx.homedir(), '.dsh', 'qq-memory');
        const f = pathx.join(dir, 'all-memories.jsonl');
        let rows = [];
        try { rows = fsx.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* none */ }
        const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
        const filtered = q ? rows.filter((r) => String(r.text || '').toLowerCase().includes(q)) : rows;
        const byOp = {}; for (const r of rows) byOp[r.op] = (byOp[r.op] || 0) + 1;
        let sizeKB = 0; try { sizeKB = Math.round(fsx.statSync(f).size / 1024 * 10) / 10; } catch { /* none */ }
        return send(res, 200, JSON.stringify({ total: rows.length, matched: filtered.length, byOp, sizeKB, file: f, recent: filtered.slice(-40).reverse() }));
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
