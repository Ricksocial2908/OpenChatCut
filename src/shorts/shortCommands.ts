// Deterministic short-movie edits. These run in the editor with no model key:
// slash commands and a small set of phrases reorder, trim, cut, fade, mute,
// assemble a timed short, and open export. Anything else stays with the Agent.
import { t } from '../i18n/locale';
import type { EditorCommands } from '../editor/storeCommands';
import type { MediaAsset, ProjectDoc, TimelineItem, TimelineState, TrackId } from '../editor/types';
import { defaultTrackId, trackEnd } from '../editor/types';

export interface ShortProject {
  commands: EditorCommands;
  getState: () => TimelineState;
  getDoc: () => ProjectDoc;
}

export type DurationSpec = { seconds: number } | { frames: number };

export type ClipSelector =
  | { all: true }
  | { index: number }
  | { name: string };

export type ShortCommand =
  | { type: 'order'; names: string[] | null }
  | { type: 'trim-intro'; amount: DurationSpec; selector: ClipSelector }
  | { type: 'trim-outro'; amount: DurationSpec; selector: ClipSelector }
  | { type: 'cap'; amount: DurationSpec; selector: ClipSelector }
  | { type: 'remove'; selector: Exclude<ClipSelector, { all: true }> }
  | { type: 'fades'; amount: DurationSpec; selector: ClipSelector }
  | { type: 'mute'; muted: boolean; selector: ClipSelector }
  | { type: 'short'; seconds: number }
  | { type: 'export' }
  | { type: 'help' };

export interface ShortSlashEntry {
  readonly id: string;
  readonly verb: string;
  readonly insert: string;
  readonly label: string;
  readonly description: string;
}

export const SHORT_SLASH_COMMANDS: readonly ShortSlashEntry[] = [
  { id: 'order', verb: 'order', insert: '/order', label: '排列片段', description: '按名称把视频和图片接到时间线上' },
  { id: 'trim', verb: 'trim', insert: '/trim', label: '剪掉片头', description: '每段去掉开头 1 秒，可写 /trim 0.5s' },
  { id: 'fades', verb: 'fades', insert: '/fades', label: '加上淡入淡出', description: '每段画面 0.5 秒淡化，可写 /fades 0.3s' },
  { id: 'short', verb: 'short', insert: '/short 30s', label: '做成 30 秒短片', description: '按名称排列并压到目标时长' },
  { id: 'mute', verb: 'mute', insert: '/mute', label: '静音', description: '关掉画面片段的原声' },
  { id: 'cut', verb: 'cut', insert: '/cut 3s', label: '切短', description: '/cut 3s 限制每段长度，/cut clip 2 删掉一段' },
  { id: 'export', verb: 'export', insert: '/export', label: '导出 MP4', description: '打开导出窗口，选择 MP4' },
  { id: 'help', verb: 'help', insert: '/help', label: '短片指令', description: '列出不需要模型的剪辑指令' },
];

export interface ShortOutcome {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
  readonly openExport?: boolean;
}

const VISUAL = new Set<TimelineItem['kind']>(['video', 'image', 'gif']);
const POOL_VISUAL = new Set<MediaAsset['kind']>(['video', 'image', 'gif']);
const AMOUNT_RE = /(\d+(?:\.\d+)?)\s*(frames|frame|seconds|second|secs|sec|秒|帧|s|f)\b/i;
const DEFAULT_TRIM: DurationSpec = { seconds: 1 };
const DEFAULT_FADE: DurationSpec = { seconds: 0.5 };

function normalize(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').replace(/^(please|请)\s+/i, '').replace(/[。．.！!？?]+$/g, '');
}

