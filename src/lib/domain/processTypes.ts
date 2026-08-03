import { ProcessTypeDef } from './types';

export const PROCESS_TYPES: ProcessTypeDef[] = [
  { code: 'GANGFORM', name: '갱폼', category: 'main', mainSequence: 1, showFloorLabel: true },
  { code: 'W_REBAR', name: 'W_철근', category: 'main', mainSequence: 2 },
  { code: 'AL', name: 'AL', category: 'main', mainSequence: 3 },
  { code: 'S_REBAR', name: 'S_철근', category: 'main', mainSequence: 4 },
  { code: 'POUR', name: '타설', category: 'main', mainSequence: 5 },
  { code: 'RELEASE_AGENT', name: '박리제', category: 'sub' },
  { code: 'ELECTRIC_FACILITY', name: '전기·설비', category: 'sub' },
  { code: 'TROWEL', name: '먹메김', category: 'sub' },
  { code: 'REBAR_INSPECTION', name: '철근검측', category: 'sub' },
];

export const PROCESS_TYPE_MAP: Record<string, ProcessTypeDef> = Object.fromEntries(
  PROCESS_TYPES.map((t) => [t.code, t]),
);

export const MAIN_SEQUENCE_CODES = PROCESS_TYPES.filter((t) => t.category === 'main')
  .sort((a, b) => (a.mainSequence ?? 0) - (b.mainSequence ?? 0))
  .map((t) => t.code);

// 같은 날짜·같은 공종 그룹 충돌 순번을 매길 때 묶는 그룹 키
export const CONFLICT_GROUP: Record<string, string> = {
  GANGFORM: '갱',
  W_REBAR: '철',
  S_REBAR: '철',
  AL: 'AL',
};

// 주요공정 배경색: 갱폼 주황 / 철근 파랑 / AL 진노랑 / 타설 빨강. 보조공정·특이사항은 흰 바탕 유지.
export const PROCESS_COLOR: Record<string, { bg: string; text: string }> = {
  GANGFORM: { bg: 'bg-orange-300', text: 'text-orange-950' },
  W_REBAR: { bg: 'bg-blue-300', text: 'text-blue-950' },
  S_REBAR: { bg: 'bg-blue-300', text: 'text-blue-950' },
  AL: { bg: 'bg-amber-500', text: 'text-white' },
  POUR: { bg: 'bg-red-400', text: 'text-white' },
};

// 구간공정(기초·지하층 등 커스텀 단계)은 단계 종류가 많은데 다 같은 회색이면 서로
// 구분이 안 된다. 단계 이름별로 아래 파스텔 팔레트에서 색을 배정해 이웃한 단계가
// 다른 색으로 보이게 한다. 주요공정 색(주황/파랑/호박/빨강)과 안 겹치게 초록/보라/
// 청록 계열로 구성했다. bg는 화면(Tailwind), argb는 엑셀 내보내기에서 같은 톤으로 쓴다.
export const CUSTOM_PALETTE: { bg: string; text: string; argb: string }[] = [
  { bg: 'bg-emerald-200', text: 'text-emerald-950', argb: 'FFA7F3D0' },
  { bg: 'bg-violet-200', text: 'text-violet-950', argb: 'FFDDD6FE' },
  { bg: 'bg-teal-200', text: 'text-teal-950', argb: 'FF99F6E4' },
  { bg: 'bg-pink-200', text: 'text-pink-950', argb: 'FFFBCFE8' },
  { bg: 'bg-lime-200', text: 'text-lime-950', argb: 'FFD9F99D' },
  { bg: 'bg-cyan-200', text: 'text-cyan-950', argb: 'FFA5F3FC' },
  { bg: 'bg-fuchsia-200', text: 'text-fuchsia-950', argb: 'FFF5D0FE' },
  { bg: 'bg-indigo-200', text: 'text-indigo-950', argb: 'FFC7D2FE' },
  { bg: 'bg-rose-200', text: 'text-rose-950', argb: 'FFFECDD3' },
  { bg: 'bg-sky-200', text: 'text-sky-950', argb: 'FFBAE6FD' },
];

function paletteIndex(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % CUSTOM_PALETTE.length;
}

// 커스텀 공정(구간공정) 하나의 색을 그 단계 이름 기준으로 정한다 — 같은 이름이면 항상 같은 색.
export function customProcessColor(key: string): { bg: string; text: string } {
  const c = CUSTOM_PALETTE[paletteIndex(key)];
  return { bg: c.bg, text: c.text };
}
export function customProcessArgb(key: string): string {
  return CUSTOM_PALETTE[paletteIndex(key)].argb;
}
