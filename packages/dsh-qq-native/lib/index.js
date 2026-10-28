// index.js —— CJS 入口（DSH 插件加载器用 CommonJS 最稳，参见 dsh-qq-personal）
// 真正的逻辑在 runner.mjs（ESM）；这里只做转接 + 确保加载痕迹落盘。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG_FILE = path.join(os.homedir(), '.dsh', 'qq-native', 'plugin.log');
function fileLog(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + String(msg) + '\n', 'utf8');
  } catch { /* ignore */ }
}

fileLog('[module] index.js 被加载');

let disposer = null;

module.exports = {
  name: 'qq-native',
  apply(ctx) {
    fileLog('[apply] 被调用');
    // 动态 import ESM 内核（CJS 里不能静态 import）
    import('./runner.mjs')
      .then(async (mod) => {
        fileLog('[apply] runner 已加载');
        try {
          disposer = await mod.start(ctx);
          fileLog('[apply] runner 已启动');
        } catch (error) {
          fileLog('[apply] runner 启动失败：' + (error?.stack ?? error));
        }
      })
      .catch((error) => fileLog('[apply] 加载 runner 失败：' + (error?.stack ?? error)));

    return () => {
      try { if (typeof disposer === 'function') disposer(); } catch { /* ignore */ }
      fileLog('[dispose] 已停止');
    };
  },
};
