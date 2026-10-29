// 消息段编解码 + 媒体标记解析（纯函数，无网络）
import test from 'node:test';
import assert from 'node:assert/strict';

const S = await import('../lib/onebot-segments.mjs');
const { extractMedia } = await import('../lib/wake.mjs');

test('CQ 码往返：文本转义 + at', () => {
  const segs = [{ type: 'text', text: '你好[世界],&' }, { type: 'at', qq: '10001' }];
  const cq = S.toCqCode(segs);
  assert.equal(cq, '你好&#91;世界&#93;&#44;&amp;[CQ:at,qq=10001]');
  assert.deepEqual(S.fromCqCode(cq), segs);
});

test('OneBot 段数组往返：引用 + 图片 + 文本', () => {
  const segs = [
    { type: 'reply', id: 'abc' },
    { type: 'image', file: 'base64://iVBOR' },
    { type: 'text', text: '看这个' },
  ];
  const ob = S.toOneBot(segs);
  assert.deepEqual(ob[0], { type: 'reply', data: { id: 'abc' } });
  assert.deepEqual(S.fromOneBot(ob), segs);
});

test('纯文本视图：图片/表情/@ 变占位符', () => {
  const segs = [
    { type: 'text', text: '看' },
    { type: 'image', file: 'x.png' },
    { type: 'at', qq: 'all' },
    { type: 'face', id: '178' },
    { type: 'text', text: '这个' },
  ];
  assert.equal(S.toPlainText(segs), '看[图片]@全体[表情]这个');
});

test('归一化：合并相邻文本、丢弃空段、限制数量', () => {
  const out = S.normalize([
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' },
    { type: 'text', text: '' },
    { type: 'image', file: '' },
    { type: 'at', qq: null },
  ]);
  assert.deepEqual(out, [{ type: 'text', text: 'ab' }]);
  const many = Array.from({ length: 100 }, (_, i) => ({ type: 'text', text: String(i) }));
  assert.equal(S.normalize(many).length, 1); // 相邻文本会合并
});

test('firstReplyId / imagesOf', () => {
  const segs = [{ type: 'text', text: 'x' }, { type: 'reply', id: '42' }, { type: 'image', file: 'a.png' }];
  assert.equal(S.firstReplyId(segs), '42');
  assert.equal(S.imagesOf(segs).length, 1);
  assert.equal(S.firstReplyId([]), '');
});

test('extractMedia：五种标记', () => {
  assert.deepEqual(extractMedia('好呀\n[图片:C:/x/a.png]\n看').segments, [{ type: 'image', file: 'C:/x/a.png' }]);
  assert.deepEqual(extractMedia('哼[表情:178]').segments, [{ type: 'face', id: '178' }]);
  assert.deepEqual(extractMedia('[引用:abc]对呀').segments, [{ type: 'reply', id: 'abc' }]);
  assert.deepEqual(extractMedia('[拍一拍]干嘛').segments, [{ type: 'poke', qq: '' }]);
  assert.deepEqual(extractMedia('[文件:/tmp/a.txt]给你').segments, [{ type: 'file', file: '/tmp/a.txt' }]);
  assert.equal(extractMedia('普通文字').segments.length, 0);
});

test('extractMedia：非法标记原样保留', () => {
  const r = extractMedia('这个 [图片: ] 空路径');
  assert.equal(r.segments.length, 0);
  assert.match(r.text, /\[图片: \]/);
});
