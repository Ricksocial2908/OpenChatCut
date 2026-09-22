// Runnable check: `npx tsx src/shorts/shortCommands.verify.ts`
import assert from 'node:assert/strict';
import { docFromTimeline } from '../persist/projectStore';
import { makeDraft } from '../editor/store';
import type { MediaAsset, TimelineItem, TimelineState } from '../editor/types';
import { composerCanSendLocal } from '../components/chat/composerSubmitGate';
import {
  matchShortSlash,
  parseShortCommand,
  runShortCommand,
  type ShortProject,
} from './shortCommands';

function asset(name: string, frames: number, kind: MediaAsset['kind'] = 'video'): MediaAsset {
  return { id: `asset_${name}`, name, kind, src: `/media/${encodeURIComponent(name)}`, durationInFrames: frames };
}

function clip(name: string, start: number, frames: number, srcIn = 0): TimelineItem {
  return {
    id: `item_${name}`,
    track: 'track_v1',
    startFrame: start,
    durationInFrames: frames,
    kind: 'video',
    name,
    src: `/media/${encodeURIComponent(name)}`,
    sourceAssetId: `asset_${name}`,
    srcInFrame: srcIn,
    volume: 1,
  };
}

function project(options: { assets?: MediaAsset[]; items?: TimelineItem[] } = {}): ShortProject & { draft: ReturnType<typeof makeDraft> } {
  const state: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    items: options.items ?? [],
    selectedId: null,
    trackOrder: ['track_v1'],
    tracks: { track_v1: { kind: 'video' } },
    assets: options.assets ?? [],
  };
  const draft = makeDraft(docFromTimeline(state));
  return { draft, commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc };
}

function visuals(target: ShortProject): TimelineItem[] {
  return target.getState().items
    .filter((item) => item.kind === 'video' || item.kind === 'image' || item.kind === 'gif')
    .sort((a, b) => a.startFrame - b.startFrame);
}

const phrases = [
  ['Order these clips', 'order'],
  ['排列这些片段', 'order'],
  ['Trim intros', 'trim-intro'],
  ['剪掉片头', 'trim-intro'],
  ['Trim outros', 'trim-outro'],
  ['Add fades', 'fades'],
  ['加上淡入淡出', 'fades'],
  ['Make a 30s short', 'short'],
  ['做成 30 秒短片', 'short'],
  ['Export', 'export'],
  ['导出成片', 'export'],
  ['Mute clips', 'mute'],
  ['Cut each clip to 3s', 'cap'],
  ['/order', 'order'],
  ['/order b.mp4, a.mp4', 'order'],
  ['/trim 0.5s', 'trim-intro'],
  ['/trim outro', 'trim-outro'],
  ['/trim clip 2', 'trim-intro'],
  ['/fades', 'fades'],
  ['/mute', 'mute'],
  ['/unmute', 'mute'],
  ['/cut 3s', 'cap'],
  ['/cut clip 2', 'remove'],
  ['/short 45s', 'short'],
  ['/export', 'export'],
  ['/help', 'help'],
] as const;

for (const [text, type] of phrases) {
  const parsed = parseShortCommand(text);
  assert.ok(parsed, `expected a local command: ${text}`);
  assert.equal(parsed.type, type, text);
}

assert.equal(parseShortCommand('please trim the boring interview'), null);
assert.equal(parseShortCommand('/skill:export'), null);
assert.equal(parseShortCommand('Make a 20s short')?.type === 'short' && parseShortCommand('Make a 20s short') && 'seconds' in parseShortCommand('Make a 20s short')!
  ? (parseShortCommand('Make a 20s short') as { seconds: number }).seconds
  : null, 20);
assert.equal(parseShortCommand('/unmute') && parseShortCommand('/unmute')!.type === 'mute'
  ? (parseShortCommand('/unmute') as { muted: boolean }).muted
  : null, false);

const slash = matchShortSlash('exp');
assert.deepEqual(slash.map((entry) => entry.verb), ['export']);
assert.ok(matchShortSlash('').length >= 7);
assert.deepEqual(matchShortSlash(null), []);

const empty = project();
const missing = runShortCommand(empty, parseShortCommand('/order')!);
assert.equal(missing.ok, false);
assert.equal(missing.code, 'need-media');
assert.equal(empty.getState().items.length, 0);

const pool = project({
  assets: [asset('b.mp4', 90), asset('a.mp4', 60), asset('note.txt', 30, 'document'), asset('song.wav', 120, 'audio')],
});
const ordered = runShortCommand(pool, parseShortCommand('Order these clips')!);
assert.equal(ordered.ok, true, ordered.message);
const orderedClips = visuals(pool);
assert.deepEqual(orderedClips.map((item) => item.name), ['a.mp4', 'b.mp4']);
assert.deepEqual(orderedClips.map((item) => item.startFrame), [0, 60]);
assert.equal(pool.getDoc().assets.some((item) => item.kind === 'audio'), true, 'audio stays in the pool');

