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
