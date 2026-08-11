'use client';

import { useMemo } from 'react';
import { processLabel } from '@/lib/domain/schedule';
import { Block, ChangeRecord, DateShiftRecord, ProcessInstance } from '@/lib/domain/types';

interface HistoryPanelProps {
  onClose: () => void;
  changeHistory: ChangeRecord[];
  dateShiftHistory: DateShiftRecord[];
  processes: ProcessInstance[];
  blocks: Block[];
}

export default function HistoryPanel({ onClose, changeHistory, dateShiftHistory, processes, blocks }: HistoryPanelProps) {
  const blockNames = useMemo(() => Object.fromEntries(blocks.map((b) => [b.id, b.name])), [blocks]);
  const processById = useMemo(() => new Map(processes.map((p) => [p.id, p])), [processes]);

  const rows = useMemo(() => {
    const processRows = changeHistory.map((c) => {
      const proc = processById.get(c.processId);
      return {
        kind: 'process' as const,
        key: c.id,
        blockName: proc ? blockNames[proc.blockId] ?? '' : '',
        label: proc ? processLabel(proc) : '(삭제된 공정)',
        from: c.previousDate,
        to: c.newDate,
        reason: c.reason,
      };
    });
    const shiftRows = dateShiftHistory.map((s) => ({
      kind: 'shift' as const,
      key: s.id,
      blockName: '전체 동',
      label: `${s.fromDate} 이후 일정 ${s.deltaDays > 0 ? '+' : ''}${s.deltaDays}일`,
      from: s.fromDate,
      to: undefined,
      reason: s.reason,
    }));
    // 최근 변경이 맨 위에 오도록 뒤집는다.
    return [...processRows, ...shiftRows].reverse();
  }, [changeHistory, dateShiftHistory, processById, blockNames]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-2xl max-h-[85vh] overflow-y-auto p-5 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-3xl font-bold">변경이력</h2>
          <button className="text-xl px-2 py-1 rounded border border-zinc-300" onClick={onClose}>
            닫기
          </button>
        </div>
        {rows.length === 0 && <p className="text-xl text-zinc-500">아직 변경 이력이 없습니다.</p>}
        <div className="flex flex-col gap-1 text-xl">
          {rows.map((r) => (
            <div key={r.key} className="border border-zinc-200 rounded px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="font-medium">{r.blockName}</span>
                <span>{r.label}</span>
                <span className="text-zinc-400">
                  {r.from}
                  {r.to ? ` → ${r.to}` : ''}
                </span>
              </div>
              <div className="text-base text-zinc-500 mt-0.5">사유: {r.reason}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
