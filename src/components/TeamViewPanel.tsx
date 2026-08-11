'use client';

import { useMemo, useState } from 'react';
import { processLabel } from '@/lib/domain/schedule';
import { Block, CrewTeam, ProcessInstance } from '@/lib/domain/types';

interface TeamViewPanelProps {
  crewTeams: CrewTeam[];
  processes: ProcessInstance[];
  blocks: Block[];
  onClose: () => void;
}

export default function TeamViewPanel({ crewTeams, processes, blocks, onClose }: TeamViewPanelProps) {
  const blockNames = useMemo(() => Object.fromEntries(blocks.map((b) => [b.id, b.name])), [blocks]);
  const [teamFilter, setTeamFilter] = useState('all');

  const assigned = useMemo(
    () =>
      processes
        .filter((p) => p.crew?.team && (teamFilter === 'all' || p.crew.team === teamFilter))
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) || (blockNames[a.blockId] ?? '').localeCompare(blockNames[b.blockId] ?? ''),
        ),
    [processes, teamFilter, blockNames],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, typeof assigned>();
    for (const p of assigned) {
      const team = p.crew!.team;
      if (!map.has(team)) map.set(team, []);
      map.get(team)!.push(p);
    }
    return map;
  }, [assigned]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-2xl max-h-[85vh] overflow-y-auto p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-3xl font-bold">투입인원관리 — 팀별 작업 현황</h2>
          <button className="text-xl px-2 py-1 rounded border border-zinc-300" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="flex items-center gap-2 text-xl">
          <span className="text-zinc-500">팀 선택</span>
          <select
            className="border border-zinc-300 rounded px-2 py-1"
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
          >
            <option value="all">전체</option>
            {crewTeams.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        {grouped.size === 0 && <p className="text-base text-zinc-400">배정된 작업이 없습니다.</p>}
        <div className="flex flex-col gap-4">
          {[...grouped.entries()].map(([team, list]) => (
            <div key={team} className="flex flex-col gap-1">
              <h3 className="text-xl font-semibold text-zinc-700">
                {team} <span className="text-base text-zinc-400">({list.reduce((s, p) => s + (p.crew?.headcount ?? 0), 0)}명 연인원)</span>
              </h3>
              <div className="flex flex-col gap-1">
                {list.map((p) => (
                  <div
                    key={p.id}
                    className="text-base border border-zinc-200 rounded px-2 py-1 flex items-center justify-between"
                  >
                    <span>
                      <strong>{p.date}</strong> · {blockNames[p.blockId] ?? ''} · {processLabel(p)}
                    </span>
                    <span className="text-zinc-500">{p.crew?.headcount}명</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
