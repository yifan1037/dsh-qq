/**
 * 极简 ZIP 读取器（只读，纯 Node，无依赖）
 *
 * 用途：docx / xlsx / pptx 都是 ZIP 包，需要把里面的 XML 取出来。
 * 支持：store(method=0) 与 deflate(method=8)，zip 中央目录定位。
 * 不支持：zip64、加密、多卷 —— 遇到就直接报错，不做静默降级。
 */
import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

/** 在尾部 64KB 内从后向前找 EOCD（允许 zip 尾部有注释）。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 读取 zip 中的所有文件条目。
 * @param {Buffer} buf
 * @param {{ maxEntries?: number, maxTotalBytes?: number }} [opts]
 * @returns {Map<string, Buffer>} 文件名 → 内容
 */
export function readZip(buf, { maxEntries = 4000, maxTotalBytes = 256 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 zip（文件太小）');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录）');

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  if (count > maxEntries) throw new Error(`zip 条目过多（${count}）`);

  const out = new Map();
  let total = 0;

  for (let i = 0; i < count; i++) {
    if (ptr + 46 > buf.length) throw new Error('zip 中央目录越界');
    if (buf.readUInt32LE(ptr) !== SIG_CEN) throw new Error('zip 中央目录损坏');

    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    // 目录条目跳过
    if (name.endsWith('/')) continue;
    // 防路径穿越：调用方只按键取值，但这里也顺手拦一下
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`zip 含非法路径：${name}`);

    if (localOff + 30 > buf.length) throw new Error(`zip 本地头越界：${name}`);
    if (buf.readUInt32LE(localOff) !== SIG_LOC) throw new Error(`zip 本地头损坏：${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 method=${method}：${name}`);

    total += data.length;
    if (total > maxTotalBytes) throw new Error('zip 解压后体积过大');
    out.set(name.replace(/\\/g, '/'), data);
  }
  return out;
}

/** 按名取条目并转成 UTF-8 文本，取不到返回 null。 */
export function readZipText(zip, name) {
  const b = zip.get(name);
  return b ? b.toString('utf8') : null;
}
