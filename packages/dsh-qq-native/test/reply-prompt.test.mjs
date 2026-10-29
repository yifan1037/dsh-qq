// reply-prompt：纯函数组装（无 IO、无模型）
import test from 'node:test';
import assert from 'node:assert/strict';

const { buildReplyPrompt, buildImageHint } = await import('../lib/reply-prompt.mjs');

test('私聊：角色卡 + 记忆 + 规则 + 原话', () => {
  const p = buildReplyPrompt({ persona: '你是助手', memory: '【记忆】他喜欢猫', text: '在吗' });
  assert.match(p, /【你的角色卡】\n你是助手/);
  assert.match(p, /【记忆】他喜欢猫/);
  assert.match(p, /【QQ 私聊】/);
  assert.match(p, /\[SILENT\]/);
  assert.match(p, /记：xxx/);
  assert.match(p, /\[自述: 内容\]/);
  assert.match(p, /主人说：在吗$/);
});

test('私聊：首轮无角色卡时不留空块', () => {
  const p = buildReplyPrompt({ text: '你好' });
  assert.ok(!p.includes('【你的角色卡】'));
  assert.ok(!p.includes('\n\n\n'));
});

test('图片提示：有图才出现，路径逐条列出', () => {
  assert.equal(buildImageHint([]), '');
  const p = buildReplyPrompt({ imagePaths: ['C:/a.png', 'C:/b.png'], text: '看' });
  assert.match(p, /【主人刚发了图片/);
  assert.match(p, /C:\/a\.png/);
  assert.match(p, /C:\/b\.png/);
  assert.match(p, /read_image/);
});

test('自述层插在角色卡之后、记忆之前', () => {
  const p = buildReplyPrompt({ persona: 'P', selfBlock: '【你自己的修订】S', memory: 'M', text: 't' });
  const iP = p.indexOf('【你的角色卡】');
  const iS = p.indexOf('【你自己的修订】');
  const iM = p.indexOf('M');
  assert.ok(iP >= 0 && iS > iP && iM > iS, '顺序应为 角色卡 → 自述 → 记忆');
});

test('群聊：用群聊块替代记忆，且不带私聊记忆', () => {
  const p = buildReplyPrompt({
    groupBlock: '【QQ 群聊】群号：123 说话的人：小明（456）他说：在吗',
    memory: '【记忆】私密内容',
    text: '在吗',
    isGroup: true,
  });
  assert.match(p, /群号：123/);
  assert.ok(!p.includes('私密内容'), '群聊不应注入私聊记忆');
  assert.match(p, /【QQ 群聊】你在群里/);
});

test('群聊规则：不含「记：」与「[自述:]」（避免群里写私密记忆）', () => {
  const p = buildReplyPrompt({ groupBlock: 'G', text: 't', isGroup: true });
  assert.ok(!p.includes('记：xxx'));
  assert.ok(!p.includes('[自述: 内容]'));
});
