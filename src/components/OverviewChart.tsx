'use client';

import { useMemo } from 'react';
import { formatMonthDay, ISODate } from '@/lib/domain/dateUtils';
import { PROCESS_COLOR, PROCESS_TYPE_MAP, customProcessColor } from '@/lib/domain/processTypes';
import { Block, ProcessInstance } from '@/lib/domain/types';

const FALLBACK_COLOR = { bg: 'bg-slate-200', text: 'text-slate-800' };

function processColor(p: ProcessInstance) {
  return PROCESS_COLOR[p.typeCode] ?? (p.customLabel ? customProcessColor(p.customLabel) : FALLBACK_COLOR);
}

function completionLabel(p: ProcessInstance): string {
  const floor = p.floorLabel ? `${p.floorLabel} ` : '';
  return floor + (p.customLabel ?? PROCESS_TYPE_MAP[p.typeCode]?.name ?? p.typeCode);
}

interface OverviewChartProps {
  blocks: Block[];
  processes: ProcessInstance[];
}

function yearMonthOf(date: ISODate): string {
  return date.slice(0, 7); // 'YYYY-MM'
}

function monthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split('-');
  return `${y}년 ${Number(m)}월`;
}

function nextYearMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const next = new Date(y, m, 1); // m은 1월=1이라 그대로 넘기면 다음달 1일
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
}

// 전체공정표: 월 단위로 훑어볼 수 있게, 모든 주요/구간공정을 월별로 모아 보여준다.
// (보조공정 배지는 제외.) 예전엔 완료 시점(사이클 마지막 공정)만 봐서 한 동에 타설 하나만
// 뜨는 것처럼 보였는데, 이제 그 달의 모든 공정을 날짜순 배지로 다 보여준다.
export default function OverviewChart({ blocks, processes }: OverviewChartProps) {
  // 보조공정을 제외한 모든 공정을 대상으로 한다.
  const pours = useMemo(
    () => processes.filter((p) => PROCESS_TYPE_MAP[p.typeCode]?.category !== 'sub'),
    [processes],
  );

  const months = useMemo(() => {
    if (pours.length === 0) return [];
    const sorted = [...pours].sort((a, b) => a.date.localeCompare(b.date));
    const first = yearMonthOf(sorted[0].date);
    const last = yearMonthOf(sorted[sorted.length - 1].date);
    const out: string[] = [];
    let cursor = first;
    while (cursor <= last) {
      out.push(cursor);
      cursor = nextYearMonth(cursor);
    }
    return out;
  }, [pours]);

  const byBlockMonth = useMemo(() => {
    const map = new Map<string, ProcessInstance[]>();
    for (const p of pours) {
      const key = `${p.blockId}__${yearMonthOf(p.date)}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    for (const list of map.values()) list.sort((a, b) => a.date.localeCompare(b.date));
    return map;
  }, [pours]);

  if (months.length === 0) {
    return (
      <div className="border border-zinc-200 rounded-md p-8 text-center text-sm text-zinc-400" data-testid="overview-chart">
        아직 등록된 공정이 없습니다.
      </div>
    );
  }

  return (
    <div className="overflow-auto border border-zinc-200 rounded-md h-full" data-testid="overview-chart">
      <table className="border-collapse text-sm w-full">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-20 bg-zinc-100 border-b border-r border-zinc-200 px-3 py-2 text-left font-medium min-w-[96px]">
              동/구간
            </th>
            {months.map((m) => (
              <th
                key={m}
                className="sticky top-0 z-10 bg-zinc-50 border-b border-l border-zinc-200 px-3 py-2 font-medium whitespace-nowrap min-w-[150px]"
              >
                {monthLabel(m)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {blocks.map((b) => (
            <tr key={b.id}>
              <td className="sticky left-0 z-10 bg-white border-b border-r border-zinc-200 px-3 py-2 font-medium whitespace-nowrap align-top">
                {b.name}
              </td>
              {months.map((m) => {
                const list = byBlockMonth.get(`${b.id}__${m}`) ?? [];
                return (
                  <td key={m} className="border-b border-l border-zinc-200 px-2 py-2 align-top">
                    <div className="flex flex-wrap gap-1">
                      {list.map((p) => {
                        const c = processColor(p);
                        return (
                          <span
                            key={p.id}
                            className={`inline-block text-[10px] leading-tight px-1.5 py-0.5 rounded whitespace-nowrap ${c.bg} ${c.text}`}
                            title={`${completionLabel(p)} · ${p.date}`}
                          >
                            {formatMonthDay(p.date)} {completionLabel(p)}
                          </span>
                        );
                      })}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
