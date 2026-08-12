'use client';

import { useMemo, useState } from 'react';
import { ISODate } from '@/lib/domain/dateUtils';
import { downloadDailyReportExcel } from '@/lib/export/dailyReportExcel';
import { FILL_HEX, SUB_FILL } from '@/lib/export/scheduleExcel';
import { PROCESS_COLOR, PROCESS_TYPE_MAP } from '@/lib/domain/processTypes';
import { isKnownType, processLabel } from '@/lib/domain/schedule';
import { Block, DirectLaborEntry, ProcessInstance, SiteInfo } from '@/lib/domain/types';

// 작업내용을 동별이 아니라 공종별로 묶어서 보여줄 때 쓰는 순서·표기. W_철근/S_철근은
// "철근" 하나로 합친다 — 현장에서는 동/구간별이 아니라 공종별로 인력을 배치하기 때문에
// "타설: 11동,16층 / 12동,17층" 식으로 한눈에 보는 게 더 유용하다는 피드백.
const WORK_GROUP_ORDER = [
  'GANGFORM',
  'REBAR',
  'REBAR_INSPECTION',
  'AL',
  'POUR',
  'RELEASE_AGENT',
  'ELECTRIC_FACILITY',
  'TROWEL',
] as const;
const WORK_GROUP_LABEL: Record<string, string> = {
  GANGFORM: '갱폼',
  REBAR: '철근',
  REBAR_INSPECTION: '철근검측',
  AL: 'AL',
  POUR: '타설',
  RELEASE_AGENT: '박리제',
  ELECTRIC_FACILITY: '전기·설비',
  TROWEL: '먹메김',
};
// 간트차트 칩 색을 그대로 재사용해서 한눈에 봐도 어느 공종인지 바로 알아볼 수 있게 한다.
// 보조공정은 차트에서도 무채색이라 여기서도 회색으로 맞춘다.
const NEUTRAL_COLOR = { bg: 'bg-zinc-200', text: 'text-zinc-700' };
const WORK_GROUP_COLOR: Record<string, { bg: string; text: string }> = {
  GANGFORM: PROCESS_COLOR.GANGFORM,
  REBAR: PROCESS_COLOR.W_REBAR,
  REBAR_INSPECTION: NEUTRAL_COLOR,
  AL: PROCESS_COLOR.AL,
  POUR: PROCESS_COLOR.POUR,
  RELEASE_AGENT: NEUTRAL_COLOR,
  ELECTRIC_FACILITY: NEUTRAL_COLOR,
  TROWEL: NEUTRAL_COLOR,
};
// 엑셀 다운로드용 — 위 팔레트를 셀 배경에 쓸 수 있는 ARGB 헥스로 옮긴 것.
const WORK_GROUP_FILL_HEX: Record<string, string> = {
  GANGFORM: FILL_HEX.GANGFORM,
  REBAR: FILL_HEX.W_REBAR,
  REBAR_INSPECTION: SUB_FILL,
  AL: FILL_HEX.AL,
  POUR: FILL_HEX.POUR,
  RELEASE_AGENT: SUB_FILL,
  ELECTRIC_FACILITY: SUB_FILL,
  TROWEL: SUB_FILL,
};

function workGroupKey(typeCode: string): string {
  if (typeCode === 'W_REBAR' || typeCode === 'S_REBAR') return 'REBAR';
  return typeCode;
}

// 층수는 갱폼 공정에만 붙어 있으므로(showFloorLabel), 같은 cycleId의 갱폼에서 가져온다.
function floorNumberLabel(floorLabel: string | undefined): string {
  if (!floorLabel) return '';
  const digits = floorLabel.match(/^\d+/)?.[0];
  return digits ? `${digits}층` : floorLabel;
}

// 직영 작업 구분 — 관리자/공사/직영·용역/안전/안전시설 5개는 매일 반드시 입력해야 하는
// 고정 항목이라 항상 화면에 입력칸이 떠 있고, 나머지는 필요할 때만 선택해서 추가한다.
const FIXED_LABOR_CATEGORIES = ['관리자', '공사', '직영/용역', '안전', '안전시설'];
const OPTIONAL_LABOR_CATEGORIES = ['할석·미장', '견출', '시스템', '해체·정리', '세대청소', '바닥미장', '기타'];

