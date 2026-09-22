import type { IconName } from '../icons';

interface ProjectStarter {
  readonly label: string;
  readonly description: string;
  readonly prompt: string;
  readonly icon: IconName;
}

interface QuickAction {
  readonly label: string;
  readonly prompt: string;
}

export const EMPTY_PROJECT_STARTERS: readonly ProjectStarter[] = [
  { label: '排列片段', description: '按名称接到时间线', prompt: '排列这些片段', icon: 'film' },
  { label: '剪掉片头', description: '每段去掉开头 1 秒', prompt: '剪掉片头', icon: 'scissors' },
  { label: '加上淡化', description: '每段淡入淡出', prompt: '加上淡入淡出', icon: 'sparkles' },
  { label: '做成 30 秒', description: '收成一条短片', prompt: '做成 30 秒短片', icon: 'video' },
  { label: '导出', description: '保存 MP4', prompt: '导出成片', icon: 'download' },
];

export const QUICK_ACTIONS: readonly QuickAction[] = [
  { label: '排列片段', prompt: '排列这些片段' },
  { label: '剪掉片头', prompt: '剪掉片头' },
  { label: '剪掉片尾', prompt: '剪掉片尾' },
  { label: '加上淡化', prompt: '加上淡入淡出' },
  { label: '静音', prompt: '静音' },
  { label: '每段最多 3 秒', prompt: '每段最多 3 秒' },
  { label: '做成 30 秒短片', prompt: '做成 30 秒短片' },
  { label: '导出 MP4', prompt: '导出成片' },
];

