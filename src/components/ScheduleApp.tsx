'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import DailyReportModal from '@/components/DailyReportModal';
import GanttChart from '@/components/GanttChart';
import HistoryPanel from '@/components/HistoryPanel';
import SettingsPanel from '@/components/SettingsPanel';
import { addDays, addMonths, diffDays, endOfMonth, ISODate, mondayOfWeek, todayISO } from '@/lib/domain/dateUtils';
import { PROCESS_TYPE_MAP } from '@/lib/domain/processTypes';
import {
  collidingProcesses,
  generateBaseFloorSequence,
  generateFromTemplate,
  generateRepeatingFloors,
  isKnownType,
  moveMainProcess,
  moveSubProcess,
  previewMainMove,
  processLabel,
  recomputeConflicts,
  setCrew,
  shiftAllFrom,
  swapCellOrder,
} from '@/lib/domain/schedule';
import {
  AppState,
  Block,
  ChangeRecord,
  CrewTeam,
  DateShiftRecord,
  DirectLaborEntry,
  Holiday,
  ProcessInstance,
  ProcessTemplate,
  SiteInfo,
} from '@/lib/domain/types';
import { loadState, saveState, SITE_KEY, stableStringify, subscribeState } from '@/lib/supabase/state';

// 이동/순연 사유로 자주 쓰는 항목들 — 직접 입력하는 대신 눌러서 바로 넣을 수 있게 한다.
const REASON_PRESETS = ['우천', '폭염', '폭우', '태풍', '한파', '자재수급 지연', '인력 부족', '민원 발생'];

const INITIAL_BLOCKS: Block[] = [
  { id: 'b1', name: '11동', sortOrder: 1, facilityType: 'building' },
  { id: 'b2', name: '12동', sortOrder: 2, facilityType: 'building' },
  { id: 'b3', name: '13동', sortOrder: 3, facilityType: 'building' },
  { id: 'b4', name: '14동', sortOrder: 4, facilityType: 'building' },
];

function computeDayCount(viewStartDate: ISODate): number {
  // 오늘이 포함된 주의 월요일부터 다음 달 말일까지 기본으로 보여준다.
  return diffDays(viewStartDate, endOfMonth(addMonths(todayISO(), 1))) + 1;
}

function buildInitialProcesses(holidays: Holiday[]): ProcessInstance[] {
  const start = todayISO();
  return INITIAL_BLOCKS.flatMap((block, idx) =>
    generateBaseFloorSequence(block.id, `${16 + idx}F`, addDays(start, idx), holidays),
  );
}

interface PendingDrop {
  processId: string;
  blockId: string;
  date: ISODate;
  kind: 'main' | 'sub';
  collisionCount: number;
}

interface PendingHeaderShift {
  fromDate: ISODate;
  toDate: ISODate;
  deltaDays: number;
}

