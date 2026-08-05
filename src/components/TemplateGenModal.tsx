'use client';

import { useMemo, useState } from 'react';
import { dayOfWeek, ISODate, todayISO } from '@/lib/domain/dateUtils';
import { generateFromTemplate } from '@/lib/domain/schedule';
import { Block, Holiday, ProcessTemplate, TemplateStepDef } from '@/lib/domain/types';

// 지상층(PIT 없음)도 기초/지하/주차장 등과 똑같이 순서를 자유롭게 편집하는 커스텀
// 공정이다(단계 추가·삭제·순서변경·일수편집 가능). 예전엔 기준층 엔진(도미노 밀림 등)을
// 그대로 쓰는 특수 화면이었지만, 실제 현장 지상층 공정 목록이 더 세분화되어(먹매김·철근
// 검측·전기설비 등이 별도 단계) 사용자가 직접 짜는 편집형으로 전환했다.
export const GROUND_FLOOR_CATEGORY = '지상층(PIT 없음)';

const TEMPLATE_CATEGORIES = ['기초공사', '지하층공사', '지상 PIT층', GROUND_FLOOR_CATEGORY, '주차장', '부속건물', '옥탑'];

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
  // 지상층(PIT 없음) — 사용자가 준 실제 지상층공사 공정표(사진) 기준.
  // S_철근·타설 일수는 사진에서 비어 있어 임시로 2/1일을 넣었으니 현장 기준으로 조정 필요.
  [GROUND_FLOOR_CATEGORY]: [
    { name: '먹매김', durationDays: 1 },
    { name: '갱폼 설치(인상)', durationDays: 3 },
    { name: 'W_철근', durationDays: 2 },
    { name: '철근검측', durationDays: 1 },
    { name: 'AL폼', durationDays: 3 },
    { name: 'S_철근', durationDays: 2 },
    { name: '철근검측', durationDays: 1 },
    { name: '전기설비', durationDays: 1 },
    { name: '타설', durationDays: 1 },
  ],
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

// 모달 안에서 직접 편집(일수·필요시·추가·삭제)할 수 있는 단계 한 줄.
type EditStep = { name: string; durationDays: number; optional?: boolean };

interface TemplateGenModalProps {
  blocks: Block[];
  templates: ProcessTemplate[];
  holidays: Holiday[];
  onSubmit: (
    blockId: string,
    categoryName: string,
    steps: TemplateStepDef[],
    startDate: ISODate,
    repeatCount: number,
    floorLabel: string,
    allowStartHoliday: boolean,
  ) => string | null;
  onSaveNewTemplate: (title: string, steps: TemplateStepDef[]) => void;
  onRemoveTemplate: (id: string) => void;
  onClose: () => void;
  initialCategory?: string;
  initialBlockId?: string;
  initialStartDate?: ISODate;
}

