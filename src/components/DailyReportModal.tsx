'use client';

import { useMemo, useState } from 'react';
import { ISODate } from '@/lib/domain/dateUtils';
import { processLabel } from '@/lib/domain/schedule';
import { Block, DirectLaborEntry, ProcessInstance, SiteInfo } from '@/lib/domain/types';

// 직영 작업 구분 프리셋 — 매번 타이핑하지 않고 목록에서 고르게 한다.
const DIRECT_LABOR_CATEGORIES = [
  '공사',
  '직영/용역',
  '안전',
  '안전시설',
  '할석·미장',
  '견출',
  '바닥미장',
  '해체·정리',
  '세대청소',
  '기타',
];

interface DailyReportModalProps {
  date: ISODate;
  siteInfo: SiteInfo;
  blocks: Block[];
  processes: ProcessInstance[];
  directLabor: DirectLaborEntry[];
  onAddDirectLabor: (date: ISODate, category: string, workContent: string, headcount: number) => void;
  onRemoveDirectLabor: (id: string) => void;
  onClose: () => void;
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export default function DailyReportModal({
  date,
  siteInfo,
  blocks,
  processes,
  directLabor,
  onAddDirectLabor,
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
  const dayDirectLabor = useMemo(() => directLabor.filter((d) => d.date === date), [directLabor, date]);

  const crewHeadcount = dayProcesses.reduce((sum, p) => sum + (p.crew?.headcount ?? 0), 0);
  const directHeadcount = dayDirectLabor.reduce((sum, d) => sum + d.headcount, 0);
  const totalHeadcount = crewHeadcount + directHeadcount;

  const [newCategory, setNewCategory] = useState(DIRECT_LABOR_CATEGORIES[0]);
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

  function downloadExcel() {
    const rows: string[] = [];
    rows.push(['현장명', siteInfo.name].map(csvEscape).join(','));
    rows.push(['일자', date].map(csvEscape).join(','));
    rows.push(
      ['총 출력인원', `${totalHeadcount}명 (협력사 ${crewHeadcount}명 + 직영 ${directHeadcount}명)`].map(csvEscape).join(','),
    );
    rows.push('');
    rows.push(['작업내용'].map(csvEscape).join(','));
    rows.push(['동', '공정', '작업팀', '인원'].map(csvEscape).join(','));
    for (const p of dayProcesses) {
      rows.push(
        [blockNames[p.blockId] ?? '', processLabel(p), p.crew?.team ?? '', p.crew ? String(p.crew.headcount) : '']
          .map(csvEscape)
          .join(','),
      );
    }
    rows.push('');
    rows.push(['직영 작업'].map(csvEscape).join(','));
    rows.push(['구분', '작업내용', '인원'].map(csvEscape).join(','));
    for (const d of dayDirectLabor) {
      rows.push([d.category, d.workContent, String(d.headcount)].map(csvEscape).join(','));
    }
    // 엑셀이 UTF-8 CSV의 한글을 깨뜨리지 않도록 BOM을 붙인다.
    const csv = '﻿' + rows.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `작업일보_${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 print:bg-white print:p-0">
      <div
        id="daily-report-printable"
        className="bg-white rounded-lg shadow-lg w-full max-w-xl max-h-[85vh] overflow-y-auto p-4 flex flex-col gap-4 print:max-w-none print:shadow-none print:rounded-none print:text-black"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">작업일보</h2>
          <div className="flex gap-2 print:hidden">
            <button className="text-sm px-2 py-1 rounded border border-zinc-300" onClick={downloadExcel} data-testid="download-excel">
              엑셀 다운로드
            </button>
            <button className="text-sm px-2 py-1 rounded border border-zinc-300" onClick={() => window.print()} data-testid="print-report">
              인쇄 / PDF 저장
            </button>
            <button className="text-sm px-2 py-1 rounded border border-zinc-300" onClick={onClose}>
              닫기
            </button>
          </div>
        </div>

        <div className="text-sm grid grid-cols-2 gap-1 print:text-base">
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
          <h3 className="text-sm font-semibold text-zinc-700 print:text-base">작업내용</h3>
          {dayProcesses.length === 0 && <p className="text-xs text-zinc-400">이 날짜에 예정된 공정이 없습니다.</p>}
          <div className="flex flex-col gap-1">
            {dayProcesses.map((p) => (
              <div
                key={p.id}
                className="text-sm border border-zinc-200 rounded px-2 py-1 flex items-center justify-between print:text-base print:border-zinc-400"
              >
                <span>
                  <strong>{blockNames[p.blockId] ?? ''}</strong> {processLabel(p)}
                </span>
                <span className="text-xs text-zinc-500 print:text-sm">{p.crew ? `${p.crew.team} · ${p.crew.headcount}명` : '작업팀 미배정'}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-zinc-700 print:text-base">직영 작업</h3>
          <p className="text-xs text-zinc-500 print:hidden">공정표에 없는 직영(자체) 인력 작업을 이 날짜에 자유롭게 추가합니다.</p>
          <div className="flex flex-col gap-1">
            {dayDirectLabor.map((d) => (
              <div
                key={d.id}
                className="text-sm border border-zinc-200 rounded px-2 py-1 flex items-center justify-between print:text-base print:border-zinc-400"
              >
                <span>
                  <span className="text-xs text-zinc-500 print:text-sm">[{d.category}]</span> {d.workContent} · {d.headcount}명
                </span>
                <button className="text-xs text-red-600 print:hidden" onClick={() => onRemoveDirectLabor(d.id)}>
                  삭제
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-1 print:hidden">
            <select
              className="border border-zinc-300 rounded px-2 py-1 text-sm w-28 shrink-0"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
            >
              {DIRECT_LABOR_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              className="border border-zinc-300 rounded px-2 py-1 text-sm flex-1"
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="작업 내용 (예: 자재 정리)"
            />
            <input
              className="border border-zinc-300 rounded px-2 py-1 text-sm w-20"
              value={newHeadcount}
              onChange={(e) => setNewHeadcount(e.target.value)}
              placeholder="인원"
              type="number"
              min="1"
            />
            <button className="px-3 py-1 rounded bg-indigo-600 text-white text-sm" onClick={submitNewDirectLabor}>
              추가
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
