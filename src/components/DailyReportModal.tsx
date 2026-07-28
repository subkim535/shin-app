'use client';

import { useMemo, useState } from 'react';
import { ISODate } from '@/lib/domain/dateUtils';
import { processLabel } from '@/lib/domain/schedule';
import { Block, DirectLaborEntry, ProcessInstance, SiteInfo } from '@/lib/domain/types';

interface DailyReportModalProps {
  date: ISODate;
  siteInfo: SiteInfo;
  blocks: Block[];
  processes: ProcessInstance[];
  directLabor: DirectLaborEntry[];
  onAddDirectLabor: (date: ISODate, workContent: string, headcount: number) => void;
  onRemoveDirectLabor: (id: string) => void;
  onClose: () => void;
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

  const [newContent, setNewContent] = useState('');
  const [newHeadcount, setNewHeadcount] = useState('');

  function submitNewDirectLabor() {
    const content = newContent.trim();
    const count = Number(newHeadcount);
    if (!content || !Number.isFinite(count) || count <= 0) return;
    onAddDirectLabor(date, content, count);
    setNewContent('');
    setNewHeadcount('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-xl max-h-[85vh] overflow-y-auto p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">작업일보</h2>
          <button className="text-sm px-2 py-1 rounded border border-zinc-300" onClick={onClose}>
            닫기
          </button>
        </div>

        <div className="text-sm grid grid-cols-2 gap-1">
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
          <h3 className="text-sm font-semibold text-zinc-700">작업내용</h3>
          {dayProcesses.length === 0 && <p className="text-xs text-zinc-400">이 날짜에 예정된 공정이 없습니다.</p>}
          <div className="flex flex-col gap-1">
            {dayProcesses.map((p) => (
              <div key={p.id} className="text-sm border border-zinc-200 rounded px-2 py-1 flex items-center justify-between">
                <span>
                  <strong>{blockNames[p.blockId] ?? ''}</strong> {processLabel(p)}{' '}
                  <span className="text-xs text-zinc-400">{p.timeSlot === 'am' ? '오전' : p.timeSlot === 'pm' ? '오후' : ''}</span>
                </span>
                <span className="text-xs text-zinc-500">{p.crew ? `${p.crew.team} · ${p.crew.headcount}명` : '작업팀 미배정'}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-zinc-700">직영 작업</h3>
          <p className="text-xs text-zinc-500">공정표에 없는 직영(자체) 인력 작업을 이 날짜에 자유롭게 추가합니다.</p>
          <div className="flex flex-col gap-1">
            {dayDirectLabor.map((d) => (
              <div key={d.id} className="text-sm border border-zinc-200 rounded px-2 py-1 flex items-center justify-between">
                <span>
                  {d.workContent} · {d.headcount}명
                </span>
                <button className="text-xs text-red-600" onClick={() => onRemoveDirectLabor(d.id)}>
                  삭제
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-1">
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