export default function TemplateGenModal({
  blocks,
  templates,
  holidays,
  onSubmit,
  onSaveNewTemplate,
  onRemoveTemplate,
  onClose,
  initialCategory,
  initialBlockId,
  initialStartDate,
}: TemplateGenModalProps) {
  const [category, setCategory] = useState(initialCategory ?? TEMPLATE_CATEGORIES[0]);
  const [blockId, setBlockId] = useState(initialBlockId ?? blocks[0]?.id ?? '');
  const [startDate, setStartDate] = useState<ISODate>(initialStartDate ?? todayISO());
  const [orderedIndices, setOrderedIndices] = useState<number[]>([]);
  const [repeatCount, setRepeatCount] = useState('1');
  const [floor, setFloor] = useState('');
  const [saveTitle, setSaveTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [holidayConfirm, setHolidayConfirm] = useState(false);
  const customTemplateNames = templates.map((t) => t.name).filter((n) => !TEMPLATE_CATEGORIES.includes(n));

  const savedTemplate = templates.find((t) => t.name === category);
  // 이 카테고리의 "기본" 단계 목록 — 저장된 게 있으면 그것, 없으면 DEFAULT_STEPS.
  function baseStepsFor(): EditStep[] {
    const src = savedTemplate && savedTemplate.steps.length > 0 ? savedTemplate.steps : DEFAULT_STEPS[category] ?? [];
    return src.map((s) => ({ name: s.name, durationDays: s.durationDays, optional: s.optional }));
  }

  // editSteps: 모달 안에서 직접 편집 가능한 단계 목록(이름·일수·필요시·추가·삭제).
  const [editSteps, setEditSteps] = useState<EditStep[]>([]);
  const [newStepName, setNewStepName] = useState('');
  const [newStepDays, setNewStepDays] = useState('1');

  // 카테고리를 바꾸면(처음 마운트될 때도 포함) 그 카테고리의 기본 단계·순서로 다시 채운다.
  // 렌더 중에 바로 반영해서(useEffect 없이) 예전 카테고리의 값이 한 프레임이라도 잘못
  // 보이지 않게 한다. 초기값을 실제 카테고리 이름과 절대 겹치지 않는 값으로 둔다.
  const [orderedForCategory, setOrderedForCategory] = useState<string | null>(null);
  if (orderedForCategory !== category) {
    setOrderedForCategory(category);
    const init = baseStepsFor();
    setEditSteps(init);
    setOrderedIndices(init.map((_, i) => i));
    setNewStepName('');
    setNewStepDays('1');
    setError(null);
    // 이미 저장된 프리셋을 불러왔으면 저장칸에 원래 이름을 미리 채워서, 수정 후 "저장"이
    // 곧 덮어쓰기가 되게 한다. 기본 카테고리(기초공사 등)는 새 이름으로 저장하므로 비운다.
    setSaveTitle(TEMPLATE_CATEGORIES.includes(category) ? '' : category);
  }

  function toggleStep(i: number) {
    setOrderedIndices((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]));
  }

  // ── 단계 직접 편집 (설정 화면 편집기를 모달 안으로 가져온 것) ──
  function setStepDays(i: number, val: string) {
    const days = Math.max(1, Math.floor(Number(val) || 1));
    setEditSteps((cur) => cur.map((s, idx) => (idx === i ? { ...s, durationDays: days } : s)));
  }
  function deleteStep(i: number) {
    setEditSteps((cur) => cur.filter((_, idx) => idx !== i));
    // 삭제된 인덱스를 순서에서 빼고, 그보다 뒤 인덱스는 한 칸씩 당긴다.
    setOrderedIndices((cur) => cur.filter((x) => x !== i).map((x) => (x > i ? x - 1 : x)));
  }
  function addStep() {
    const name = newStepName.trim();
    if (!name) return;
    const days = Math.max(1, Math.floor(Number(newStepDays) || 1));
    const newIdx = editSteps.length;
    setEditSteps((cur) => [...cur, { name, durationDays: days }]);
    setOrderedIndices((cur) => [...cur, newIdx]); // 새 단계는 순서 맨 뒤에 자동 추가
    setNewStepName('');
    setNewStepDays('1');
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
    const init = baseStepsFor();
    setEditSteps(init);
    setOrderedIndices(init.map((_, i) => i));
  }

  // 카테고리를 바꾼 직후 한 프레임 동안은(위 render-time reset이 반영되기 전) orderedIndices가
  // 이전 카테고리의(더 많을 수 있는) 길이를 그대로 들고 있을 수 있다 — baseSteps[idx]가
  // undefined가 되는 범위를 걸러내지 않으면 그 프레임에서 바로 예외가 나서 화면 전체가
  // 죽는다(더 적은 단계 수의 카테고리로 바꿀 때 재현됨). 유효한 idx만 남긴다.
  const previewSteps: TemplateStepDef[] = useMemo(
    () =>
      orderedIndices
        .filter((idx) => idx < editSteps.length)
        .map((idx, i) => {
          const s = editSteps[idx];
          return { code: makeStepCode(category, i, s.name), name: s.name, durationDays: s.durationDays, optional: s.optional };
        }),
    [orderedIndices, editSteps, category],
  );

  const previewDates = useMemo(() => {
    if (previewSteps.length === 0 || !startDate) return [];
    const generated = generateFromTemplate({ id: 'preview', name: category, steps: previewSteps }, 'preview-block', startDate, holidays);
    return generated.map((p) => p.date);
  }, [previewSteps, startDate, holidays, category]);

  const parsedRepeatCount = Math.min(60, Math.max(1, Number(repeatCount) || 1));
  // 숫자만 입력하면 뒤에 F를 붙인다("3" → "3F"). 이미 F 등 글자가 있으면 그대로 둔다.
  const normalizedFloor = /^\d+$/.test(floor.trim()) ? `${floor.trim()}F` : floor.trim();

  // 시작일이 휴일(일요일 또는 등록된 공휴일)인지 — 그러면 생성 전에 경고 후 확인받는다.
  const startIsHoliday = !!startDate && (dayOfWeek(startDate) === 0 || holidays.some((h) => h.date === startDate));
  const startHolidayLabel =
    holidays.find((h) => h.date === startDate)?.label || (startDate && dayOfWeek(startDate) === 0 ? '일요일' : '공휴일');

  function doSubmit(allowStartHoliday: boolean) {
    const result = onSubmit(blockId, category, previewSteps, startDate, parsedRepeatCount, normalizedFloor, allowStartHoliday);
    setHolidayConfirm(false);
    if (result) {
      setError(result);
      return;
    }
    onClose();
  }

  function handleSubmit() {
    if (!blockId) {
      setError('동을 선택해주세요.');
      return;
    }
    if (orderedIndices.length === 0) {
      setError('순서를 1개 이상 선택해주세요.');
      return;
    }
    setError(null);
    // 시작일이 휴일이면 바로 만들지 않고 경고 → "예" 눌러야 휴일에도 생성.
    if (startIsHoliday) {
      setHolidayConfirm(true);
      return;
    }
    doSubmit(false);
  }

  function handleSaveAsNew() {
    const title = saveTitle.trim();
    if (!title) {
      setError('저장할 이름을 입력해주세요.');
      return;
    }
    if (orderedIndices.length === 0) {
      setError('순서를 1개 이상 선택해주세요.');
      return;
    }
    // 같은 이름의 프리셋이 이미 있으면 덮어쓰기(같은 이름으로 저장하면 데이터 계층에서
    // 기존 것을 갱신함) — 실수 방지로 확인 한 번.
    const isOverwrite = customTemplateNames.includes(title);
    if (isOverwrite && !confirm(`'${title}' 프리셋을 지금 내용으로 덮어쓸까요?`)) return;
    onSaveNewTemplate(title, previewSteps);
    setCategory(title);
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
            <div className="text-[10px] font-semibold text-zinc-500 mt-3 mb-0.5 px-2 border-t border-zinc-200 pt-2">저장한 순서</div>
            {customTemplateNames.length === 0 ? (
              <p className="text-[10px] text-zinc-400 px-2 leading-snug">
                아래 &lsquo;저장&rsquo;에 이름을 넣고 저장하면 여기 나타나요 — 그걸 누르면 다시 불러와서 쓸 수 있어요.
              </p>
            ) : (
              customTemplateNames.map((c) => (
                <div key={c} className="flex items-center gap-1">
                  <button
                    className={`flex-1 min-w-0 text-left text-sm px-2 py-1.5 rounded ${
                      c === category ? 'bg-indigo-600 text-white whitespace-normal break-words' : 'hover:bg-zinc-100 truncate'
                    }`}
                    title={c}
                    onClick={() => setCategory(c)}
                  >
                    {c}
                  </button>
                  <button
                    className="shrink-0 text-sm leading-none px-1.5 py-1 rounded text-zinc-400 hover:text-white hover:bg-red-600"
                    title={`저장한 순서 '${c}' 삭제`}
                    aria-label={`저장한 순서 '${c}' 삭제`}
                    onClick={() => {
                      if (!confirm(`저장한 순서 '${c}'을(를) 삭제할까요?`)) return;
                      const t = templates.find((tpl) => tpl.name === c);
                      if (t) onRemoveTemplate(t.id);
                      if (category === c) setCategory(TEMPLATE_CATEGORIES[0]);
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="flex-1 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
              <span className="text-zinc-500 whitespace-nowrap shrink-0">동</span>
              <select className="border border-zinc-300 rounded px-2 py-1 shrink-0" value={blockId} onChange={(e) => setBlockId(e.target.value)}>
                {blocks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <span className="text-zinc-500 ml-2 whitespace-nowrap shrink-0">시작일</span>
              <input
                type="date"
                className="border border-zinc-300 rounded px-2 py-1 shrink-0"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
              <span className="text-zinc-500 ml-2 whitespace-nowrap shrink-0">층</span>
              <input
                type="text"
                placeholder="예: 3 (→3F)"
                className="border border-zinc-300 rounded px-2 py-1 w-24 shrink-0"
                value={floor}
                onChange={(e) => setFloor(e.target.value)}
                onBlur={() => setFloor((f) => (/^\d+$/.test(f.trim()) ? `${f.trim()}F` : f.trim()))}
                title="숫자만 넣으면 자동으로 F가 붙어요. 검색에서 이 층수로 찾을 수 있어요."
              />
              <span className="text-zinc-500 ml-2 whitespace-nowrap shrink-0">반복 횟수</span>
              <input
                type="number"
                min="1"
                max="60"
                className="border border-zinc-300 rounded px-2 py-1 w-16 shrink-0"
                value={repeatCount}
                onChange={(e) => setRepeatCount(e.target.value)}
              />
              <button
                type="button"
                className="text-xs px-2 py-1 rounded border border-zinc-300 ml-auto disabled:opacity-40"
                onClick={() => setOrderedIndices([])}
                disabled={orderedIndices.length === 0}
                title="선택한 순서를 모두 비웁니다"
              >
                전체 선택 해제
              </button>
              <button className="text-xs px-2 py-1 rounded border border-zinc-300" onClick={resetOrder}>
                기본 순서로 초기화
              </button>
            </div>

            <div className="flex gap-3">
                {/* 선택된 순서 */}
                <div className="flex-1 flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold text-zinc-500">선택한 순서</h3>
                    {orderedIndices.length > 0 && (
                      <button
                        type="button"
                        className="text-xs text-red-600 hover:underline"
                        onClick={() => setOrderedIndices([])}
                      >
                        전체 취소
                      </button>
                    )}
                  </div>
                  {orderedIndices.length === 0 && <p className="text-xs text-zinc-400">오른쪽 목록에서 공정을 눌러 순서를 만드세요.</p>}
                  {orderedIndices
                    .filter((idx) => idx < editSteps.length)
                    .map((idx, pos) => (
                    <div key={`${idx}-${pos}`} className="flex items-center gap-2 text-sm border border-zinc-200 rounded px-2 py-1 min-h-[36px]">
                      <span className="w-5 shrink-0 text-center text-xs font-semibold text-indigo-600">{pos + 1}</span>
                      <span className="flex-1">
                        {editSteps[idx].name} <span className="text-[10px] text-zinc-400">{editSteps[idx].durationDays}일</span>
                      </span>
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

                {/* 편집 가능한 공정 목록: 이름 눌러 순서 추가 + 일수/필요시/삭제 편집 + 단계 추가 */}
                <div className="flex-1 flex flex-col gap-1">
                  <h3 className="text-xs font-semibold text-zinc-500">공정 목록 (이름 눌러 순서 추가 · 일수·삭제 편집)</h3>
                  {editSteps.length === 0 && (
                    <p className="text-xs text-zinc-400">아래에서 단계를 직접 추가해 순서를 만드세요.</p>
                  )}
                  {editSteps.map((s, i) => {
                    const picked = orderedIndices.includes(i);
                    return (
                      <div
                        key={i}
                        className={`flex items-center gap-1 border rounded px-1.5 py-1 text-sm min-h-[36px] ${
                          picked ? 'border-indigo-300 bg-indigo-50' : 'border-zinc-200'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => toggleStep(i)}
                          className={`flex-1 text-left truncate ${picked ? 'text-indigo-700' : 'hover:text-zinc-900'}`}
                          title={picked ? '순서에서 빼기' : '순서에 추가'}
                        >
                          {picked && <span className="text-[10px] font-semibold mr-1">{orderedIndices.indexOf(i) + 1}번</span>}
                          {s.name}
                        </button>
                        <input
                          type="number"
                          min="1"
                          value={s.durationDays}
                          onChange={(e) => setStepDays(i, e.target.value)}
                          className="w-11 border border-zinc-300 rounded px-1 py-0.5 text-xs text-center"
                          title="소요 일수"
                        />
                        <span className="text-[10px] text-zinc-400">일</span>
                        <button
                          type="button"
                          className="text-xs text-zinc-400 hover:text-red-600 shrink-0 px-0.5"
                          title="이 단계 삭제"
                          onClick={() => deleteStep(i)}
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                  {/* 단계 추가 */}
                  <div className="flex items-center gap-1 mt-1 border-t border-zinc-100 pt-2">
                    <input
                      type="text"
                      placeholder="새 단계 이름 (예: 터파기)"
                      value={newStepName}
                      onChange={(e) => setNewStepName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addStep();
                      }}
                      className="flex-1 border border-zinc-300 rounded px-1.5 py-0.5 text-xs"
                    />
                    <input
                      type="number"
                      min="1"
                      value={newStepDays}
                      onChange={(e) => setNewStepDays(e.target.value)}
                      className="w-11 border border-zinc-300 rounded px-1 py-0.5 text-xs text-center"
                    />
                    <span className="text-[10px] text-zinc-400">일</span>
                    <button type="button" className="text-xs px-2 py-0.5 rounded bg-zinc-700 text-white shrink-0" onClick={addStep}>
                      단계 추가
                    </button>
                  </div>
                </div>
              </div>
          </div>
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          {customTemplateNames.includes(saveTitle.trim()) && (
            <span className="text-[11px] text-amber-600 mr-auto">
              &lsquo;{saveTitle.trim()}&rsquo; 프리셋에 덮어쓰기 됩니다
            </span>
          )}
          <input
            type="text"
            placeholder="저장할 이름 (예: 기초공사-A동)"
            className="border border-zinc-300 rounded px-2 py-1 text-sm w-44"
            value={saveTitle}
            onChange={(e) => setSaveTitle(e.target.value)}
          />
          <button className="px-3 py-1 rounded border border-zinc-300 text-sm" onClick={handleSaveAsNew}>
            저장
          </button>
          <button className="px-3 py-1 rounded border border-zinc-300 text-sm" onClick={onClose}>
            취소
          </button>
          <button className="px-3 py-1 rounded bg-indigo-600 text-white text-sm" onClick={handleSubmit}>
            생성
          </button>
        </div>
      </div>

      {holidayConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-lg shadow-lg w-full max-w-sm p-4 flex flex-col gap-3">
            <p className="text-sm font-medium">시작일이 휴일입니다.</p>
            <p className="text-sm text-zinc-600">
              <strong>{startDate}</strong> ({startHolidayLabel})은(는) 휴일이에요. 원래는 다음 작업일로 넘겨서 생성하는데, 그대로
              이 날에 시작할까요?
            </p>
            <div className="flex justify-end gap-2 text-sm">
              <button
                className="px-3 py-1 rounded border border-zinc-300"
                onClick={() => doSubmit(false)}
                data-testid="genholiday-skip"
              >
                아니오 (다음 작업일로)
              </button>
              <button
                className="px-3 py-1 rounded bg-indigo-600 text-white"
                onClick={() => doSubmit(true)}
                data-testid="genholiday-force"
              >
                예 (휴일에 그대로 생성)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
