// wake.mjs —— 唤醒引擎最小版：消息合并 + 去重 + 潜水
//
// 目标：你连发 3 句，她只醒一次（合并成一段），而不是回 3 次。
//
// 用法：
//   const batcher = createBatcher({ windowMs: 1200, onFlush: async (text, meta) => {…} });
//   batcher.push('你好', { userId: 10001, msgId: 'abc' });
//   // windowMs 内再 push 会并进同一批；到点调一次 onFlush
//
// 潜水（sleeping）：
//   batcher.sleep(ms)  → 这段时间内 push 的消息只收着，不触发回复
//   batcher.wake()     → 立刻恢复（后续消息照常合并）

export function createBatcher({
  windowMs = 1200,
  maxWaitMs = 6000,
  maxMessages = 8,
  onFlush = async () => {},
  log = () => {},
} = {}) {
  let texts = [];
  let meta = null;
  let timer = null;
  let firstAt = 0;
  let sleepingUntil = 0;
  let seq = 0;
  const seen = new Set(); // 去重（重连后事件可能重放）

  const clearTimer = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  const flush = async (reason) => {
    clearTimer();
    if (!texts.length) return;
    const batchText = texts.join('\n');
    const batchMeta = { ...(meta || {}), count: texts.length, seq: ++seq, reason };
    texts = [];
    meta = null;
    firstAt = 0;
    try {
      await onFlush(batchText, batchMeta);
    } catch (error) {
      log('[wake] onFlush 出错：' + (error?.message ?? error));
    }
  };

  return {
    push(text, info = {}) {
      const t = String(text ?? '').trim();
      if (!t) return 'empty';
      const key = info.msgId ? String(info.msgId) : '';
      if (key) {
        if (seen.has(key)) return 'duplicate';
        seen.add(key);
        if (seen.size > 500) { const first = seen.values().next().value; seen.delete(first); }
      }
      const now = Date.now();
      if (now < sleepingUntil) {
        log(`[wake] 潜水中（还有 ${Math.round((sleepingUntil - now) / 1000)}s），只收不回`);
        return 'sleeping';
      }
      meta = meta || { userId: info.userId, key: info.key };
      texts.push(t);
      if (!firstAt) firstAt = now;
      if (texts.length >= maxMessages) { void flush('maxMessages'); return 'flushed'; }
      // 合并窗口：每来一条重排一次；但不能无限推迟（maxWaitMs 封顶）
      clearTimer();
      const wait = Math.min(windowMs, Math.max(0, firstAt + maxWaitMs - now));
      timer = setTimeout(() => { void flush('window'); }, Math.max(200, wait));
      timer.unref?.();
      return 'queued';
    },

    /* 立刻把手上这批发出去（例如收到 [SILENT] 收尾、或进程要退出） */
    flushNow(reason = 'manual') { return flush(reason); },

    sleep(ms = 30 * 60 * 1000) {
      sleepingUntil = Date.now() + Math.max(0, Number(ms) || 0);
      log(`[wake] 开始潜水 ${Math.round(ms / 1000)}s`);
      return sleepingUntil;
    },

    wake() {
      sleepingUntil = 0;
      log('[wake] 取消潜水');
    },

    get sleeping() { return Date.now() < sleepingUntil; },
    get pending() { return texts.length; },
    stats() { return { pending: texts.length, sleeping: this.sleeping, seen: seen.size, seq }; },
  };
}

/* 从回复里抽出「记：xxxx」这样的记忆行（要被存进记忆库，不发到 QQ） */
export function extractMemoryLines(reply) {
  const kept = [];
  const facts = [];
  for (const line of String(reply ?? '').split(/\r?\n/)) {
    const m = /^\s*[【\[]?\s*(?:记|记住|记忆)\s*[:：]\s*(.+)$/.exec(line);
    if (m) facts.push(m[1].trim());
    else kept.push(line);
  }
  return { text: kept.join('\n').trim(), facts };
}
