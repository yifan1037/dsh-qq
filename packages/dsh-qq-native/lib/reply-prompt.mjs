// reply-prompt.mjs —— 组装回复用的 prompt（纯函数，方便单测与 dry-run）
//
// 私聊：
//   【你的角色卡】…（首轮）
//   【你自己的修订】…（自述层，变化时）
//   【主人刚发了图片…】…（有图时）
//   记忆块 / 群聊块
//   要求 + 主人说：xxx
//
// 群聊：用群聊块替代记忆块，并要求"像群里一员"。

const RULES_PRIVATE = [
  '要求：只写回复文本，不要调用任何工具，不要解释。想分条就用换行。',
  '如果这一轮你不想接话，只输出 [SILENT]。',
  '如果这轮有值得长期记住的事（他的状态、约定、在意的事），单独一行写「记：xxx」——我会存进记忆库，不发到 QQ。',
  '如果你想调整自己的表达方式或偏好，可以单独一行写「[自述: 内容]」——会写进你自己的修订层（不覆盖底座，限 4KB，每天 1 次），不发 QQ。',
  '你还能发媒体（直接写标记，我会处理）：[图片:本地路径或URL]、[表情:数字ID]、[引用:消息ID]、[文件:本地路径]、[拍一拍]。',
];

const RULES_GROUP = [
  '要求：只写回复文本，不要调用任何工具。',
  '如果这一轮你不想接话，只输出 [SILENT]。',
  '表情/引用/拍一拍同样用标记：[表情:ID]、[引用:消息ID]、[拍一拍]。',
];

export function buildImageHint(imagePaths = []) {
  const list = (imagePaths || []).filter(Boolean);
  if (!list.length) return '';
  return (
    '【主人刚发了图片，已保存到本地】\n' +
    list.map((p) => '· ' + p).join('\n') +
    '\n如果你有 read_image 工具，可以看一眼再回话；看不到就直说看不到。\n'
  );
}

export function buildReplyPrompt({
  persona = '',
  selfBlock = '',
  imagePaths = [],
  memory = '',
  groupBlock = '',
  text = '',
  isGroup = false,
  participationHint = '',
} = {}) {
  const parts = [];
  if (persona) parts.push('【你的角色卡】\n' + persona + '\n');
  if (selfBlock) parts.push(selfBlock);
  const img = buildImageHint(imagePaths);
  if (img) parts.push(img);
  if (participationHint) parts.push(participationHint);
  if (isGroup) {
    if (groupBlock) parts.push(groupBlock);
    parts.push('【QQ 群聊】你在群里，回一句自然的话就好。');
    parts.push(...RULES_GROUP);
  } else {
    if (memory) parts.push(memory);
    parts.push('【QQ 私聊】主人在 QQ 上对你说了话，请直接写你要回的内容。');
    parts.push(...RULES_PRIVATE);
  }
  parts.push('主人说：' + text);
  return parts.join('\n');
}
