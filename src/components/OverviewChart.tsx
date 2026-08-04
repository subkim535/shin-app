'use client';

import { useMemo } from 'react';
import { formatMonthDay, ISODate } from '@/lib/domain/dateUtils';
import { PROCESS_TYPE_MAP } from '@/lib/domain/processTypes';
import { Block, ProcessInstance } from '@/lib/domain/types';

function completionLabel(p: ProcessInstance): string {
  return p.floorLabel ?? p.customLabel ?? PROCESS_TYPE_MAP[p.typeCode]?.name ?? p.typeCode;
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

// 전체공정표: 일단위 월간공정표와 달리 주/월 단위로 훑어볼 수 있게, 각 사이클(기준층 한 층·
// 구간공정 한 벌)의 "완료 시점"만 월별로 모아 간략하게 보여준다. 예전엔 기준층 타설(POUR)만
// 봐서 기초/지하/지상층 같은 구간공정이 아예 안 보였는데, 이제 모든 사이클의 마지막 공정을
// 완료 시점으로 잡아 함께 보여준다. 그 안에서는 며칠에 있었는지 배지로 표시한다.
export default function OverviewChart({ blocks, processes }: OverviewChartProps) {
  // 사이클(cycleId)별 마지막(가장 늦은 날짜) 주요/커스텀 공정 = 그 사이클의 완료 시점.
  // 보조공정(배지)은 완료 판단에서 제외한다.
  const pours = useMemo(() => {
    const byCycle = new Map<string, ProcessInstance>();
    for (const p of processes) {
      if (PROCESS_TYPE_MAP[p.typeCode]?.category === 'sub') continue;
      const cur = byCycle.get(p.cycleId);
      if (!cur || p.date > cur.date) byCycle.set(p.cycleId, p);
    }
    return [...byCycle.values()];
  }, [processes]);

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
                      {list.map((p) => (
                        <span
                          key={p.id}
                          className="inline-block text-[10px] leading-tight px-1.5 py-0.5 rounded bg-red-100 text-red-700 whitespace-nowrap"
                          title={`${completionLabel(p)} 완료 · ${p.date}`}
                        >
                          {formatMonthDay(p.date)} {completionLabel(p)}
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
