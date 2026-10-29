// 媒体落地：本地路径 / base64 / 批量 / 清理（临时 HOME，无网络）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-media-test-'));
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;

const { downloadImage, downloadImages, mediaDir, pruneMedia } = await import('../lib/media.mjs');

// 造一张 1x1 PNG（最小合法 PNG）
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
  '0d0a2db40000000049454e44ae426082', 'hex'
);

function makeLocalPng(name = 'src.png') {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, PNG_1X1);
  return p;
}

test('media 目录会被创建', () => {
  const dir = mediaDir();
  assert.ok(fs.existsSync(dir));
  assert.ok(dir.endsWith(path.join('.dsh', 'qq-native', 'media')));
});

test('本地绝对路径 → 复制进 media', async () => {
  const src = makeLocalPng();
  const out = await downloadImage({ file: src }, { log: () => {} });
  assert.ok(out && fs.existsSync(out));
  assert.equal(fs.statSync(out).size, PNG_1X1.length);
  assert.ok(out.startsWith(mediaDir()));
});

test('base64:// → 写入 media', async () => {
  const out = await downloadImage({ file: 'base64://' + PNG_1X1.toString('base64') }, { log: () => {} });
  assert.ok(out && fs.existsSync(out));
  assert.equal(fs.statSync(out).size, PNG_1X1.length);
});

test('文件不存在 / 空路径 → 返回空字符串', async () => {
  assert.equal(await downloadImage({ file: path.join(TMP, 'nope.png') }), '');
  assert.equal(await downloadImage({}), '');
  assert.equal(await downloadImage({ file: 'weird-thing' }), '');
});

test('批量：只落有效项，受 limit 限制', async () => {
  const src = makeLocalPng('b.png');
  const out = await downloadImages([{ file: src }, { file: src }, { file: src }, { file: '' }], { limit: 2 });
  assert.equal(out.length, 2);
  for (const p of out) assert.ok(fs.existsSync(p));
});

test('pruneMedia：按天数清理', async () => {
  const src = makeLocalPng('old.png');
  const old = await downloadImage({ file: src });
  const past = Date.now() - 10 * 86400000;
  fs.utimesSync(old, past / 1000, past / 1000);
  const removed = pruneMedia({ days: 3 });
  assert.ok(removed >= 1);
  assert.equal(pruneMedia({ days: 999 }), 0);
});
