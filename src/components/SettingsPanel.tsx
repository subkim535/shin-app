'use client';

import { useState } from 'react';
import { ISODate } from '@/lib/domain/dateUtils';
import { Block, CrewTeam, Holiday, HolidayKind, SiteInfo } from '@/lib/domain/types';

const HOLIDAY_KIND_LABEL: Record<HolidayKind, string> = {
  sunday: '일요일',
  public_holiday: '공휴일',
  substitute_holiday: '대체휴일',
  temporary_holiday: '임시공휴일',
  vacation: '휴가',
  site_shutdown: '현장 셧다운',
};

interface SettingsPanelProps {
  onClose: () => void;
  siteInfo: SiteInfo;
  onChangeSiteInfo: (info: SiteInfo) => void;
  blocks: Block[];
  onAddBlock: (name: string, info: string) => void;
  onRemoveBlock: (id: string) => void;
  onReorderBlock: (id: string, direction: 'up' | 'down') => void;
  onChangeBlockInfo: (id: string, info: string) => void;
  crewTeams: CrewTeam[];
  onAddCrewTeam: (name: string) => void;
  onRemoveCrewTeam: (id: string) => void;
  holidays: Holiday[];
  onAddHoliday: (date: ISODate, kind: HolidayKind, label?: string) => void;
  onRemoveHoliday: (date: ISODate) => void;
  onAddKoreanHolidays: (year: number) => number;
  koreanHolidayYears: number[];
  processGapDays: number;
  onChangeProcessGapDays: (days: number) => void;
  lastSavedAt: string | null;
  syncError: string | null;
}

