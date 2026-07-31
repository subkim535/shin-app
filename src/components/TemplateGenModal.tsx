'use client';

import { useMemo, useState } from 'react';
import { ISODate, todayISO } from '@/lib/domain/dateUtils';
import { generateFromTemplate } from '@/lib/domain/schedule';
import { Block, Holiday, ProcessTemplate, TemplateStepDef } from '@/lib/domain/types';

const TEMPLATE_CATEGORIES = ['기초공사', '지하층공사', '지상 PIT층', '주차장', '부속건물', '옥탑'];

// 지하층공사/지상 PIT층/부속건물은 같은 구성이라 공유한다.
const BASEMENT_STYLE_STEPS = [
  { name: '먹매김', durationDays: 1 },
  { name: '시스템비계', durationDays: 2 },
  { name: '옹벽철근', durationDays: 5 },
  { name: '철근검측', durationDays: 1 },
  { name: '거푸집(내/외부)', durationDays: 15 },
  { name: '시스템동바리 설치', durationDays: 3, optional: true },
  { name: '슬라브 설치', durationDays: 3 },
  { name: '단열재', durationDays: 1 },
  { name: '먹매김', durationDays: 1 },
  { name: 'S_철근', durationDays: 2 },
  { name: '철근검측', durationDays: 1 },
  { name: '전기설비', durationDays: 1 },
  { name: '바닥타설', durationDays: 1 },
  { name: '해체정리', durationDays: 1 },
  { name: '시스템비계설치', durationDays: 2 },
];

// 사용자가 공유한 공정표 스펙 사진을 옮겨 적은 기본값 — 이 카테고리에 저장된 단계가
// 아직 없을 때만 "기본 목록"으로 보여준다. 정확한 일수·순서는 실제 현장 기준으로
// 다시 한번 확인이 필요할 수 있다.
const DEFAULT_STEPS: Record<string, { name: string; durationDays: number; optional?: boolean }[]> = {
  기초공사: [
    { name: '기접받기', durationDays: 1 },
    { name: '레벨확인', durationDays: 1 },
    { name: '바닥비닐깔기', durationDays: 1 },
    { name: '버림타설', durationDays: 1 },
    { name: '바닥먹매김', durationDays: 1 },
    { name: '기초철근배근', durationDays: 7 },
    { name: '철근검측', durationDays: 1 },
    { name: 'EV실 1차 타설', durationDays: 1 },
    { name: '기초외부거푸집', durationDays: 2 },
    { name: 'EV실 안쪽 폼 설치', durationDays: 2, optional: true },
    { name: '전기설비', durationDays: 1 },
    { name: '기초타설', durationDays: 1 },
    { name: '거푸집해체', durationDays: 1 },
  ],
  지하층공사: BASEMENT_STYLE_STEPS,
  '지상 PIT층': BASEMENT_STYLE_STEPS,
  주차장: [
    { name: '먹매김', durationDays: 1 },
    { name: '기둥철근', durationDays: 3 },
    { name: '철근검측', durationDays: 1 },
    { name: '기둥폼 설치', durationDays: 1 },
    { name: '시스템동바리', durationDays: 1, optional: true },
    { name: '보 제작설치', durationDays: 3 },
    { name: '슬라브 설치', durationDays: 3 },
    { name: '보바닥철근', durationDays: 3 },
    { name: '철근검측', durationDays: 1 },
    { name: '전기설비', durationDays: 1 },
    { name: '타설', durationDays: 1 },
  ],
  부속건물: BASEMENT_STYLE_STEPS,
  옥탑: [],
};

function makeStepCode(category: string, index: number, name: string): string {
  return `CUSTOM_${category}_${index}_${name}`.replace(/\s+/g, '_');
}

interface TemplateGenModalProps {
  blocks: Block[];
  templates: ProcessTemplate[];
  holidays: Holiday[];
  onSubmit: (blockId: string, categoryName: string, steps: TemplateStepDef[], startDate: ISODate) => string | null;
  onClose: () => void;
}

