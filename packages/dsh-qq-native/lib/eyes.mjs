// eyes.mjs —— 「眼睛」：借一条 computer-explore 会话看屏幕（只读，不操作）
//
// 为什么单独开会话：
//   · 聊天 preset（qq-chat-v2）里没有截图/看图能力，塞进去会污染她的工具面
//   · computer-explore 预设自带 computer 工具 + 视觉，天生适合当眼睛
//   · 两条会话互不干扰：聊天照常，眼睛只回答"屏幕上是啥"
//
// 会话 id 存在 ~/.dsh/qq-native/state/eyes.json，重启复用。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = () => path.join(os.homedir(), '.dsh', 'qq-native', 'state', 'eyes.json');

const LOOK_PROMPT = [
  '【只看不动】请用 computer 工具截一张当前屏幕，然后用一两句中文客观描述：',
  '主人在做什么？屏幕上是哪个窗口/什么内容？',
  '',
  '硬性要求：',
  '· 只能截图，绝对不能点击、移动鼠标、打字、拖动窗口、关闭任何东西',
  '· 不要解读他的心情或评判内容，只描述看到的东西',
  '· 不读、不复述任何密码、验证码、私密信息；如果画面里有这类东西，只说"画面里有一些敏感信息，我不细看"',
  '· 直接输出描述文本，不要解释你在做什么',
].join('\n');

function readId() {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8')).sessionId || '';
  } catch { return ''; }
}

function writeId(sessionId) {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify({ sessionId, at: Date.now() }, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/**
 * 创建一个「眼睛」agent（惰性）。
 * 传入 createDshAgent 由调用方注入，避免循环依赖。
 */
export function createEyes({ createDshAgent, log = () => {} } = {}) {
  let promise = null;
  let busy = false;

  async function ensure() {
    if (!promise) {
      promise = createDshAgent({
        preset: 'computer-explore',
        log,
        resumeSessionId: readId(),
      }).then((agent) => {
        writeId(agent.sessionId);
        return agent;
      }).catch((error) => {
        promise = null;
        throw error;
      });
    }
    return promise;
  }

  return {
    /** 看一眼，返回描述文本 */
    async look({ timeoutMs = 180000 } = {}) {
      if (busy) return '';
      busy = true;
      try {
        const agent = await ensure();
        const reply = (await agent.ask(LOOK_PROMPT, { timeoutMs })).trim();
        if (!reply) return '';
        return reply.replace(/\*\*/g, '').replace(/^#+\s?/gm, '').trim();
      } catch (error) {
        log('[eyes] 看屏幕失败：' + (error?.message ?? error));
        return '';
      } finally {
        busy = false;
      }
    },
    get sessionId() { return readId(); },
  };
}
