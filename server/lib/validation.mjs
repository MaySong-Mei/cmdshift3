import { createHash } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const FIELD_KEYS = ['shipped', 'decision', 'why', 'blocker', 'next'];
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const WC_ID = new RegExp(`^wc_${UUID}$`);
const ITEM_ID = new RegExp(`^it_${UUID}$`);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function validCommitId(id) { return typeof id === 'string' && WC_ID.test(id); }
export function text(value, name, max, min = 0) {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(400, 'invalid_input', `${name} must be ${min}–${max} characters.`);
  return value;
}
export function source(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_input', 'source is required.');
  if (!['region', 'window', 'fullscreen', 'upload'].includes(value.capture_kind)) fail(400, 'invalid_input', 'Unsupported capture_kind.');
  return { app_name: text(value.app_name ?? '', 'app_name', 256), window_title: text(value.window_title ?? '', 'window_title', 512), capture_kind: value.capture_kind };
}
export function decodePNG(value) {
  if (typeof value !== 'string') fail(400, 'invalid_png', 'A PNG capture is required.');
  const base64 = value.replace(/^data:image\/png;base64,/, '');
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) fail(400, 'invalid_png', 'Invalid base64 PNG.');
  const image = Buffer.from(base64, 'base64');
  if (image.length > 8 * 1024 * 1024) fail(413, 'image_too_large', 'PNG exceeds 8 MiB.');
  if (image.length < 33 || !image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || image.readUInt32BE(8) !== 13 || image.toString('ascii', 12, 16) !== 'IHDR') fail(400, 'invalid_png', 'Invalid PNG header.');
  const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
  if (!width || !height || width > 32768 || height > 32768 || width * height > 100_000_000) fail(400, 'invalid_png', 'PNG dimensions are invalid or exceed the capture limit.');
  const bitDepth = image[24], colorType = image[25];
  const validDepths = { 0: [1,2,4,8,16], 2: [8,16], 3: [1,2,4,8], 4: [8,16], 6: [8,16] };
  if (!validDepths[colorType]?.includes(bitDepth) || image[26] !== 0 || image[27] !== 0 || ![0,1].includes(image[28])) fail(400, 'invalid_png', 'Invalid PNG image format.');
  let offset = 8, sawData = false, dataBytes = 0, sawEnd = false;
  while (offset < image.length) {
    if (image.length - offset < 12) fail(400, 'invalid_png', 'Truncated PNG chunk.');
    const length = image.readUInt32BE(offset);
    if (length > image.length - offset - 12) fail(400, 'invalid_png', 'Truncated PNG chunk data.');
    const type = image.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) fail(400, 'invalid_png', 'Invalid PNG chunk type.');
    if ((offset === 8 && (type !== 'IHDR' || length !== 13)) || (offset !== 8 && type === 'IHDR')) fail(400, 'invalid_png', 'PNG must contain exactly one initial IHDR.');
    const checksumOffset = offset + 8 + length;
    if (crc32(image.subarray(offset + 4, checksumOffset)) !== image.readUInt32BE(checksumOffset)) fail(400, 'invalid_png', 'PNG chunk checksum is invalid.');
    offset += length + 12;
    if (type === 'IDAT') { sawData = true; dataBytes += length; }
    if (type === 'IEND') {
      if (length !== 0 || offset !== image.length) fail(400, 'invalid_png', 'IEND must be the final empty PNG chunk.');
      sawEnd = true;
      break;
    }
  }
  if (!sawData || !dataBytes || !sawEnd) fail(400, 'invalid_png', 'PNG requires image data and a complete IEND.');
  return image;
}
export function annotations(value = []) {
  if (!Array.isArray(value) || value.length > 1000) fail(400, 'invalid_input', 'annotations must contain at most 1000 items.');
  return value.map(item => {
    if (!item || !['rect', 'arrow', 'text', 'highlight'].includes(item.type)) fail(400, 'invalid_input', 'Unsupported annotation type.');
    const { x, y, w, h } = item;
    if (![x,y,w,h].every(Number.isFinite) || x < 0 || x > 1 || y < 0 || y > 1 || x + w < 0 || x + w > 1 || y + h < 0 || y + h > 1 || (item.type !== 'arrow' && (w < 0 || h < 0))) fail(400, 'invalid_input', 'Annotation coordinates must stay within the image.');
    if (!/^#[0-9a-fA-F]{6}$/.test(item.color)) fail(400, 'invalid_input', 'Annotation color must be #RRGGBB.');
    return { type: item.type, x, y, w, h, ...(item.text === undefined ? {} : { text: text(item.text, 'annotation text', 1000) }), color: item.color };
  });
}
export function fields(value = {}, existingCommits = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_input', 'fields must be an object.');
  if (Object.keys(value).some(key => !FIELD_KEYS.includes(key))) fail(400, 'invalid_input', 'Unsupported work field.');
  const existing = new Map();
  for (const commit of existingCommits) for (const key of FIELD_KEYS) for (const item of commit.fields[key] ?? []) existing.set(item.id, key);
  const seen = new Set();
  return Object.fromEntries(FIELD_KEYS.map(key => {
    const items = value[key] ?? [];
    if (!Array.isArray(items) || items.length > 100) fail(400, 'invalid_input', `${key} must contain at most 100 items.`);
    return [key, items.map(item => {
      if (!item || !ITEM_ID.test(item.id)) fail(400, 'invalid_input', 'Work items require stable it_<uuid> IDs.');
      if (seen.has(item.id) || existing.has(item.id)) fail(409, 'item_id_conflict', 'Work item IDs must be unique throughout the project.');
      seen.add(item.id);
      const normalized = { id: item.id, text: text(item.text, 'field text', 4000, 1) };
      if (item.resolves !== undefined) {
        if (key !== 'shipped' || !Array.isArray(item.resolves) || item.resolves.length > 100 || item.resolves.some(id => typeof id !== 'string')) fail(400, 'invalid_input', 'Only shipped items may resolve earlier blocker or next items.');
        if (item.resolves.some(id => !['blocker', 'next'].includes(existing.get(id)))) fail(409, 'invalid_reference', 'Resolved items must be an existing blocker or next in this project.');
        normalized.resolves = [...new Set(item.resolves)];
      }
      return normalized;
    })];
  }));
}
function canonical(value, depth = 0) {
  if (depth > 64) fail(400, 'invalid_input', 'Request JSON nesting exceeds 64 levels.');
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)]));
  return value;
}
export function requestHash(body, userId) { return createHash('sha256').update(JSON.stringify(canonical({ body, userId }))).digest('hex'); }
export function foldState(commits) {
  const state = { shipped: [], decisions: [], blockers: [], next: [] };
  const resolved = new Set();
  for (const commit of [...commits].sort((a,b) => a.sequence - b.sequence)) {
    for (const [key, stateKey] of [['shipped','shipped'],['decision','decisions'],['blocker','blockers'],['next','next']]) for (const item of commit.fields[key] ?? []) {
      const entry = { ...item, commit_id: commit.id, author: commit.author, created_at: commit.created_at, git_sha: commit.git.sha };
      state[stateKey].push(entry);
      if (key === 'shipped') for (const id of item.resolves ?? []) resolved.add(id);
    }
  }
  state.blockers = state.blockers.filter(item => !resolved.has(item.id));
  state.next = state.next.filter(item => !resolved.has(item.id));
  return state;
}