interface DailyReportModalProps {
  date: ISODate;
  siteInfo: SiteInfo;
  blocks: Block[];
  processes: ProcessInstance[];
  directLabor: DirectLaborEntry[];
  notes: Record<string, string>;
  onAddDirectLabor: (date: ISODate, category: string, workContent: string, headcount: number, manager?: string) => void;
  onSetFixedLabor: (date: ISODate, category: string, headcount: number, workContent: string) => void;
  onUpdateDirectLabor: (id: string, headcount: number, workContent: string) => void;
  onRemoveDirectLabor: (id: string) => void;
  onClose: () => void;
}

export default function DailyReportModal({
  date,
  siteInfo,
  blocks,
  processes,
  directLabor,
  notes,
  onAddDirectLabor,
  onSetFixedLabor,
  onUpdateDirectLabor,
  onRemoveDirectLabor,
  onClose,
}: DailyReportModalProps) {
  const blockNames = useMemo(() => Object.fromEntries(blocks.map((b) => [b.id, b.name])), [blocks]);

  const dayProcesses = useMemo(
    () =>
      processes
        .filter((p) => p.date === date)
        .sort((a, b) => (blockNames[a.blockId] ?? '').localeCompare(blockNames[b.blockId] ?? '')),
    [processes, date, blockNames],
  );

  const floorByCycle = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of processes) {
      if (p.typeCode === 'GANGFORM' && p.floorLabel) map.set(p.cycleId, p.floorLabel);
    }
    return map;
  }, [processes]);

  // 동별 나열 대신 공종별로 묶어서 "타설: 11동,16층 / 12동,17층" 형태로 보여준다.
  // 오전/오후로 반나절 나눈 공정은 태그를 붙여서 구분한다.
  const groupedDayProcesses = useMemo(() => {
    const map = new Map<string, { blockName: string; floor: string; timeSlot?: 'morning' | 'afternoon'; headcount?: number }[]>();
    for (const p of dayProcesses) {
      // 작업일보 "주요작업내용"에는 주공정만 싣는다 — 박리제·전기·설비·먹매김·철근검측 같은
      // 보조공정은 제외한다(커스텀 구간공정 단계는 PROCESS_TYPE_MAP에 없어 주공정으로 취급).
      if (PROCESS_TYPE_MAP[p.typeCode]?.category === 'sub') continue;
      const key = isKnownType(p.typeCode) ? workGroupKey(p.typeCode) : processLabel(p);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({
        blockName: blockNames[p.blockId] ?? '',
        floor: floorNumberLabel(floorByCycle.get(p.cycleId)),
        timeSlot: p.timeSlot === 'morning' || p.timeSlot === 'afternoon' ? p.timeSlot : undefined,
        headcount: p.crew?.headcount,
      });
    }
    const orderedKeys = WORK_GROUP_ORDER.filter((k) => map.has(k));
    const otherKeys = [...map.keys()].filter((k) => !(orderedKeys as string[]).includes(k));
    return [...orderedKeys, ...otherKeys].map((key) => ({
      label: WORK_GROUP_LABEL[key] ?? key,
      color: WORK_GROUP_COLOR[key] ?? NEUTRAL_COLOR,
      colorHex: WORK_GROUP_FILL_HEX[key] ?? SUB_FILL,
      items: map
        .get(key)!
        .sort((a, b) => a.blockName.localeCompare(b.blockName) || a.floor.localeCompare(b.floor)),
    }));
  }, [dayProcesses, floorByCycle, blockNames]);
  const dayDirectLabor = useMemo(() => directLabor.filter((d) => d.date === date), [directLabor, date]);
  // 그리드의 "특이사항" 행에 동별로 적어둔 메모 중, 이 날짜에 실제로 내용이 있는 것만 모은다.
  const dayNotes = useMemo(
    () =>
      blocks
        .map((b) => ({ blockId: b.id, blockName: b.name, text: notes[`${b.id}__${date}`] ?? '' }))
        .filter((n) => n.text.trim().length > 0),
    [blocks, notes, date],
  );

  const crewHeadcount = dayProcesses.reduce((sum, p) => sum + (p.crew?.headcount ?? 0), 0);
  const directHeadcount = dayDirectLabor.reduce((sum, d) => sum + d.headcount, 0);
  const totalHeadcount = crewHeadcount + directHeadcount;

  const [newCategory, setNewCategory] = useState(OPTIONAL_LABOR_CATEGORIES[0]);
  const [newContent, setNewContent] = useState('');
  const [newHeadcount, setNewHeadcount] = useState('');

  function submitNewDirectLabor() {
    const content = newContent.trim();
    const count = Number(newHeadcount);
    if (!content || !Number.isFinite(count) || count <= 0) return;
    onAddDirectLabor(date, newCategory, content, count);
    setNewContent('');
    setNewHeadcount('');
  }

  // 고정 5개 항목(관리자/공사/직영·용역/안전/안전시설)은 날짜당 하나씩만 있다고 보고
  // 카테고리로 바로 찾는다. 선택 추가 항목은 같은 구분을 여러 번 추가할 수 있어서
  // (예: 기타를 두 번) 입력한 순서대로 여러 명이 될 수 있다.
  const fixedLaborByCategory = useMemo(() => {
    const map = new Map<string, DirectLaborEntry>();
    for (const d of dayDirectLabor) {
      if (FIXED_LABOR_CATEGORIES.includes(d.category)) map.set(d.category, d);
    }
    return map;
  }, [dayDirectLabor]);
  const optionalDayLabor = useMemo(
    () => dayDirectLabor.filter((d) => !FIXED_LABOR_CATEGORIES.includes(d.category)),
    [dayDirectLabor],
  );
  // 같은 구분이 여러 개면(예: 기타 2개) 입력한 순서대로 ①②… 번호를 붙인다.
  const optionalLaborSeq = useMemo(() => {
    const counts = new Map<string, number>();
    const seq = new Map<string, number>();
    for (const d of optionalDayLabor) {
      const n = (counts.get(d.category) ?? 0) + 1;
      counts.set(d.category, n);
      seq.set(d.id, n);
    }
    const totals = counts;
    return { seq, totals };
  }, [optionalDayLabor]);

  // 직전에 직영 작업이 입력된 날짜를 찾아 그 내용을 오늘 날짜로 그대로 불러온다.
  const previousLaborDate = useMemo(() => {
    const pastDates = directLabor.filter((d) => d.date < date).map((d) => d.date);
    if (pastDates.length === 0) return null;
    return pastDates.reduce((max, d) => (d > max ? d : max));
  }, [directLabor, date]);
  const previousLabor = useMemo(
    () => (previousLaborDate ? directLabor.filter((d) => d.date === previousLaborDate) : []),
    [directLabor, previousLaborDate],
  );

  function loadPreviousDirectLabor() {
    for (const d of previousLabor) {
      if (FIXED_LABOR_CATEGORIES.includes(d.category)) {
        onSetFixedLabor(date, d.category, d.headcount, d.workContent);
      } else {
        onAddDirectLabor(date, d.category, d.workContent, d.headcount, d.manager);
      }
    }
  }

  async function downloadExcel() {
    await downloadDailyReportExcel({
      siteName: siteInfo.name,
      date,
      totalHeadcount,
      crewHeadcount,
      directHeadcount,
      grouped: groupedDayProcesses,
      notes: dayNotes,
      labor: dayDirectLabor.map((d) => ({
        category: d.category,
        manager: d.manager,
        workContent: d.workContent,
        headcount: d.headcount,
      })),
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 print:bg-white print:p-0">
      <div className="print-area bg-white rounded-lg shadow-lg w-full max-w-3xl max-h-[85vh] overflow-y-auto p-5 flex flex-col gap-4 print:max-w-none print:shadow-none print:rounded-none print:text-black">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">{date.slice(5)} 작업일보</h2>
          <div className="flex gap-2 print:hidden">
            <button className="text-lg px-2 py-1 rounded border border-zinc-300" onClick={downloadExcel} data-testid="download-excel">
              엑셀 다운로드
            </button>
            <button className="text-lg px-2 py-1 rounded border border-zinc-300" onClick={() => window.print()} data-testid="print-report">
              인쇄 / PDF 저장
            </button>
            <button className="text-lg px-2 py-1 rounded border border-zinc-300" onClick={onClose}>
              닫기
            </button>
          </div>
        </div>

        <div className="text-lg grid grid-cols-2 gap-1 print:text-base">
          <div>
            <span className="text-zinc-500">현장명</span> {siteInfo.name}
          </div>
          <div>
            <span className="text-zinc-500">일자</span> {date}
          </div>
          <div className="col-span-2">
            <span className="text-zinc-500">총 출력인원</span>{' '}
            <strong>{totalHeadcount}명</strong> (협력사 {crewHeadcount}명 + 직영 {directHeadcount}명)
          </div>
        </div>

        <section className="flex flex-col gap-1">
          <h3 className="text-xl font-bold text-zinc-700 print:text-base">주요작업내용 <span className="text-base font-normal text-zinc-400">(장비있으면 장비 포함)</span></h3>
          {groupedDayProcesses.length === 0 && <p className="text-base text-zinc-400">이 날짜에 예정된 주요공정이 없습니다.</p>}
          <div className="flex flex-col gap-1.5">
            {groupedDayProcesses.map((g) => {
              const groupHeadcount = g.items.reduce((s, it) => s + (it.headcount ?? 0), 0);
              return (
              <div key={g.label} className="flex items-start gap-2 print:border-b print:border-zinc-300 print:pb-1">
                <span
                  className={`shrink-0 w-28 rounded px-2 py-1 text-center text-base font-semibold ${g.color.bg} ${g.color.text} print:border print:border-zinc-500 print:bg-white print:text-black`}
                >
                  {g.label}
                  {groupHeadcount > 0 && <span className="ml-1 text-sm font-normal">{groupHeadcount}명</span>}
                </span>
                <div className="flex flex-1 flex-wrap gap-1">
                  {g.items.map((it, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-base text-zinc-700 print:bg-white print:border print:border-zinc-300 print:text-lg"
                    >
                      {it.timeSlot && (
                        <span
                          className={`rounded px-1 text-sm font-semibold print:border print:border-current ${
                            it.timeSlot === 'morning' ? 'bg-sky-100 text-sky-700' : 'bg-violet-100 text-violet-700'
                          }`}
                        >
                          {it.timeSlot === 'morning' ? '오전' : '오후'}
                        </span>
                      )}
                      {it.blockName}
                      {it.floor ? ` ${it.floor}` : ''}
                      {it.headcount ? <span className="ml-1 font-semibold text-indigo-700">{it.headcount}명</span> : ''}
                    </span>
                  ))}
                </div>
              </div>
              );
            })}
          </div>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-xl font-bold text-zinc-700 print:text-base">특이사항</h3>
          {dayNotes.length === 0 && <p className="text-base text-zinc-400">이 날짜에 등록된 특이사항이 없습니다.</p>}
          <div className="flex flex-col gap-1">
            {dayNotes.map((n) => (
              <div
                key={n.blockId}
                className="text-lg border border-zinc-200 rounded px-2 py-1 print:text-base print:border-zinc-400"
              >
                <strong>{n.blockName}</strong> {n.text}
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-bold text-zinc-700 print:text-base">직영 작업</h3>
            {previousLabor.length > 0 && (
              <button
                className="text-base px-2 py-0.5 rounded border border-zinc-300 print:hidden"
                onClick={loadPreviousDirectLabor}
                title={`${previousLaborDate} 작업 내용을 불러옵니다`}
              >
                이전 작업일 불러오기
              </button>
            )}
          </div>
          <p className="text-base text-zinc-500 print:hidden">
            아래 5개(관리자/공사/직영·용역/안전/안전시설)는 매일 반드시 입력하는 항목이고, 그 외는 필요할 때만 선택해서 추가합니다.
          </p>

          {/* 고정 5개 — 항상 입력칸이 떠 있고, 인원·작업내용만 채우면 자동으로 기록된다. */}
          <div className="flex flex-col gap-1">
            {FIXED_LABOR_CATEGORIES.map((cat) => {
              const entry = fixedLaborByCategory.get(cat);
              return (
                <div key={cat} className="flex items-center gap-2 text-lg border border-zinc-200 rounded px-2 py-1 print:text-base print:border-zinc-400">
                  <span className="w-24 shrink-0 font-medium text-zinc-700 print:w-24">{cat}</span>
                  <input
                    className="w-16 shrink-0 border border-zinc-300 rounded px-1.5 py-1 text-base print:hidden"
                    value={entry?.headcount || ''}
                    onChange={(e) => onSetFixedLabor(date, cat, Math.max(0, Number(e.target.value) || 0), entry?.workContent ?? '')}
                    placeholder="인원"
                    type="number"
                    min="0"
                  />
                  <span className="text-base text-zinc-400 shrink-0 print:hidden">명</span>
                  <span className="hidden print:inline">{entry?.headcount ?? 0}명</span>
                  <input
                    className="flex-1 border border-zinc-300 rounded px-2 py-0.5 text-base print:hidden"
                    value={entry?.workContent ?? ''}
                    onChange={(e) => onSetFixedLabor(date, cat, entry?.headcount ?? 0, e.target.value)}
                    placeholder="작업 내용"
                  />
                  <span className="hidden print:inline">{entry?.workContent}</span>
                </div>
              );
            })}
          </div>

          {/* 선택 추가된 항목들 — 고정 5개와 "똑같은 입력 행" 형태(구분 + 인원칸 + 작업내용칸)로
              그 자리에서 편집 가능. 다른 점은 삭제 버튼이 붙는 것뿐(선택 항목은 지울 수 있으므로).
              같은 구분을 여러 번 추가하면 입력 순서대로 번호를 붙인다. */}
          {optionalDayLabor.length > 0 && (
            <div className="flex flex-col gap-1">
              {optionalDayLabor.map((d) => {
                const seq = optionalLaborSeq.seq.get(d.id) ?? 1;
                const total = optionalLaborSeq.totals.get(d.category) ?? 1;
                const catLabel = total > 1 ? `${d.category} ${seq}` : d.category;
                return (
                  <div
                    key={d.id}
                    className="flex items-center gap-2 text-lg border border-zinc-200 rounded px-2 py-1 print:text-base print:border-zinc-400"
                  >
                    <span className="w-24 shrink-0 font-medium text-zinc-700 print:w-24">{catLabel}</span>
                    <input
                      className="w-16 shrink-0 border border-zinc-300 rounded px-1.5 py-1 text-base print:hidden"
                      value={d.headcount || ''}
                      onChange={(e) => onUpdateDirectLabor(d.id, Math.max(0, Number(e.target.value) || 0), d.workContent)}
                      placeholder="인원"
                      type="number"
                      min="0"
                    />
                    <span className="text-base text-zinc-400 shrink-0 print:hidden">명</span>
                    <span className="hidden print:inline">{d.headcount}명</span>
                    <input
                      className="flex-1 border border-zinc-300 rounded px-2 py-0.5 text-base print:hidden"
                      value={d.workContent}
                      onChange={(e) => onUpdateDirectLabor(d.id, d.headcount, e.target.value)}
                      placeholder="작업 내용"
                    />
                    <span className="hidden print:inline">{d.workContent}</span>
                    <button
                      className="text-base text-red-600 shrink-0 hover:text-red-700 print:hidden"
                      onClick={() => onRemoveDirectLabor(d.id)}
                      title="이 항목 삭제"
                    >
                      삭제
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex items-center gap-2 mt-1 print:hidden">
            <select
              className="border border-zinc-300 rounded px-2 py-1 text-lg w-32 shrink-0"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
            >
              {OPTIONAL_LABOR_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              className="border border-zinc-300 rounded px-2 py-1 text-lg flex-1"
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="작업 내용 (예: 자재 정리)"
            />
            <input
              className="border border-zinc-300 rounded px-2 py-1 text-lg w-20"
              value={newHeadcount}
              onChange={(e) => setNewHeadcount(e.target.value)}
              placeholder="인원"
              type="number"
              min="1"
            />
            <button className="px-3 py-1 rounded bg-indigo-600 text-white text-lg" onClick={submitNewDirectLabor}>
              추가
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