const named = project({
  assets: [asset('beach.mp4', 90), asset('sunset.mp4', 60), asset('credits.mp4', 45)],
});
runShortCommand(named, parseShortCommand('/order sunset.mp4, beach.mp4')!);
assert.deepEqual(visuals(named).map((item) => [item.name, item.startFrame]), [
  ['sunset.mp4', 0],
  ['beach.mp4', 60],
  ['credits.mp4', 150],
]);

const trimmed = project({
  assets: [asset('a.mp4', 90), asset('b.mp4', 90)],
  items: [clip('a.mp4', 0, 90), clip('b.mp4', 90, 90)],
});
const trim = runShortCommand(trimmed, parseShortCommand('Trim intros')!);
assert.equal(trim.ok, true, trim.message);
const trimmedClips = visuals(trimmed);
assert.equal(trimmedClips[0]!.srcInFrame, 30);
assert.equal(trimmedClips[0]!.durationInFrames, 60);
assert.equal(trimmedClips[1]!.startFrame, 60, 'ripple closes the gap');
assert.equal(trimmedClips[1]!.durationInFrames, 60);

const one = project({
  assets: [asset('a.mp4', 120), asset('b.mp4', 120)],
  items: [clip('a.mp4', 0, 120), clip('b.mp4', 120, 120)],
});
runShortCommand(one, parseShortCommand('/trim clip 2 0.5s')!);
assert.equal(visuals(one)[0]!.durationInFrames, 120);
assert.equal(visuals(one)[1]!.srcInFrame, 15);
assert.equal(visuals(one)[1]!.durationInFrames, 105);

const capped = project({
  assets: [asset('a.mp4', 300)],
  items: [clip('a.mp4', 0, 300)],
});
runShortCommand(capped, parseShortCommand('/cut 3s')!);
assert.equal(visuals(capped)[0]!.durationInFrames, 90);
assert.equal(visuals(capped)[0]!.srcInFrame, 0, 'a cap keeps the current in-point');

const removed = project({
  assets: [asset('a.mp4', 60), asset('b.mp4', 60)],
  items: [clip('a.mp4', 0, 60), clip('b.mp4', 60, 60)],
});
runShortCommand(removed, parseShortCommand('/cut clip 1')!);
assert.deepEqual(visuals(removed).map((item) => [item.name, item.startFrame]), [['b.mp4', 0]]);

const faded = project({
  assets: [asset('a.mp4', 90)],
  items: [clip('a.mp4', 0, 90)],
});
runShortCommand(faded, parseShortCommand('Add fades')!);
assert.equal(visuals(faded)[0]!.fadeInFrames, 15);
assert.equal(visuals(faded)[0]!.fadeOutFrames, 15);

const muted = project({
  assets: [asset('a.mp4', 60), asset('still.png', 150, 'image')],
  items: [
    clip('a.mp4', 0, 60),
    { ...clip('still.png', 60, 150), kind: 'image', sourceAssetId: 'asset_still.png' },
  ],
});
runShortCommand(muted, parseShortCommand('/mute')!);
assert.equal(visuals(muted).find((item) => item.name === 'a.mp4')!.volume, 0);
runShortCommand(muted, parseShortCommand('/unmute beach-missing')!);
assert.equal(parseShortCommand('/unmute') && runShortCommand(muted, parseShortCommand('/unmute')!).ok, true);
assert.equal(visuals(muted).find((item) => item.name === 'a.mp4')!.volume, 1);

const fitted = project({
  assets: [asset('b.mp4', 900), asset('a.mp4', 900)],
});
const made = runShortCommand(fitted, parseShortCommand('Make a 30s short')!);
assert.equal(made.ok, true, made.message);
const fittedClips = visuals(fitted);
assert.deepEqual(fittedClips.map((item) => item.name), ['a.mp4', 'b.mp4']);
const total = fittedClips.reduce((sum, item) => sum + item.durationInFrames, 0);
assert.equal(total, 900);
assert.ok((fittedClips[0]!.fadeInFrames ?? 0) > 0);

const byName = project({
  assets: [asset('clip10.mp4', 30), asset('clip2.mp4', 30)],
});
runShortCommand(byName, parseShortCommand('/order')!);
assert.deepEqual(visuals(byName).map((item) => item.name), ['clip2.mp4', 'clip10.mp4']);

const exported = runShortCommand(byName, parseShortCommand('Export')!);
assert.equal(exported.openExport, true);
assert.equal(byName.getState().items.length, visuals(byName).length);

assert.equal(composerCanSendLocal({ value: '/order', running: false, attachmentsPending: false, modelReady: false }), true);
assert.equal(composerCanSendLocal({ value: 'Order these clips', running: false, attachmentsPending: false, modelReady: false }), true);
assert.equal(composerCanSendLocal({ value: 'make it cinematic', running: false, attachmentsPending: false, modelReady: false }), false);
assert.equal(composerCanSendLocal({ value: '/order', running: false, attachmentsPending: true, modelReady: true }), false);
assert.equal(composerCanSendLocal({ value: 'make it cinematic', running: false, attachmentsPending: false, modelReady: true }), true);

console.log('shortCommands.verify: local short-movie commands passed');