function splitNames(rest: string): string[] | null {
  const cleaned = rest.replace(/\bthen\b/gi, ',').replace(/然后/g, ',');
  if (!/[,，、]/.test(cleaned)) return null;
  const parts = cleaned.split(/[,，、]/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

function parseAmount(text: string): DurationSpec | null {
  const match = text.match(AMOUNT_RE);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2]!.toLowerCase();
  if (unit === 'f' || unit === 'frame' || unit === 'frames' || unit === '帧') return { frames: Math.round(value) };
  return { seconds: value };
}

function framesOf(amount: DurationSpec, fps: number): number {
  const frames = 'frames' in amount ? amount.frames : amount.seconds * fps;
  return Math.max(1, Math.round(frames));
}

function amountLabel(amount: DurationSpec): string {
  return 'frames' in amount ? String(amount.frames) : String(amount.seconds);
}

function parseSelector(text: string): ClipSelector | null {
  if (/\blast\b|最后一个/.test(text)) return { index: -1 };
  const indexed = text.match(/(?:clip|片段|镜头|#|第)\s*(\d+)/i);
  if (indexed) return { index: Number(indexed[1]) };
  if (/第一个/.test(text) || /\bfirst\b/i.test(text)) return { index: 1 };
  if (/第二个/.test(text) || /\bsecond\b/i.test(text)) return { index: 2 };
  if (/第三个/.test(text) || /\bthird\b/i.test(text)) return { index: 3 };
  const cleaned = text
    .replace(AMOUNT_RE, ' ')
    .replace(/\b(intros?|outros?|start|end|the|of|off|from|each|clips?|all|to|max|at most)\b/gi, ' ')
    .replace(/片头|片尾|开头|结尾|每段|全部|所有|最多|淡入淡出|淡化/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“]|["”]$/g, '');
  return cleaned ? { name: cleaned } : null;
}

function parseTrim(rest: string, fallback: 'intro' | 'outro' = 'intro'): ShortCommand {
  const outro = /outro|片尾|结尾/.test(rest);
  const amount = parseAmount(rest) ?? DEFAULT_TRIM;
  const selector = parseSelector(rest.replace(/\b(outro|intro)s?\b/gi, ' ')) ?? { all: true };
  return outro || fallback === 'outro'
    ? { type: 'trim-outro', amount, selector }
    : { type: 'trim-intro', amount, selector };
}

function parseSlash(body: string): ShortCommand | null {
  const trimmed = body.trim();
  if (!trimmed) return { type: 'help' };
  const verb = (trimmed.split(/\s+/)[0] ?? '').toLowerCase();
  const rest = trimmed.slice(verb.length).trim();
  switch (verb) {
    case 'order':
    case 'arrange':
    case 'sequence':
      return { type: 'order', names: splitNames(rest) ?? (rest ? [rest] : null) };
    case 'trim':
    case 'trim-intro':
      return parseTrim(rest, 'intro');
    case 'trim-outro':
    case 'outro':
      return parseTrim(rest || 'outro', 'outro');
    case 'fade':
    case 'fades':
      return { type: 'fades', amount: parseAmount(rest) ?? DEFAULT_FADE, selector: parseSelector(rest) ?? { all: true } };
    case 'mute':
      return { type: 'mute', muted: true, selector: parseSelector(rest) ?? { all: true } };
    case 'unmute':
      return { type: 'mute', muted: false, selector: parseSelector(rest) ?? { all: true } };
    case 'cut':
    case 'cap': {
      const amount = parseAmount(rest);
      const selector = parseSelector(rest);
      if (amount && !selector) return { type: 'cap', amount, selector: { all: true } };
      if (amount && selector && !('all' in selector)) return { type: 'cap', amount, selector };
      if (selector && !('all' in selector)) return { type: 'remove', selector };
      return null;
    }
    case 'short':
    case 'make': {
      const amount = parseAmount(rest);
      return { type: 'short', seconds: amount && 'seconds' in amount ? amount.seconds : 30 };
    }
    case 'export':
      return { type: 'export' };
    case 'help':
    case 'shorts':
    case '?':
      return { type: 'help' };
    default:
      return null;
  }
}

function parseNatural(text: string): ShortCommand | null {
  const exact = text.toLowerCase();
  if (/^(order these clips|arrange these clips|assemble these clips|put these clips in order|排列这些片段|按名称排列这些片段|把这些片段按名称排好)$/i.test(text)) {
    return { type: 'order', names: null };
  }
  const ordered = text.match(/^(?:order|arrange|sequence)\s+(.+)$/i);
  if (ordered && /[,，、]|\bthen\b|然后/.test(ordered[1]!)) {
    return { type: 'order', names: splitNames(ordered[1]!) };
  }
  if (/^(trim intros?|trim the intros?|剪掉片头|剪掉每段开头|去掉片头)$/i.test(text)) {
    return { type: 'trim-intro', amount: DEFAULT_TRIM, selector: { all: true } };
  }
  if (/^(trim outros?|trim the outros?|剪掉片尾|剪掉每段结尾|去掉片尾)$/i.test(text)) {
    return { type: 'trim-outro', amount: DEFAULT_TRIM, selector: { all: true } };
  }
  const trimStart = text.match(/^trim\s+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds|second|秒)(?:\s+off the start|\s+from the intros?)?$/i);
  if (trimStart) return { type: 'trim-intro', amount: { seconds: Number(trimStart[1]) }, selector: { all: true } };
  if (/^(add fades?|add fade in and out|加上淡入淡出|给片段加上淡入淡出|加淡化)$/i.test(text)) {
    return { type: 'fades', amount: DEFAULT_FADE, selector: { all: true } };
  }
  const short = text.match(/^(?:make|build)\s+(?:me\s+)?(?:a\s+)?(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds|second|-second|秒)\s*(?:short|短片)$/i)
    ?? text.match(/^做成\s*(\d+(?:\.\d+)?)\s*秒短片$/);
  if (short) return { type: 'short', seconds: Number(short[1]) };
  if (/^(make a short|做成短片|做成 30 秒短片|make a 30s short)$/i.test(text)) return { type: 'short', seconds: 30 };
  if (/^(export|export mp4|export the short|export an mp4|export video|导出|导出成片|导出短片|导出 mp4)$/i.test(exact) || /^(导出|导出成片|导出短片)$/.test(text)) {
    return { type: 'export' };
  }
  if (/^(mute|mute clips|mute all clips|静音|关掉原声|关闭原声)$/i.test(text)) {
    return { type: 'mute', muted: true, selector: { all: true } };
  }
  if (/^(unmute|unmute clips|恢复声音|取消静音)$/i.test(text)) {
    return { type: 'mute', muted: false, selector: { all: true } };
  }
  const cap = text.match(/^cut each clip to\s+(\d+(?:\.\d+)?)s$/i) ?? text.match(/^每段最多\s*(\d+(?:\.\d+)?)\s*秒$/);
  if (cap) return { type: 'cap', amount: { seconds: Number(cap[1]) }, selector: { all: true } };
  return null;
}

/** Null means this text is not a local short command and should go to the Agent. */
export function parseShortCommand(raw: string): ShortCommand | null {
  const text = normalize(raw);
  if (!text) return null;
  if (text.startsWith('/')) {
    const body = text.slice(1).trim();
    if (body.toLowerCase().startsWith('skill:')) return null;
    return parseSlash(body);
  }
  return parseNatural(text);
}

/** Slash-menu rows for a `/` query. Skill commands (`/skill:`) are not included. */
export function matchShortSlash(query: string | null): readonly ShortSlashEntry[] {
  if (query === null) return [];
  const q = query.trim().toLowerCase();
  if (!q) return SHORT_SLASH_COMMANDS;
  const verb = q.split(/\s+/)[0] ?? '';
  return SHORT_SLASH_COMMANDS.filter((entry) => entry.verb.startsWith(verb) || q.startsWith(entry.verb));
}

function visualClips(state: TimelineState): TimelineItem[] {
  return state.items
    .filter((item) => VISUAL.has(item.kind))
    .sort((a, b) => a.startFrame - b.startFrame || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

function poolVisuals(doc: ProjectDoc): MediaAsset[] {
  return doc.assets.filter((asset) => POOL_VISUAL.has(asset.kind));
}

function natural(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function videoTrackOf(state: TimelineState): TrackId | null {
  return defaultTrackId(state, 'video');
}

function namesOf(items: readonly { name: string }[]): string {
  return items.map((item, index) => `${index + 1}. ${item.name}`).join(', ');
}

function secondsLabel(frames: number, fps: number): string {
  const seconds = frames / Math.max(1, fps);
  return (Math.round(seconds * 10) / 10).toString();
}

function assetFor(doc: ProjectDoc, item: TimelineItem): MediaAsset | undefined {
  return doc.assets.find((asset) => asset.id === item.sourceAssetId)
    ?? doc.assets.find((asset) => asset.name === item.name && asset.src === item.src);
}

function sourceFrames(doc: ProjectDoc, item: TimelineItem): number {
  const asset = assetFor(doc, item);
  if (asset && asset.durationInFrames > 0) return asset.durationInFrames;
  return (item.srcInFrame ?? 0) + item.durationInFrames;
}

interface ResolvedClip {
  readonly item?: TimelineItem;
  readonly asset?: MediaAsset;
  readonly name: string;
}

function availableNames(state: TimelineState, doc: ProjectDoc): string {
  const clips = visualClips(state);
  const source = clips.length ? clips : poolVisuals(doc);
  return source.map((item) => item.name).join(', ') || t('（无）');
}

function resolveOne(state: TimelineState, doc: ProjectDoc, selector: ClipSelector): { ok: true; clip: ResolvedClip } | { ok: false; outcome: ShortOutcome } {
  const clips = visualClips(state);
  const pool = poolVisuals(doc);
  if ('all' in selector) {
    return { ok: false, outcome: fail('need-target', t('请点名一个片段，例如 clip 2 或文件名。')) };
  }
  if ('index' in selector) {
    if (clips.length) {
      const index = selector.index < 0 ? clips.length - 1 : selector.index - 1;
      const found = clips[index];
      if (!found) {
        return { ok: false, outcome: fail('missing-index', t('没有第 {n} 个片段。当前有 {count} 个：{available}', {
          n: selector.index < 0 ? clips.length : selector.index,
          count: clips.length,
          available: availableNames(state, doc),
        })) };
      }
      return { ok: true, clip: { item: found, name: found.name } };
    }
    const index = selector.index < 0 ? pool.length - 1 : selector.index - 1;
    const found = pool[index];
    if (!found) {
      return { ok: false, outcome: fail('missing-index', t('没有第 {n} 个片段。当前有 {count} 个：{available}', {
        n: selector.index < 0 ? pool.length : selector.index,
        count: pool.length,
        available: availableNames(state, doc),
      })) };
    }
    return { ok: true, clip: { asset: found, name: found.name } };
  }
  const needle = selector.name.trim().toLowerCase();
  const score = (name: string) => {
    const value = name.toLowerCase();
    const stem = value.replace(/\.[a-z0-9]+$/, '');
    if (value === needle || stem === needle) return 2;
    if (value.includes(needle) || stem.includes(needle)) return 1;
    return 0;
  };
  const clipHits = clips.map((item) => ({ item, rank: score(item.name) })).filter((hit) => hit.rank > 0);
  const poolHits = pool.map((asset) => ({ asset, rank: score(asset.name) })).filter((hit) => hit.rank > 0);
  const bestRank = Math.max(0, ...clipHits.map((hit) => hit.rank), ...poolHits.map((hit) => hit.rank));
  const chosenClips = clipHits.filter((hit) => hit.rank === bestRank);
  const chosenPool = chosenClips.length ? [] : poolHits.filter((hit) => hit.rank === bestRank);
  const count = chosenClips.length + chosenPool.length;
  if (!count) {
    return { ok: false, outcome: fail('missing-name', t('找不到名为“{name}”的片段。当前可用：{available}', {
      name: selector.name,
      available: availableNames(state, doc),
    })) };
  }
  if (count > 1 && bestRank < 2) {
    const names = [...chosenClips.map((hit) => hit.item.name), ...chosenPool.map((hit) => hit.asset.name)];
    return { ok: false, outcome: fail('ambiguous-name', t('“{name}”匹配到多个片段，请写得更具体：{available}', {
      name: selector.name,
      available: names.join(', '),
    })) };
  }
  if (chosenClips.length) return { ok: true, clip: { item: chosenClips[0]!.item, name: chosenClips[0]!.item.name } };
  return { ok: true, clip: { asset: chosenPool[0]!.asset, name: chosenPool[0]!.asset.name } };
}

function targetsFor(state: TimelineState, doc: ProjectDoc, selector: ClipSelector): { ok: true; clips: ResolvedClip[] } | { ok: false; outcome: ShortOutcome } {
  if ('all' in selector) {
    const clips = visualClips(state);
    if (!clips.length) return { ok: false, outcome: fail('need-timeline', t('时间线上还没有画面片段。先导入，或说「排列这些片段」。')) };
    return { ok: true, clips: clips.map((item) => ({ item, name: item.name })) };
  }
  const one = resolveOne(state, doc, selector);
  if (!one.ok) return one;
  if (!one.clip.item) return { ok: false, outcome: fail('not-on-timeline', t('“{name}”还在素材库里。先说「排列这些片段」，再剪这一段。', { name: one.clip.name })) };
  return { ok: true, clips: [one.clip] };
}

function fail(code: string, message: string): ShortOutcome {
  return { ok: false, code, message };
}

function ok(code: string, message: string, openExport?: boolean): ShortOutcome {
  return openExport ? { ok: true, code, message, openExport } : { ok: true, code, message };
}

function helpText(): string {
  return [
    t('这些短片指令在本地执行，不需要 API key。也可以直接说同样的话。'),
    '/order — ' + t('按名称把视频和图片接到时间线。/order a.mp4, b.mp4 按你写的顺序。'),
    '/trim — ' + t('每段剪掉开头 1 秒。/trim 0.5s、/trim outro、/trim clip 2。'),
    '/cut 3s — ' + t('每段最长 3 秒。/cut clip 2 删掉第 2 段并靠拢。'),
    '/fades — ' + t('加上 0.5 秒淡入淡出。'),
    '/mute — ' + t('关掉原声。/unmute 恢复。'),
    '/short 30s — ' + t('排列并收成大约 30 秒。'),
    '/export — ' + t('打开导出窗口，选择 MP4。'),
    t('片段可用文件名、clip 2、第2个或最后一个。更开放的要求仍交给 Agent，需要在设置里配置模型。'),
  ].join('\n');
}

function ensureTrack(project: ShortProject): TrackId | null {
  return videoTrackOf(project.getState());
}

function placeResolved(project: ShortProject, entries: readonly ResolvedClip[]): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    const track = ensureTrack(project);
    if (!track) return ids;
    if (entry.item) {
      const live = project.getState().items.find((item) => item.id === entry.item!.id);
      if (!live) continue;
      if (live.track !== track) {
        project.commands.moveItem(live.id, { track, startFrame: trackEnd(project.getState(), track) });
      }
      ids.push(live.id);
      continue;
    }
    if (!entry.asset) continue;
    const existing = project.getState().items.find((item) => VISUAL.has(item.kind) && (
      item.sourceAssetId === entry.asset!.id || (item.name === entry.asset!.name && item.src === entry.asset!.src)
    ));
    if (existing) {
      if (existing.track !== track) {
        project.commands.moveItem(existing.id, { track, startFrame: trackEnd(project.getState(), track) });
      }
      ids.push(existing.id);
      continue;
    }
    ids.push(project.commands.addMediaItem(entry.asset, { track, startFrame: trackEnd(project.getState(), track) }));
  }
  return ids;
}

function packIds(project: ShortProject, ids: readonly string[]): void {
  const track = ensureTrack(project);
  if (!track || !ids.length) return;
  if (ids.length === 1) {
    project.commands.moveItem(ids[0]!, { track, startFrame: 0 });
    return;
  }
  let cursor = 0;
  const starts: Record<string, number> = {};
  const items = project.getState().items;
  for (const id of ids) {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) continue;
    starts[id] = cursor;
    cursor += item.durationInFrames;
  }
  project.commands.reorderTrackItems(track, [...ids], starts);
}

function orderEntries(project: ShortProject, names: string[] | null): { ok: true; ids: string[]; ordered: ResolvedClip[] } | { ok: false; outcome: ShortOutcome } {
  const state = project.getState();
  const doc = project.getDoc();
  let ordered: ResolvedClip[];
  if (names?.length) {
    const resolved: ResolvedClip[] = [];
    const used = new Set<string>();
    for (const name of names) {
      const one = resolveOne(state, doc, { name });
      if (!one.ok) return one;
      const key = one.clip.item?.id ?? one.clip.asset?.id ?? one.clip.name;
      if (used.has(key)) continue;
      used.add(key);
      resolved.push(one.clip);
    }
    const claimed = new Set(resolved.flatMap((clip) => [
      clip.item?.id, clip.item?.sourceAssetId, clip.item?.src, clip.asset?.id, clip.asset?.src,
    ].filter((value): value is string => !!value)));
    const extraPlaced = visualClips(state)
      .filter((item) => !claimed.has(item.id)
        && !(item.sourceAssetId && claimed.has(item.sourceAssetId))
        && !(item.src && claimed.has(item.src)))
      .map((item) => ({ item, name: item.name }));
    const extraPool = poolVisuals(doc)
      .filter((asset) => !claimed.has(asset.id) && !claimed.has(asset.src)
        && !extraPlaced.some((placed) => placed.item.sourceAssetId === asset.id || placed.item.src === asset.src))
      .map((asset) => ({ asset, name: asset.name }));
    const extras = [...extraPlaced, ...extraPool].sort((a, b) => natural(a.name, b.name) || a.name.localeCompare(b.name));
    ordered = [...resolved, ...extras];
  } else {
    const clips = visualClips(state);
    const claimed = new Set(clips.flatMap((item) => [item.sourceAssetId, item.src].filter((value): value is string => !!value)));
    const loose = [...poolVisuals(doc)]
      .filter((asset) => !claimed.has(asset.id) && !claimed.has(asset.src))
      .map((asset) => ({ asset, name: asset.name }));
    const placed = clips.map((item) => ({ item, name: item.name }));
    ordered = [...placed, ...loose].sort((a, b) => natural(a.name, b.name) || a.name.localeCompare(b.name));
    if (!ordered.length) {
      return { ok: false, outcome: fail('need-media', t('素材库和时间线上都还没有视频或图片。先导入多个片段，再排列。')) };
    }
  }
  if (!ordered.length) return { ok: false, outcome: fail('need-media', t('没有可排列的视频或图片。')) };
  const ids = placeResolved(project, ordered);
  const track = ensureTrack(project);
  const extras = names?.length && track
    ? visualClips(project.getState())
      .filter((item) => item.track === track && !ids.includes(item.id))
      .map((item) => item.id)
    : [];
  packIds(project, [...ids, ...extras]);
  return { ok: true, ids: [...ids, ...extras], ordered };
}

function liveItems(project: ShortProject, ids: readonly string[]): TimelineItem[] {
  const byId = new Map(project.getState().items.map((item) => [item.id, item]));
  return ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

function trimItems(project: ShortProject, items: readonly TimelineItem[], edge: 'intro' | 'outro', frames: number): { changed: number; skipped: number } {
  let changed = 0;
  let skipped = 0;
  const ordered = edge === 'intro' ? [...items].reverse() : items;
  for (const item of ordered) {
    const live = project.getState().items.find((candidate) => candidate.id === item.id);
    if (!live) continue;
    const keep = Math.max(1, live.durationInFrames - frames);
    if (keep >= live.durationInFrames) {
      skipped += 1;
      continue;
    }
    if (edge === 'intro' && (live.kind === 'video' || live.kind === 'gif' || live.kind === 'audio')) {
      const room = Math.max(0, sourceFrames(project.getDoc(), live) - (live.srcInFrame ?? 0) - 1);
      const applied = Math.min(frames, room, live.durationInFrames - 1);
      if (applied < 1) {
        skipped += 1;
        continue;
      }
      project.commands.setItemTiming(live.id, {
        srcInFrame: (live.srcInFrame ?? 0) + applied,
        durationInFrames: live.durationInFrames - applied,
        ripple: true,
      });
    } else {
      project.commands.setItemTiming(live.id, {
        durationInFrames: keep,
        ripple: true,
      });
    }
    changed += 1;
  }
  return { changed, skipped };
}

function capItems(project: ShortProject, items: readonly TimelineItem[], frames: number): number {
  let changed = 0;
  for (const item of [...items].reverse()) {
    const live = project.getState().items.find((candidate) => candidate.id === item.id);
    if (!live || live.durationInFrames <= frames) continue;
    project.commands.setItemTiming(live.id, { durationInFrames: frames, ripple: true });
    changed += 1;
  }
  return changed;
}

function fadeItems(project: ShortProject, items: readonly TimelineItem[], frames: number): number {
  let changed = 0;
  for (const item of items) {
    const live = project.getState().items.find((candidate) => candidate.id === item.id);
    if (!live) continue;
    const room = Math.max(0, Math.floor((live.durationInFrames - 1) / 2));
    const fade = Math.min(frames, room);
    if (fade < 1) continue;
    project.commands.setItemFade(live.id, { fadeInFrames: fade, fadeOutFrames: fade });
    changed += 1;
  }
  return changed;
}

function allocate(durations: readonly number[], target: number): number[] {
  const sum = durations.reduce((total, value) => total + value, 0);
  if (sum <= target) return [...durations];
  const raw = durations.map((duration) => duration * target / sum);
  const next = raw.map((value) => Math.max(1, Math.floor(value)));
  let used = next.reduce((total, value) => total + value, 0);
  if (used > target) {
    for (let index = next.length - 1; index >= 0 && used > target; index -= 1) {
      const reduced = Math.max(0, next[index]! - (used - target));
      used -= next[index]! - reduced;
      next[index] = reduced;
    }
    return next;
  }
  let remain = target - used;
  const order = raw.map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac);
  for (const entry of order) {
    if (remain <= 0) break;
    const room = durations[entry.index]! - next[entry.index]!;
    if (room <= 0) continue;
    const add = Math.min(room, remain);
    next[entry.index] = next[entry.index]! + add;
    remain -= add;
  }
  return next;
}

function execute(project: ShortProject, command: ShortCommand): ShortOutcome {
  switch (command.type) {
    case 'help':
      return ok('help', helpText());
    case 'export': {
      const clips = visualClips(project.getState());
      if (!clips.length) {
        return ok('export-empty', t('时间线上还没有画面，导出会是空白。先导入并排列片段。导出窗口已打开，有成片后选择 MP4。'), true);
      }
      const frames = clips.reduce((end, item) => Math.max(end, item.startFrame + item.durationInFrames), 0);
      return ok('export', t('导出窗口已打开。当前成片约 {seconds} 秒。选择 MP4 即可保存。', {
        seconds: secondsLabel(frames, project.getState().fps),
      }), true);
    }
    case 'order': {
      const ordered = orderEntries(project, command.names);
      if (!ordered.ok) return ordered.outcome;
      const items = liveItems(project, ordered.ids);
      const frames = items.reduce((total, item) => total + item.durationInFrames, 0);
      return ok('ordered', t('已按{how}排列 {count} 个片段（约 {seconds} 秒）：{names}。在右侧预览里播放。', {
        how: command.names?.length ? t('你给的顺序') : t('名称顺序'),
        count: items.length,
        seconds: secondsLabel(frames, project.getState().fps),
        names: namesOf(items),
      }));
    }
    case 'trim-intro':
    case 'trim-outro': {
      const targets = targetsFor(project.getState(), project.getDoc(), command.selector);
      if (!targets.ok) return targets.outcome;
      const edge = command.type === 'trim-intro' ? 'intro' : 'outro';
      const frames = framesOf(command.amount, project.getState().fps);
      const { changed, skipped } = trimItems(project, targets.clips.flatMap((clip) => clip.item ? [clip.item] : []), edge, frames);
      if (!changed) return fail('trim-too-short', t('这些片段太短，不能再剪掉 {amount}。', { amount: amountLabel(command.amount) }));
      const where = edge === 'intro' ? t('开头') : t('结尾');
      return ok('trimmed', skipped
        ? t('已从 {count} 个片段的{where}剪掉约 {seconds} 秒，{skipped} 个太短已跳过。', {
          count: changed, where, seconds: amountLabel(command.amount), skipped,
        })
        : t('已从 {count} 个片段的{where}剪掉约 {seconds} 秒。', {
          count: changed, where, seconds: amountLabel(command.amount),
        }));
    }
    case 'cap': {
      const targets = targetsFor(project.getState(), project.getDoc(), command.selector);
      if (!targets.ok) return targets.outcome;
      const frames = framesOf(command.amount, project.getState().fps);
      const changed = capItems(project, targets.clips.flatMap((clip) => clip.item ? [clip.item] : []), frames);
      if (!changed) return ok('cap-unchanged', t('这些片段已经不长于 {seconds} 秒。', { seconds: amountLabel(command.amount) }));
      return ok('capped', t('已把 {count} 个片段收到最多 {seconds} 秒。', { count: changed, seconds: amountLabel(command.amount) }));
    }
    case 'remove': {
      const one = resolveOne(project.getState(), project.getDoc(), command.selector);
      if (!one.ok) return one.outcome;
      if (!one.clip.item) return fail('not-on-timeline', t('“{name}”还在素材库里，时间线上没有可删的片段。', { name: one.clip.name }));
      project.commands.rippleDeleteItem(one.clip.item.id);
      return ok('removed', t('已去掉“{name}”，后面的片段已靠拢。', { name: one.clip.name }));
    }
    case 'fades': {
      const targets = targetsFor(project.getState(), project.getDoc(), command.selector);
      if (!targets.ok) return targets.outcome;
      const frames = framesOf(command.amount, project.getState().fps);
      const changed = fadeItems(project, targets.clips.flatMap((clip) => clip.item ? [clip.item] : []), frames);
      if (!changed) return fail('fade-too-short', t('片段太短，放不下淡入淡出。'));
      return ok('fades', t('已为 {count} 个片段加上约 {seconds} 秒淡入淡出。', {
        count: changed,
        seconds: amountLabel(command.amount),
      }));
    }
    case 'mute': {
      const targets = targetsFor(project.getState(), project.getDoc(), command.selector);
      if (!targets.ok) return targets.outcome;
      const audible = targets.clips.flatMap((clip) => clip.item && (clip.item.kind === 'video' || clip.item.kind === 'audio') ? [clip.item] : []);
      if (!audible.length) return fail('nothing-to-mute', t('这些画面片段没有可开关的原声。'));
      for (const item of audible) project.commands.setItemVolume(item.id, command.muted ? 0 : 1);
      return ok(command.muted ? 'muted' : 'unmuted', command.muted
        ? t('已静音 {count} 个片段。', { count: audible.length })
        : t('已恢复 {count} 个片段的声音。', { count: audible.length }));
    }
    case 'short': {
      const ordered = orderEntries(project, null);
      if (!ordered.ok) return ordered.outcome;
      const fps = project.getState().fps;
      const target = Math.max(1, Math.round(command.seconds * fps));
      const items = liveItems(project, ordered.ids);
      const allocation = allocate(items.map((item) => item.durationInFrames), target);
      const kept: string[] = [];
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index]!;
        const next = allocation[index] ?? 0;
        if (next < 1) {
          project.commands.rippleDeleteItem(item.id);
          continue;
        }
        if (next < item.durationInFrames) {
          project.commands.setItemTiming(item.id, { durationInFrames: next, ripple: true });
        }
        kept.unshift(item.id);
      }
      packIds(project, kept);
      const faded = liveItems(project, kept);
      fadeItems(project, faded, framesOf(DEFAULT_FADE, fps));
      const frames = faded.reduce((total, item) => total + item.durationInFrames, 0);
      return ok('short', t('已做成约 {seconds} 秒的短片，共 {count} 个片段：{names}。在预览里播放，再说「导出」。', {
        seconds: secondsLabel(frames, fps),
        count: faded.length,
        names: namesOf(faded),
      }));
    }
    default:
      return fail('unknown', t('这条指令还不能在本地执行。'));
  }
}

export function runShortCommand(project: ShortProject, command: ShortCommand): ShortOutcome {
  const mutating = command.type !== 'export' && command.type !== 'help';
  if (mutating) project.commands.beginHistoryGesture();
  try {
    return execute(project, command);
  } finally {
    if (mutating) project.commands.endHistoryGesture();
  }
}