export default function TemplateGenModal({ blocks, templates, holidays, onSubmit, onClose }: TemplateGenModalProps) {
  const [category, setCategory] = useState(TEMPLATE_CATEGORIES[0]);
  const [blockId, setBlockId] = useState(blocks[0]?.id ?? '');
  const [startDate, setStartDate] = useState<ISODate>(todayISO());
  const [orderedIndices, setOrderedIndices] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  const savedTemplate = templates.find((t) => t.name === category);
  // 이 카테고리에 저장해둔 단계가 있으면 그걸, 없으면 기본값을 후보 목록으로 보여준다.
  const baseSteps = useMemo(() => {
    if (savedTemplate && savedTemplate.steps.length > 0) {
      return savedTemplate.steps.map((s) => ({ name: s.name, durationDays: s.durationDays, optional: s.optional }));
    }
    return DEFAULT_STEPS[category] ?? [];
  }, [savedTemplate, category]);

  // 카테고리를 바꾸면(처음 마운트될 때도 포함) 순서를 그 카테고리의 기본 순서로 다시
  // 채운다 — 렌더 중에 바로 반영해서(useEffect 없이) 빈 목록이나 예전 카테고리의
  // 순서가 한 프레임이라도 잘못 보이지 않게 한다. 초기값을 실제 카테고리 이름과 절대
  // 겹치지 않는 값으로 둬서 첫 렌더에도 이 분기를 반드시 한 번 타게 한다.
  const [orderedForCategory, setOrderedForCategory] = useState<string | null>(null);
  if (orderedForCategory !== category) {
    setOrderedForCategory(category);
    setOrderedIndices(baseSteps.map((_, i) => i));
    setError(null);
  }

  function toggleStep(i: number) {
    setOrderedIndices((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]));
  }

  function moveSlot(pos: number, dir: 'up' | 'down') {
    const target = dir === 'up' ? pos - 1 : pos + 1;
    if (target < 0 || target >= orderedIndices.length) return;
    setOrderedIndices((cur) => {
      const next = [...cur];
      [next[pos], next[target]] = [next[target], next[pos]];
      return next;
    });
  }

  function resetOrder() {
    setOrderedIndices(baseSteps.map((_, i) => i));
  }

  const previewSteps: TemplateStepDef[] = useMemo(
    () =>
      orderedIndices.map((idx, i) => {
        const s = baseSteps[idx];
        return { code: makeStepCode(category, i, s.name), name: s.name, durationDays: s.durationDays, optional: s.optional };
      }),
    [orderedIndices, baseSteps, category],
  );

  const previewDates = useMemo(() => {
    if (previewSteps.length === 0 || !startDate) return [];
    const generated = generateFromTemplate({ id: 'preview', name: category, steps: previewSteps }, 'preview-block', startDate, holidays);
    return generated.map((p) => p.date);
  }, [previewSteps, startDate, holidays, category]);

  function handleSubmit() {
    if (!blockId) {
      setError('동을 선택해주세요.');
      return;
    }
    if (orderedIndices.length === 0) {
      setError('순서를 1개 이상 선택해주세요.');
      return;
    }
    const result = onSubmit(blockId, category, previewSteps, startDate);
    if (result) {
      setError(result);
      return;
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-4xl max-h-[85vh] overflow-y-auto p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">구간 공정 생성</h2>
          <button className="text-sm px-2 py-1 rounded border border-zinc-300" onClick={onClose}>
            닫기
          </button>
        </div>
        <p className="text-xs text-zinc-500">
          왼쪽에서 공사 종류를 고르고, 동·시작일을 정한 뒤 오른쪽 목록에서 순서대로 공정을 눌러 순서를 만드세요. 이미
          순서에 들어간 공정을 다시 누르면 빠집니다.
        </p>

        <div className="flex gap-3">
          {/* 공사 종류 (세로 목록) */}
          <div className="flex flex-col gap-1 w-28 shrink-0 border-r border-zinc-200 pr-2">
            {TEMPLATE_CATEGORIES.map((c) => (
              <button
                key={c}
                className={`text-left text-sm px-2 py-1.5 rounded ${c === category ? 'bg-indigo-600 text-white' : 'hover:bg-zinc-100'}`}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="flex-1 flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-zinc-500">동</span>
              <select className="border border-zinc-300 rounded px-2 py-1" value={blockId} onChange={(e) => setBlockId(e.target.value)}>
                {blocks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <span className="text-zinc-500 ml-2">시작일</span>
              <input
                type="date"
                className="border border-zinc-300 rounded px-2 py-1"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
              <button className="text-xs px-2 py-1 rounded border border-zinc-300 ml-auto" onClick={resetOrder}>
                기본 순서로 초기화
              </button>
            </div>

            {baseSteps.length === 0 ? (
              <p className="text-xs text-zinc-400">
                이 공사 종류는 아직 기본 단계가 없습니다. 설정 → 공정 템플릿에서 먼저 단계를 등록해주세요.
              </p>
            ) : (
              <div className="flex gap-3">
                {/* 선택된 순서 */}
                <div className="flex-1 flex flex-col gap-1">
                  <h3 className="text-xs font-semibold text-zinc-500">선택한 순서</h3>
                  {orderedIndices.length === 0 && <p className="text-xs text-zinc-400">오른쪽 목록에서 공정을 눌러 순서를 만드세요.</p>}
                  {orderedIndices.map((idx, pos) => (
                    <div key={`${idx}-${pos}`} className="flex items-center gap-2 text-sm border border-zinc-200 rounded px-2 py-1">
                      <span className="w-5 shrink-0 text-center text-xs font-semibold text-indigo-600">{pos + 1}</span>
                      <span className="flex-1">{baseSteps[idx].name}</span>
                      <span className="text-xs text-zinc-400 shrink-0">{previewDates[pos] ?? ''}</span>
                      <span className="flex flex-col shrink-0 -my-1">
                        <button className="text-[9px] leading-none px-0.5 disabled:opacity-30" disabled={pos === 0} onClick={() => moveSlot(pos, 'up')}>
                          ▲
                        </button>
                        <button
                          className="text-[9px] leading-none px-0.5 disabled:opacity-30"
                          disabled={pos === orderedIndices.length - 1}
                          onClick={() => moveSlot(pos, 'down')}
                        >
                          ▼
                        </button>
                      </span>
                      <button className="text-xs text-red-600 shrink-0" onClick={() => toggleStep(idx)}>
                        빼기
                      </button>
                    </div>
                  ))}
                </div>

                {/* 전체 공정 목록 */}
                <div className="flex-1 flex flex-col gap-1">
                  <h3 className="text-xs font-semibold text-zinc-500">공정 목록 (눌러서 순서에 추가)</h3>
                  {baseSteps.map((s, i) => {
                    const picked = orderedIndices.includes(i);
                    return (
                      <button
                        key={i}
                        onClick={() => toggleStep(i)}
                        className={`text-left text-sm border rounded px-2 py-1 flex items-center justify-between ${
                          picked ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-zinc-200 hover:bg-zinc-50'
                        }`}
                      >
                        <span>
                          {s.name} {s.optional && <span className="text-[10px] text-zinc-400">(필요시)</span>}
                        </span>
                        {picked && <span className="text-xs">{orderedIndices.indexOf(i) + 1}번</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex justify-end gap-2">
          <button className="px-3 py-1 rounded border border-zinc-300 text-sm" onClick={onClose}>
            취소
          </button>
          <button className="px-3 py-1 rounded bg-indigo-600 text-white text-sm" onClick={handleSubmit}>
            복사(이 순서로 저장하고 생성)
          </button>
        </div>
      </div>
    </div>
  );
}