export default function SettingsPanel({
  onClose,
  siteInfo,
  onChangeSiteInfo,
  blocks,
  onAddBlock,
  onRemoveBlock,
  onReorderBlock,
  onChangeBlockInfo,
  crewTeams,
  onAddCrewTeam,
  onRemoveCrewTeam,
  holidays,
  onAddHoliday,
  onRemoveHoliday,
  onAddKoreanHolidays,
  koreanHolidayYears,
  processGapDays,
  onChangeProcessGapDays,
  lastSavedAt,
  syncError,
}: SettingsPanelProps) {
  const [newBlockName, setNewBlockName] = useState('');
  const [newBlockInfo, setNewBlockInfo] = useState('');

  const [newTeamName, setNewTeamName] = useState('');

  function addTeam() {
    const name = newTeamName.trim();
    if (!name) return;
    onAddCrewTeam(name);
    setNewTeamName('');
  }

  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayKind, setNewHolidayKind] = useState<HolidayKind>('public_holiday');
  const [newHolidayLabel, setNewHolidayLabel] = useState('');

  const [krYear, setKrYear] = useState(() => koreanHolidayYears[Math.floor(koreanHolidayYears.length / 2)] ?? new Date().getFullYear());
  const [krMsg, setKrMsg] = useState<string | null>(null);
  function loadKoreanHolidays() {
    const added = onAddKoreanHolidays(krYear);
    setKrMsg(added > 0 ? `${krYear}년 공휴일 ${added}개를 등록/갱신했어요(이름 포함).` : `${krYear}년 공휴일은 이미 다 등록돼 있어요.`);
  }

  function addHoliday() {
    if (!newHolidayDate) return;
    onAddHoliday(newHolidayDate, newHolidayKind, newHolidayLabel);
    setNewHolidayDate('');
    setNewHolidayLabel('');
  }

  function addBlock() {
    const name = newBlockName.trim();
    if (!name) return;
    onAddBlock(name, newBlockInfo.trim());
    setNewBlockName('');
    setNewBlockInfo('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-lg max-h-[85vh] overflow-y-auto p-4 flex flex-col gap-5">
        <div className="sticky -top-4 -mx-4 -mt-4 px-4 pt-4 pb-2 bg-white z-10 flex items-center justify-between border-b border-zinc-100">
          <h2 className="text-lg font-semibold">설정</h2>
          <button className="text-sm px-2 py-1 rounded border border-zinc-300" onClick={onClose}>
            닫기
          </button>
        </div>

        <div className="text-xs -mt-3" data-testid="save-status">
          {syncError ? (
            <span className="text-red-600">동기화 오류: {syncError}</span>
          ) : lastSavedAt ? (
            <span className="text-emerald-600">
              ✓ 저장됨 · {new Date(lastSavedAt).toLocaleTimeString('ko-KR')}
            </span>
          ) : (
            <span className="text-zinc-400">저장 중…</span>
          )}
          <span className="text-zinc-400"> — 여기 있는 모든 변경사항은 따로 저장 버튼 없이 자동으로 저장됩니다.</span>
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-zinc-700">공사 개요</h3>
          <label className="text-xs text-zinc-500">현장명</label>
          <input
            className="border border-zinc-300 rounded px-2 py-1 text-sm"
            value={siteInfo.name}
            onChange={(e) => onChangeSiteInfo({ ...siteInfo, name: e.target.value })}
            placeholder="예: OO 신축공사 현장"
          />
          <label className="text-xs text-zinc-500">공사개요</label>
          <textarea
            className="border border-zinc-300 rounded px-2 py-1 text-sm min-h-[64px]"
            value={siteInfo.overview}
            onChange={(e) => onChangeSiteInfo({ ...siteInfo, overview: e.target.value })}
            placeholder="예: 지하 2층 지상 20층 공동주택, 총 8개동"
          />
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-zinc-700">동/구간 관리</h3>
          <div className="flex flex-col gap-1">
            {blocks.map((b, idx) => (
              <div key={b.id} className="flex items-center gap-2 text-sm">
                <span className="flex flex-col shrink-0 -my-1">
                  <button
                    className="text-[9px] leading-none px-0.5 disabled:opacity-30"
                    onClick={() => onReorderBlock(b.id, 'up')}
                    disabled={idx === 0}
                    title="위로 이동"
                  >
                    ▲
                  </button>
                  <button
                    className="text-[9px] leading-none px-0.5 disabled:opacity-30"
                    onClick={() => onReorderBlock(b.id, 'down')}
                    disabled={idx === blocks.length - 1}
                    title="아래로 이동"
                  >
                    ▼
                  </button>
                </span>
                <span className="w-14 shrink-0">{b.name}</span>
                <input
                  className="border border-zinc-300 rounded px-2 py-0.5 text-xs flex-1"
                  value={b.info ?? ''}
                  onChange={(e) => onChangeBlockInfo(b.id, e.target.value)}
                  placeholder="세대/층수 (예: 5세대/22층)"
                />
                <button className="text-xs text-red-600" onClick={() => onRemoveBlock(b.id)}>
                  삭제
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <input
              className="border border-zinc-300 rounded px-2 py-1 text-sm flex-1"
              value={newBlockName}
              onChange={(e) => setNewBlockName(e.target.value)}
              placeholder="예: 15동 또는 관리동"
            />
            <input
              className="border border-zinc-300 rounded px-2 py-1 text-sm w-36"
              value={newBlockInfo}
              onChange={(e) => setNewBlockInfo(e.target.value)}
              placeholder="세대/층수 (선택)"
            />
            <button className="px-3 py-1 rounded bg-indigo-600 text-white text-sm" onClick={addBlock}>
              추가
            </button>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-zinc-700">작업팀 관리</h3>
          <p className="text-xs text-zinc-500">
            여기서 미리 등록해두면, 공정에 작업팀을 배정할 때 직접 입력하지 않고 목록에서 고를 수 있습니다.
          </p>
          <div className="flex flex-col gap-1">
            {crewTeams.map((t) => (
              <div key={t.id} className="flex items-center gap-2 text-sm border border-zinc-200 rounded px-2 py-1">
                <span className="flex-1">{t.name}</span>
                <button className="text-xs text-red-600" onClick={() => onRemoveCrewTeam(t.id)}>
                  삭제
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              className="border border-zinc-300 rounded px-2 py-1 text-sm flex-1"
              value={newTeamName}
              onChange={(e) => setNewTeamName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addTeam();
              }}
              placeholder="예: 형틀목공팀"
            />
            <button className="px-3 py-1 rounded bg-indigo-600 text-white text-sm" onClick={addTeam}>
              추가
            </button>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-zinc-700">휴일 관리</h3>
          <p className="text-xs text-zinc-500">
            공휴일·대체휴일·임시공휴일·휴가를 등록하면 타설(토·일·공휴일 금지), 갱폼(일·공휴일 금지) 등 휴일 규칙에
            자동 반영됩니다. 휴가는 회사에서 지정한 휴무일을 공휴일과 같은 방식으로 반영할 때 사용합니다.
          </p>

          <div className="rounded border border-indigo-200 bg-indigo-50/50 p-2 flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-indigo-800">한국 공휴일 한 번에 등록</span>
              <select
                className="border border-zinc-300 rounded px-2 py-1 text-xs ml-auto"
                value={krYear}
                onChange={(e) => setKrYear(Number(e.target.value))}
              >
                {koreanHolidayYears.map((y) => (
                  <option key={y} value={y}>
                    {y}년
                  </option>
                ))}
              </select>
              <button className="px-3 py-1 rounded bg-indigo-600 text-white text-xs" onClick={loadKoreanHolidays}>
                불러오기
              </button>
            </div>
            <p className="text-[11px] text-zinc-500 leading-snug">
              신정·삼일절·어린이날·현충일·광복절·개천절·한글날·크리스마스와 설날·추석·부처님오신날·대체휴일을 한꺼번에
              넣어요. ⚠️ 설날·추석·대체휴일은 음력이라 해마다 달라지니, 등록 후 실제 달력과 한번 맞춰보세요.
            </p>
            {krMsg && <p className="text-[11px] text-emerald-700">{krMsg}</p>}
          </div>

          <div className="flex flex-col gap-1">
            {[...holidays]
              .filter((h) => h.kind !== 'sunday')
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((h) => (
                <div key={h.date} className="flex items-center gap-2 text-sm border border-zinc-200 rounded px-2 py-1">
                  <span className="shrink-0 tabular-nums">{h.date}</span>
                  {h.label && <span className="flex-1 truncate text-zinc-700">{h.label}</span>}
                  <span className={`text-xs text-zinc-500 ${h.label ? 'shrink-0' : 'flex-1 text-right'}`}>
                    {HOLIDAY_KIND_LABEL[h.kind]}
                  </span>
                  <button className="text-xs text-red-600 shrink-0" onClick={() => onRemoveHoliday(h.date)}>
                    삭제
                  </button>
                </div>
              ))}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              className="border border-zinc-300 rounded px-2 py-1 text-sm shrink-0"
              value={newHolidayDate}
              onChange={(e) => setNewHolidayDate(e.target.value)}
            />
            <input
              type="text"
              className="border border-zinc-300 rounded px-2 py-1 text-sm flex-1 min-w-[100px]"
              value={newHolidayLabel}
              onChange={(e) => setNewHolidayLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addHoliday();
              }}
              placeholder="이름/사유 (예: 신정, 창립일) — 선택"
            />
            <select
              className="border border-zinc-300 rounded px-2 py-1 text-sm shrink-0"
              value={newHolidayKind}
              onChange={(e) => setNewHolidayKind(e.target.value as HolidayKind)}
            >
              <option value="public_holiday">공휴일</option>
              <option value="substitute_holiday">대체휴일</option>
              <option value="temporary_holiday">임시공휴일</option>
              <option value="vacation">휴가</option>
              <option value="site_shutdown">현장 셧다운</option>
            </select>
            <button className="px-3 py-1 rounded bg-indigo-600 text-white text-sm shrink-0" onClick={addHoliday}>
              추가
            </button>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-zinc-700">공종 간 여유일수</h3>
          <p className="text-xs text-zinc-500">
            지상층 기본(갱폼~타설) 공정에서 한 공종이 끝난 다음 다음 공종이 시작되기까지 두는 기본 간격입니다.
            1일이면 바로 다음날부터, 2일이면 하루 더 쉬고 시작합니다. 새로 생성하는 공정과, 앞으로 이동/연장하는
            공정에 적용됩니다.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="1"
              max="14"
              className="border border-zinc-300 rounded px-2 py-1 text-sm w-20"
              value={processGapDays}
              onChange={(e) => onChangeProcessGapDays(Math.min(14, Math.max(1, Number(e.target.value) || 1)))}
            />
            <span className="text-xs text-zinc-500">일</span>
          </div>
        </section>
      </div>
    </div>
  );
}