function Modal({ children, draggable }: { children: React.ReactNode; draggable?: boolean }) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  function handlePointerMove(e: PointerEvent) {
    if (!dragRef.current) return;
    setOffset({ x: dragRef.current.baseX + (e.clientX - dragRef.current.startX), y: dragRef.current.baseY + (e.clientY - dragRef.current.startY) });
  }

  function handlePointerUp() {
    dragRef.current = null;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
  }

  function handlePointerDown(e: React.PointerEvent) {
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div
        className="bg-white rounded-lg shadow-lg p-4 w-full max-w-sm flex flex-col gap-3"
        style={draggable ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined}
      >
        {draggable && (
          <div
            onPointerDown={handlePointerDown}
            className="-mx-4 -mt-4 px-4 py-1.5 rounded-t-lg bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-400 cursor-move select-none"
            title="드래그해서 창 이동"
          >
            ⠿⠿⠿ 드래그해서 이동
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export default function ScheduleApp() {
  const [siteInfo, setSiteInfo] = useState<SiteInfo>({ name: 'OO현장', overview: '' });
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [templates, setTemplates] = useState<ProcessTemplate[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  // 공정/일정 데이터는 Supabase에서 비동기로 불러오므로 마운트 이후(useEffect)에만 채운다.
  // 그래야 서버 렌더링 결과와 클라이언트 첫 렌더링 결과가 항상 동일해 하이드레이션 불일치가 나지 않는다.
  const [processes, setProcesses] = useState<ProcessInstance[]>([]);
  const [changeHistory, setChangeHistory] = useState<ChangeRecord[]>([]);
  const [dateShiftHistory, setDateShiftHistory] = useState<DateShiftRecord[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [directLabor, setDirectLabor] = useState<DirectLaborEntry[]>([]);
  const [crewTeams, setCrewTeams] = useState<CrewTeam[]>([]);
  const [viewStartDate, setViewStartDate] = useState<ISODate>(() => mondayOfWeek(todayISO()));
  // 오늘이 포함된 주의 월요일부터 다음 달 말일까지를 기본 범위로 고정 (이후 이전주/다음주로 더 이동 가능)
  const [dayCount] = useState<number>(() => computeDayCount(mondayOfWeek(todayISO())));

  const [loaded, setLoaded] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const lastSyncedJsonRef = useRef<string>('');
  // 실시간 이벤트는 네트워크 사정으로 순서가 뒤바뀌어 도착할 수 있다 (특히 저장이 여러 번
  // 빠르게 겹칠 때). 내용 비교만으로는 "오래된 이벤트가 방금 반영한 내용을 다시 덮어쓰는"
  // 것을 막을 수 없어서, DB의 updated_at 시각을 기준으로 이보다 오래된 이벤트는 무시한다.
  const lastAppliedAtRef = useRef<string>('');

  // DB의 예전 데이터는 그 이후 추가된 필드(directLabor 등)가 아예 없을 수 있다.
  // 매번 이 함수를 거쳐서 기본값을 채운 "정규화된" 상태만 다루면, 로컬 상태와 마지막으로
  // 동기화한 문자열이 항상 같은 모양이 되어 필드 유무 차이로 인한 무한 저장 루프를 막는다.
  function normalizeAppState(remote: AppState): AppState {
    return {
      ...remote,
      directLabor: (remote.directLabor ?? []).map((d) => ({ ...d, category: d.category ?? '기타' })),
      crewTeams: remote.crewTeams ?? [],
    };
  }

  function applyRemoteState(remote: AppState) {
    const state = normalizeAppState(remote);
    setSiteInfo(state.siteInfo);
    setBlocks(state.blocks);
    setTemplates(state.templates);
    setHolidays(state.holidays);
    setProcesses(state.processes);
    setChangeHistory(state.changeHistory);
    setDateShiftHistory(state.dateShiftHistory);
    setNotes(state.notes);
    setDirectLabor(state.directLabor);
    setCrewTeams(state.crewTeams);
  }

  // 최초 로드: Supabase에 저장된 데이터가 있으면 불러오고, 없으면(첫 실행) 샘플 데이터를 만들어 저장한다.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loadedRow = await loadState(SITE_KEY);
        if (cancelled) return;
        if (loadedRow) {
          applyRemoteState(loadedRow.state);
          lastSyncedJsonRef.current = stableStringify(normalizeAppState(loadedRow.state));
          lastAppliedAtRef.current = loadedRow.updatedAt;
          setLastSavedAt(loadedRow.updatedAt);
        } else {
          const initialHolidays: Holiday[] = [{ date: addDays(todayISO(), 12), kind: 'public_holiday' }];
          const initial: AppState = {
            siteInfo: { name: 'OO현장', overview: '' },
            blocks: INITIAL_BLOCKS,
            templates: [],
            holidays: initialHolidays,
            processes: recomputeConflicts(buildInitialProcesses(initialHolidays)),
            changeHistory: [],
            dateShiftHistory: [],
            notes: {},
            directLabor: [],
            crewTeams: [],
          };
          applyRemoteState(initial);
          const updatedAt = await saveState(SITE_KEY, initial);
          lastSyncedJsonRef.current = stableStringify(initial);
          lastAppliedAtRef.current = updatedAt;
          setLastSavedAt(updatedAt);
        }
      } catch (e) {
        setSyncError(e instanceof Error ? e.message : 'Supabase 연결에 실패했습니다.');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 다른 사용자가 저장한 변경사항을 실시간으로 받아온다. updated_at이 우리가 마지막으로
  // 반영/저장한 시각보다 오래된 이벤트(지연 도착한 echo 포함)는 무시한다.
  useEffect(() => {
    const unsubscribe = subscribeState(SITE_KEY, (remote, updatedAt) => {
      if (updatedAt <= lastAppliedAtRef.current) return;
      lastAppliedAtRef.current = updatedAt;
      lastSyncedJsonRef.current = stableStringify(normalizeAppState(remote));
      applyRemoteState(remote);
      setLastSavedAt(updatedAt);
    });
    return unsubscribe;
  }, []);

  // 저장 요청을 한 번에 하나씩만 순서대로 내보낸다. debounce만 걸면 저장이 겹칠 때
  // 네트워크 도착 순서가 뒤바뀌어 최신 내용이 이전 내용에 덮어써질 수 있다.
  const savingRef = useRef(false);
  const pendingStateRef = useRef<AppState | null>(null);

  async function flushPendingSave() {
    if (savingRef.current) return;
    savingRef.current = true;
    while (pendingStateRef.current) {
      const toSave = pendingStateRef.current;
      pendingStateRef.current = null;
      lastSyncedJsonRef.current = stableStringify(toSave);
      try {
        const updatedAt = await saveState(SITE_KEY, toSave);
        lastAppliedAtRef.current = updatedAt;
        setLastSavedAt(updatedAt);
      } catch (e) {
        setSyncError(e instanceof Error ? e.message : 'Supabase 저장에 실패했습니다.');
      }
    }
    savingRef.current = false;
  }

  // 로컬 상태가 바뀌면 잠시 후 Supabase에 반영한다 (짧은 debounce로 타이핑 중 과도한 저장 방지).
  useEffect(() => {
    if (!loaded) return;
    const state: AppState = {
      siteInfo,
      blocks,
      templates,
      holidays,
      processes,
      changeHistory,
      dateShiftHistory,
      notes,
      directLabor,
      crewTeams,
    };
    const json = stableStringify(state);
    if (json === lastSyncedJsonRef.current) return;
    const handle = setTimeout(() => {
      pendingStateRef.current = state;
      flushPendingSave();
    }, 500);
    return () => clearTimeout(handle);
  }, [loaded, siteInfo, blocks, templates, holidays, processes, changeHistory, dateShiftHistory, notes, directLabor, crewTeams]);

  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [genFloorForm, setGenFloorForm] = useState<{ blockId: string; floor: string; startDate: ISODate; templateId: string } | null>(
    null,
  );

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [noteModal, setNoteModal] = useState<{ blockId: string; date: ISODate } | null>(null);
  const [reasonPopup, setReasonPopup] = useState<{ label: string; reason: string; path?: string } | null>(null);
  const [crewModal, setCrewModal] = useState<{ processId: string; team: string; headcount: string } | null>(null);
  const [reportDate, setReportDate] = useState<ISODate | null>(null);
  const [dateChoice, setDateChoice] = useState<ISODate | null>(null);
  const [postponePrompt, setPostponePrompt] = useState<{ date: ISODate; days: string } | null>(null);

  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);
  const [dropStage, setDropStage] = useState<'idle' | 'threeplus-picker' | 'reason'>('idle');
  const [reasonInput, setReasonInput] = useState('');

  const [pendingHeaderShift, setPendingHeaderShift] = useState<PendingHeaderShift | null>(null);
  const [headerShiftStage, setHeaderShiftStage] = useState<'idle' | 'confirm' | 'reason'>('idle');
  const [headerReasonInput, setHeaderReasonInput] = useState('');

  const selectedProcess = useMemo(
    () => processes.find((p) => p.id === selectedProcessId) ?? null,
    [processes, selectedProcessId],
  );
  const blockNames = useMemo(() => Object.fromEntries(blocks.map((b) => [b.id, b.name])), [blocks]);

  function handleSelectProcess(id: string) {
    setWarning(null);
    setSelectedProcessId((cur) => (cur === id ? null : id));
  }

  function resetDropFlow() {
    setPendingDrop(null);
    setDropStage('idle');
    setReasonInput('');
  }

  function handleDropProcess(processId: string, blockId: string, date: ISODate) {
    const proc = processes.find((p) => p.id === processId);
    if (!proc) return;
    if (blockId !== proc.blockId) {
      setWarning('주요공정/보조공정은 같은 행(동)에서 좌우로만 이동할 수 있습니다.');
      return;
    }
    if (date === proc.date) return;

    const def = PROCESS_TYPE_MAP[proc.typeCode];
    const category = def?.category ?? (isKnownType(proc.typeCode) ? 'sub' : 'main');
    setWarning(null);

    if (category === 'sub') {
      setPendingDrop({ processId, blockId, date, kind: 'sub', collisionCount: 0 });
      setDropStage('reason');
      return;
    }

    // 지상층 엔진의 주요공정만 불변규칙 검증 대상. 커스텀 템플릿 공정은 자유 이동.
    if (!isKnownType(proc.typeCode)) {
      setPendingDrop({ processId, blockId, date, kind: 'sub', collisionCount: 0 });
      setDropStage('reason');
      return;
    }

    const preview = previewMainMove(processes, processId, date);
    if (preview.blockedReason) {
      setWarning(preview.blockedReason);
      return;
    }
    setPendingDrop({ processId, blockId, date, kind: 'main', collisionCount: preview.collisionCount });
    setDropStage(preview.collisionCount >= 2 ? 'threeplus-picker' : 'reason');
  }

  function handleChangeNote(blockId: string, date: ISODate, text: string) {
    setNotes((cur) => ({ ...cur, [`${blockId}__${date}`]: text }));
  }

  function handleOpenCrew(processId: string) {
    const proc = processes.find((p) => p.id === processId);
    const currentTeam = proc?.crew?.team;
    const team = currentTeam && crewTeams.some((t) => t.name === currentTeam) ? currentTeam : crewTeams[0]?.name ?? '';
    setCrewModal({ processId, team, headcount: proc?.crew ? String(proc.crew.headcount) : '' });
  }

  function handleSaveCrew() {
    if (!crewModal) return;
    const count = Number(crewModal.headcount) || 0;
    setProcesses((cur) => setCrew(cur, crewModal.processId, crewModal.team, count));
    setCrewModal(null);
  }

  function handleAddCrewTeam(name: string) {
    setCrewTeams((cur) => [...cur, { id: crypto.randomUUID(), name }]);
  }

  function handleRemoveCrewTeam(id: string) {
    setCrewTeams((cur) => cur.filter((t) => t.id !== id));
  }

  function handleChangeBlockRemark(blockId: string, text: string) {
    setBlocks((cur) => cur.map((b) => (b.id === blockId ? { ...b, remark: text } : b)));
  }

  // 동을 지우면 그 동에 딸린 공정/이동이력/직영작업까지 같이 지운다. 그냥 blocks에서만
  // 빼면 processes에 그 blockId를 가진 "유령" 공정이 남아 충돌 집계 등을 조용히 틀어지게 한다.
  function handleRemoveBlock(id: string) {
    setBlocks((cur) => cur.filter((b) => b.id !== id));
    const removedProcessIds = new Set(processes.filter((p) => p.blockId === id).map((p) => p.id));
    setProcesses((cur) => cur.filter((p) => p.blockId !== id));
    setChangeHistory((cur) => cur.filter((c) => !removedProcessIds.has(c.processId)));
    setNotes((cur) => {
      const next = { ...cur };
      for (const key of Object.keys(next)) {
        if (key.startsWith(`${id}__`)) delete next[key];
      }
      return next;
    });
  }

  function handleAddDirectLabor(date: ISODate, category: string, workContent: string, headcount: number) {
    const entry: DirectLaborEntry = { id: crypto.randomUUID(), date, category, workContent, headcount };
    setDirectLabor((cur) => [...cur, entry]);
  }

  function handleRemoveDirectLabor(id: string) {
    setDirectLabor((cur) => cur.filter((d) => d.id !== id));
  }

  function proceedAnyway() {
    setDropStage('reason');
  }

  function postponeExisting(existingId: string) {
    resetDropFlow();
    setSelectedProcessId(existingId);
    setWarning('순연할 공정을 선택했습니다. 이제 이 공정을 드래그해서 다른 날짜로 옮겨주세요.');
  }

  function confirmReason(presetReason?: string) {
    if (!pendingDrop) return;
    const reason = (presetReason ?? reasonInput).trim() || '사유 미입력';
    if (pendingDrop.kind === 'main') {
      const result = moveMainProcess(processes, changeHistory, pendingDrop.processId, pendingDrop.date, reason, holidays);
      if (result.blockedReason) {
        setWarning(result.blockedReason);
      } else {
        setProcesses(recomputeConflicts(result.processes));
        setChangeHistory(result.changeHistory);
      }
    } else {
      const proc = processes.find((p) => p.id === pendingDrop.processId);
      const next = moveSubProcess(processes, pendingDrop.processId, pendingDrop.date);
      setProcesses(recomputeConflicts(next));
      if (proc) {
        setChangeHistory((h) => [
          ...h,
          { id: crypto.randomUUID(), processId: pendingDrop.processId, previousDate: proc.date, newDate: pendingDrop.date, reason },
        ]);
      }
    }
    resetDropFlow();
  }

  function handleReorderCellOrder(processId: string, direction: 'up' | 'down') {
    setProcesses((cur) => swapCellOrder(cur, processId, direction));
  }

  function handleDropHeader(fromDate: ISODate, toDate: ISODate) {
    const deltaDays = diffDays(fromDate, toDate);
    if (deltaDays === 0) return;
    setPendingHeaderShift({ fromDate, toDate, deltaDays });
    setHeaderShiftStage('confirm');
  }

  function submitPostponePrompt() {
    if (!postponePrompt) return;
    const days = Number(postponePrompt.days);
    if (!Number.isFinite(days) || days === 0) return;
    handleDropHeader(postponePrompt.date, addDays(postponePrompt.date, days));
    setPostponePrompt(null);
  }

  function confirmHeaderShiftProceed() {
    setHeaderShiftStage('reason');
  }

  function confirmHeaderShiftReason(presetReason?: string) {
    if (!pendingHeaderShift) return;
    const reason = (presetReason ?? headerReasonInput).trim() || '사유 미입력';
    const next = shiftAllFrom(processes, pendingHeaderShift.fromDate, pendingHeaderShift.deltaDays, holidays);
    setProcesses(recomputeConflicts(next));
    setDateShiftHistory((h) => [
      ...h,
      {
        id: crypto.randomUUID(),
        fromDate: pendingHeaderShift.fromDate,
        deltaDays: pendingHeaderShift.deltaDays,
        reason,
        at: new Date().toISOString(),
      },
    ]);
    setPendingHeaderShift(null);
    setHeaderShiftStage('idle');
    setHeaderReasonInput('');
  }

  function submitGenFloor() {
    if (!genFloorForm) return;
    let generated: ProcessInstance[];
    if (genFloorForm.templateId === 'ground') {
      // 기준층은 한 번으로 끝나지 않으니 시작 층부터 해당월 + 익월 말일까지 자동으로
      // 한 층씩 올려가며 반복 생성한다.
      const untilDate = endOfMonth(addMonths(genFloorForm.startDate, 1));
      generated = generateRepeatingFloors(genFloorForm.blockId, genFloorForm.floor, genFloorForm.startDate, holidays, untilDate);
    } else {
      const template = templates.find((t) => t.id === genFloorForm.templateId);
      if (!template) return;
      generated = generateFromTemplate(template, genFloorForm.blockId, genFloorForm.startDate);
    }
    setProcesses((cur) => recomputeConflicts([...cur, ...generated]));
    setGenFloorForm(null);
  }

  const pendingProcess = pendingDrop ? processes.find((p) => p.id === pendingDrop.processId) : null;
  const collidingList =
    pendingDrop && pendingProcess ? collidingProcesses(processes, pendingProcess, pendingDrop.date) : [];

  return (
    <div className="min-h-screen bg-zinc-50 p-6 flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{siteInfo.name} — 전체 공정표</h1>
          {siteInfo.overview && <p className="text-xs text-zinc-500 mt-0.5">{siteInfo.overview}</p>}
          {!loaded && !syncError && <p className="text-xs text-zinc-400 mt-0.5">불러오는 중…</p>}
          {syncError && <p className="text-xs text-red-600 mt-0.5">동기화 오류: {syncError}</p>}
        </div>
        <div className="flex gap-2 text-sm">
          <button
            className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100"
            onClick={() => setViewStartDate((d) => addDays(d, -7))}
          >
            이전 주
          </button>
          <button
            className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100"
            onClick={() => setViewStartDate(mondayOfWeek(todayISO()))}
          >
            오늘
          </button>
          <button
            className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100"
            onClick={() => setViewStartDate((d) => addDays(d, 7))}
          >
            다음 주
          </button>
          <button
            className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100 disabled:opacity-40"
            onClick={() =>
              setGenFloorForm({ blockId: blocks[0]?.id ?? '', floor: '16F', startDate: todayISO(), templateId: 'ground' })
            }
            disabled={blocks.length === 0}
          >
            공정 생성
          </button>
          <button
            className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100"
            onClick={() => setHistoryOpen(true)}
          >
            변경이력
          </button>
          <button
            className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100"
            onClick={() => setSettingsOpen(true)}
          >
            설정
          </button>
        </div>
      </header>

      <div className="min-h-[36px] flex items-center gap-2 text-sm" data-testid="action-bar">
        {warning && (
          <span className="text-red-600" data-testid="warning">
            {warning}
          </span>
        )}

        {!warning && selectedProcess && (
          <>
            <span>
              선택됨: <strong>{blockNames[selectedProcess.blockId] ?? ''}</strong> {processLabel(selectedProcess)} (
              {selectedProcess.date})
            </span>
            <button className="px-3 py-1 rounded border border-zinc-300" onClick={() => setSelectedProcessId(null)}>
              선택 취소
            </button>
            <button
              className="px-3 py-1 rounded border border-zinc-300"
              onClick={() =>
                setGenFloorForm({ blockId: selectedProcess.blockId, floor: '16F', startDate: selectedProcess.date, templateId: 'ground' })
              }
            >
              이 동에 기준층 생성
            </button>
          </>
        )}

        {!warning && !selectedProcess && (
          <span className="text-zinc-400">공정 칩을 드래그해서 같은 행의 다른 날짜로, 날짜 헤더를 드래그해서 전체 일정을 옮기세요.</span>
        )}
      </div>

      {genFloorForm && (
        <div className="flex items-center gap-2 text-sm border border-zinc-300 bg-white rounded p-2 flex-wrap">
          <span>기준층 생성 — 동:</span>
          <select
            className="border border-zinc-300 rounded px-2 py-1"
            value={genFloorForm.blockId}
            onChange={(e) => setGenFloorForm((cur) => (cur ? { ...cur, blockId: e.target.value } : cur))}
          >
            {blocks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <span>템플릿:</span>
          <select
            className="border border-zinc-300 rounded px-2 py-1"
            value={genFloorForm.templateId}
            onChange={(e) => setGenFloorForm((cur) => (cur ? { ...cur, templateId: e.target.value } : cur))}
          >
            <option value="ground">지상층 기본 (갱폼~타설)</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {genFloorForm.templateId === 'ground' && (
            <>
              <span>층:</span>
              <input
                className="border border-zinc-300 rounded px-2 py-1 w-20"
                value={genFloorForm.floor}
                onChange={(e) => setGenFloorForm((cur) => (cur ? { ...cur, floor: e.target.value } : cur))}
              />
            </>
          )}
          <span>시작일:</span>
          <input
            type="date"
            className="border border-zinc-300 rounded px-2 py-1"
            value={genFloorForm.startDate}
            onChange={(e) => setGenFloorForm((cur) => (cur ? { ...cur, startDate: e.target.value } : cur))}
          />
          <button className="px-3 py-1 rounded bg-indigo-600 text-white" onClick={submitGenFloor}>
            생성
          </button>
          <button className="px-3 py-1 rounded border border-zinc-300" onClick={() => setGenFloorForm(null)}>
            취소
          </button>
        </div>
      )}

      <GanttChart
        blocks={blocks}
        processes={processes}
        holidays={holidays}
        changeHistory={changeHistory}
        notes={notes}
        onChangeNote={handleChangeNote}
        onOpenNote={(blockId, date) => setNoteModal({ blockId, date })}
        onShowReason={(label, reason, path) => setReasonPopup({ label, reason, path })}
        onEditCrew={handleOpenCrew}
        onChangeBlockRemark={handleChangeBlockRemark}
        onClickHeaderDate={(date) => setDateChoice(date)}
        viewStartDate={viewStartDate}
        dayCount={dayCount}
        selectedProcessId={selectedProcessId}
        onSelectProcess={handleSelectProcess}
        onDropProcess={handleDropProcess}
        onDropHeader={handleDropHeader}
        onReorderCellOrder={handleReorderCellOrder}
      />

      <p className="text-xs text-zinc-500">
        공정 칩을 같은 행의 다른 날짜 셀로 드래그하면 이동합니다. 날짜 헤더를 클릭하면 작업일보 보기/전체 일정
        순연을 선택할 수 있고, 드래그하면 바로 그 날짜 이후 모든 동의 일정이 함께 순연됩니다.
      </p>

      {dropStage === 'threeplus-picker' && pendingDrop && pendingProcess && (
        <Modal draggable>
          <p className="text-sm">
            {pendingDrop.date}에 같은 공정이 이미 {collidingList.length}개 있어 총 {collidingList.length + 1}개가 됩니다.
            3개 이상의 공정이 있습니다. 그냥 진행할까요? 아니면 어느 공정을 순연할까요?
          </p>
          <div className="flex flex-col gap-1 text-sm">
            {collidingList.map((p) => (
              <div key={p.id} className="flex items-center justify-between border border-zinc-200 rounded px-2 py-1">
                <span>
                  <strong>{blockNames[p.blockId] ?? ''}</strong>{' '}
                  {p.cellOrder ? `${p.cellOrder}번 ` : ''}
                  {processLabel(p)}
                </span>
                <button className="text-xs px-2 py-1 rounded border border-zinc-300" onClick={() => postponeExisting(p.id)}>
                  이 공정 순연
                </button>
              </div>
            ))}
            <div className="flex items-center justify-between border border-indigo-200 rounded px-2 py-1 bg-indigo-50">
              <span>(새로 이동해온) {processLabel(pendingProcess)}</span>
              <button className="text-xs px-2 py-1 rounded border border-zinc-300" onClick={() => postponeExisting(pendingProcess.id)}>
                이 공정 순연
              </button>
            </div>
          </div>
          <div className="flex justify-end gap-2 text-sm">
            <button className="px-3 py-1 rounded border border-zinc-300" onClick={resetDropFlow}>
              취소
            </button>
            <button className="px-3 py-1 rounded bg-indigo-600 text-white" onClick={proceedAnyway}>
              그냥 진행
            </button>
          </div>
        </Modal>
      )}

      {dropStage === 'reason' && pendingDrop && pendingProcess && (
        <Modal>
          <p className="text-sm">
            <strong>{blockNames[pendingDrop.blockId]}</strong> {processLabel(pendingProcess)} ({pendingProcess.date}) →{' '}
            {pendingDrop.date}로 이동
          </p>
          <input
            autoFocus
            className="border border-zinc-300 rounded px-2 py-1 text-sm"
            value={reasonInput}
            onChange={(e) => setReasonInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmReason();
            }}
            placeholder="이동 사유를 간단히 적어주세요 (예: 우천으로 순연)"
            data-testid="reason-input"
          />
          <div className="flex flex-wrap gap-1">
            {REASON_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className="text-xs px-2 py-1 rounded-full border border-zinc-300 bg-zinc-50 hover:bg-zinc-100"
                onClick={() => confirmReason(preset)}
                data-testid="reason-preset"
              >
                {preset}
              </button>
            ))}
          </div>
          <div className="flex justify-end gap-2 text-sm">
            <button className="px-3 py-1 rounded border border-zinc-300" onClick={resetDropFlow}>
              취소
            </button>
            <button className="px-3 py-1 rounded bg-indigo-600 text-white" onClick={() => confirmReason()} data-testid="confirm-move">
              확인
            </button>
          </div>
        </Modal>
      )}

      {headerShiftStage === 'confirm' && pendingHeaderShift && (
        <Modal>
          <p className="text-sm">
            {pendingHeaderShift.fromDate} 이후 모든 동의 전체 일정을{' '}
            {Math.abs(pendingHeaderShift.deltaDays)}일 {pendingHeaderShift.deltaDays > 0 ? '미룰까요' : '당길까요'}?
          </p>
          <div className="flex justify-end gap-2 text-sm">
            <button
              className="px-3 py-1 rounded border border-zinc-300"
              onClick={() => {
                setPendingHeaderShift(null);
                setHeaderShiftStage('idle');
              }}
            >
              취소
            </button>
            <button className="px-3 py-1 rounded bg-indigo-600 text-white" onClick={confirmHeaderShiftProceed}>
              확인
            </button>
          </div>
        </Modal>
      )}

      {headerShiftStage === 'reason' && pendingHeaderShift && (
        <Modal>
          <p className="text-sm">전체 일정 순연 사유</p>
          <input
            autoFocus
            className="border border-zinc-300 rounded px-2 py-1 text-sm"
            value={headerReasonInput}
            onChange={(e) => setHeaderReasonInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmHeaderShiftReason();
            }}
            placeholder="예: 우천·태풍으로 전체 순연"
          />
          <div className="flex flex-wrap gap-1">
            {REASON_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className="text-xs px-2 py-1 rounded-full border border-zinc-300 bg-zinc-50 hover:bg-zinc-100"
                onClick={() => confirmHeaderShiftReason(preset)}
              >
                {preset}
              </button>
            ))}
          </div>
          <div className="flex justify-end gap-2 text-sm">
            <button
              className="px-3 py-1 rounded border border-zinc-300"
              onClick={() => {
                setPendingHeaderShift(null);
                setHeaderShiftStage('idle');
                setHeaderReasonInput('');
              }}
            >
              취소
            </button>
            <button className="px-3 py-1 rounded bg-indigo-600 text-white" onClick={() => confirmHeaderShiftReason()}>
              확인
            </button>
          </div>
        </Modal>
      )}

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          siteInfo={siteInfo}
          onChangeSiteInfo={setSiteInfo}
          blocks={blocks}
          onAddBlock={(name, facilityType, info) =>
            setBlocks((cur) => [
              ...cur,
              { id: crypto.randomUUID(), name, sortOrder: cur.length + 1, facilityType, info: info || undefined },
            ])
          }
          onRemoveBlock={handleRemoveBlock}
          onChangeBlockType={(id, facilityType) =>
            setBlocks((cur) => cur.map((b) => (b.id === id ? { ...b, facilityType } : b)))
          }
          onChangeBlockInfo={(id, info) => setBlocks((cur) => cur.map((b) => (b.id === id ? { ...b, info } : b)))}
          templates={templates}
          onAddTemplate={(t) => setTemplates((cur) => [...cur, t])}
          onRemoveTemplate={(id) => setTemplates((cur) => cur.filter((t) => t.id !== id))}
          crewTeams={crewTeams}
          onAddCrewTeam={handleAddCrewTeam}
          onRemoveCrewTeam={handleRemoveCrewTeam}
          lastSavedAt={lastSavedAt}
          syncError={syncError}
        />
      )}

      {historyOpen && (
        <HistoryPanel
          onClose={() => setHistoryOpen(false)}
          changeHistory={changeHistory}
          dateShiftHistory={dateShiftHistory}
          processes={processes}
          blocks={blocks}
        />
      )}

      {noteModal && (
        <Modal>
          <p className="text-sm">
            <strong>{blockNames[noteModal.blockId] ?? ''}</strong> {noteModal.date} 특이사항
          </p>
          <textarea
            autoFocus
            className="border border-zinc-300 rounded px-2 py-1 text-sm min-h-[120px]"
            value={notes[`${noteModal.blockId}__${noteModal.date}`] ?? ''}
            onChange={(e) => handleChangeNote(noteModal.blockId, noteModal.date, e.target.value)}
            placeholder="특이사항을 입력하세요"
          />
          <div className="flex justify-end text-sm">
            <button className="px-3 py-1 rounded bg-indigo-600 text-white" onClick={() => setNoteModal(null)}>
              닫기
            </button>
          </div>
        </Modal>
      )}

      {reasonPopup && (
        <Modal>
          <p className="text-sm">
            <strong>{reasonPopup.label}</strong> 이동 사유
          </p>
          <p className="text-sm text-zinc-600">{reasonPopup.reason}</p>
          {reasonPopup.path && (
            <p className="text-xs text-zinc-500">
              이동 경로: <span className="font-mono">{reasonPopup.path}</span>
            </p>
          )}
          <div className="flex justify-end text-sm">
            <button className="px-3 py-1 rounded border border-zinc-300" onClick={() => setReasonPopup(null)}>
              닫기
            </button>
          </div>
        </Modal>
      )}

      {crewModal && (
        <Modal>
          <p className="text-sm">작업팀 · 투입인원</p>
          {crewTeams.length === 0 ? (
            <p className="text-xs text-zinc-500">
              등록된 작업팀이 없습니다. 설정 → 작업팀 관리에서 먼저 팀을 등록해주세요.
            </p>
          ) : (
            <select
              autoFocus
              className="border border-zinc-300 rounded px-2 py-1 text-sm"
              value={crewModal.team}
              onChange={(e) => setCrewModal((cur) => (cur ? { ...cur, team: e.target.value } : cur))}
            >
              {crewTeams.map((t) => (
                <option key={t.id} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
          <input
            className="border border-zinc-300 rounded px-2 py-1 text-sm"
            value={crewModal.headcount}
            onChange={(e) => setCrewModal((cur) => (cur ? { ...cur, headcount: e.target.value } : cur))}
            placeholder="투입인원"
            type="number"
            min="0"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveCrew();
            }}
          />
          <div className="flex justify-end gap-2 text-sm">
            <button className="px-3 py-1 rounded border border-zinc-300" onClick={() => setCrewModal(null)}>
              취소
            </button>
            <button
              className="px-3 py-1 rounded bg-indigo-600 text-white disabled:opacity-40"
              onClick={handleSaveCrew}
              disabled={crewTeams.length === 0}
            >
              저장
            </button>
          </div>
        </Modal>
      )}

      {dateChoice && (
        <Modal>
          <p className="text-sm">
            <strong>{dateChoice}</strong> 무엇을 하시겠습니까?
          </p>
          <div className="flex flex-col gap-2 text-sm">
            <button
              className="px-3 py-2 rounded border border-zinc-300 text-left"
              onClick={() => {
                setReportDate(dateChoice);
                setDateChoice(null);
              }}
            >
              작업일보 보기
            </button>
            <button
              className="px-3 py-2 rounded border border-zinc-300 text-left"
              onClick={() => {
                setPostponePrompt({ date: dateChoice, days: '1' });
                setDateChoice(null);
              }}
            >
              전체 일정 순연
            </button>
          </div>
          <div className="flex justify-end text-sm">
            <button className="px-3 py-1 rounded border border-zinc-300" onClick={() => setDateChoice(null)}>
              취소
            </button>
          </div>
        </Modal>
      )}

      {postponePrompt && (
        <Modal>
          <p className="text-sm">
            <strong>{postponePrompt.date}</strong> 이후 전체 일정을 며칠 순연하시겠습니까? (당기려면 음수 입력)
          </p>
          <input
            autoFocus
            type="number"
            className="border border-zinc-300 rounded px-2 py-1 text-sm"
            value={postponePrompt.days}
            onChange={(e) => setPostponePrompt((cur) => (cur ? { ...cur, days: e.target.value } : cur))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPostponePrompt();
            }}
          />
          <div className="flex justify-end gap-2 text-sm">
            <button className="px-3 py-1 rounded border border-zinc-300" onClick={() => setPostponePrompt(null)}>
              취소
            </button>
            <button className="px-3 py-1 rounded bg-indigo-600 text-white" onClick={submitPostponePrompt}>
              확인
            </button>
          </div>
        </Modal>
      )}

      {reportDate && (
        <DailyReportModal
          date={reportDate}
          siteInfo={siteInfo}
          blocks={blocks}
          processes={processes}
          directLabor={directLabor}
          notes={notes}
          onAddDirectLabor={handleAddDirectLabor}
          onRemoveDirectLabor={handleRemoveDirectLabor}
          onClose={() => setReportDate(null)}
        />
      )}
    </div>
  );
}
