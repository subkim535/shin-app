'use client';

import { useMemo } from 'react';
import { formatMonthDay, ISODate } from '@/lib/domain/dateUtils';
import { Block, ProcessInstance } from '@/lib/domain/types';

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

// 전체공정표: 일단위 월간공정표와 달리 주/월 단위로 훑어볼 수 있게, 타설(층 완료 시점)만
// 월별로 모아 간략하게 보여준다. 그 안에서는 며칠에 있었는지 배지로 표시해 주 단위 감각도 준다.
export default function OverviewChart({ blocks, processes }: OverviewChartProps) {
  const pours = useMemo(() => processes.filter((p) => p.typeCode === 'POUR'), [processes]);

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
        아직 등록된 타설 일정이 없습니다.
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
                      {list.map((p) => (
                        <span
                          key={p.id}
                          className="inline-block text-[10px] leading-tight px-1.5 py-0.5 rounded bg-red-100 text-red-700 whitespace-nowrap"
                          title={`타설 ${p.date}${p.floorLabel ? ` (${p.floorLabel})` : ''}`}
                        >
                          {formatMonthDay(p.date)}
                          {p.floorLabel ? ` ${p.floorLabel}` : ''}
                        </span>
                      ))}
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
