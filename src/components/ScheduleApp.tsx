'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import DailyReportModal from '@/components/DailyReportModal';
import GanttChart from '@/components/GanttChart';
import HistoryPanel from '@/components/HistoryPanel';
import OverviewChart from '@/components/OverviewChart';
import SettingsPanel from '@/components/SettingsPanel';
import TeamViewPanel from '@/components/TeamViewPanel';
import TemplateGenModal, { GROUND_FLOOR_CATEGORY } from '@/components/TemplateGenModal';
import WeeklyScheduleTable from '@/components/WeeklyScheduleTable';
import { addDays, addMonths, diffDays, endOfMonth, ISODate, mondayOfWeek, todayISO } from '@/lib/domain/dateUtils';
import { KOREAN_HOLIDAYS, KOREAN_HOLIDAY_YEARS } from '@/lib/domain/koreanHolidays';
import { buildWeeklyScheduleData } from '@/lib/export/weeklyScheduleData';
import { PROCESS_TYPE_MAP } from '@/lib/domain/processTypes';
import { CHANGELOG, APP_REVISION, LAST_UPDATED } from '@/lib/changelog';
import {
  collidingProcesses,
  deleteProcess,
  deleteProcessCycle,
  extendMainProcess,
  findTimeSlotConflict,
  findMainCollisions,
  generateBaseFloorSequence,
  generateRepeatingFromTemplate,
  isKnownType,
  moveMainProcess,
  moveSubProcess,
  moveCustomProcess,
  previewMainMove,
  processLabel,
  pushProcessesOffHoliday,
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
  HolidayKind,
  ProcessInstance,
  ProcessTemplate,
  SiteInfo,
  TemplateStepDef,
} from '@/lib/domain/types';
import { loadState, saveState, SITE_KEY, stableStringify, subscribeState } from '@/lib/supabase/state';

// 이동/순연 사유로 자주 쓰는 항목들 — 직접 입력하는 대신 눌러서 바로 넣을 수 있게 한다.
const REASON_PRESETS = [
  '우천',
  '강풍',
  '폭염',
  '폭우',
  '태풍',
  '한파',
  '파업',
  '검측',
  '타공정 지연',
  '자재수급 지연',
  '인력 부족',
  '민원 발생',
];

const INITIAL_BLOCKS: Block[] = [
  { id: 'b1', name: '11동', sortOrder: 1 },
  { id: 'b2', name: '12동', sortOrder: 2 },
  { id: 'b3', name: '13동', sortOrder: 3 },
  { id: 'b4', name: '14동', sortOrder: 4 },
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
  kind: 'main' | 'sub' | 'custom';
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
  const [changelogOpen, setChangelogOpen] = useState(false);
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
  const [processGapDays, setProcessGapDays] = useState<number>(1);
  const [viewStartDate, setViewStartDate] = useState<ISODate>(() => mondayOfWeek(todayISO()));
  // 월간공정표(일단위, 기본)과 전체공정표(월단위, 타설만 표기) 중 어느 걸 볼지 — 각자 화면에서만
  // 쓰는 상태라 저장 대상(AppState)에는 넣지 않는다.
  const [viewMode, setViewMode] = useState<'monthly' | 'overview'>('monthly');
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

  // 되돌리기(Ctrl+Z) 기록. 다른 사용자가 실시간으로 반영한 변경(원격 동기화)은 "내가 한
  // 행동"이 아니므로 이 기록엔 안 남긴다 — applyRemoteState를 부를 때만 이 플래그를 세운다.
  const isApplyingRemoteRef = useRef(false);
  const undoStackRef = useRef<AppState[]>([]);
  const redoStackRef = useRef<AppState[]>([]);
  const lastUndoStateRef = useRef<AppState | null>(null);
  const UNDO_STACK_LIMIT = 40;

  // DB의 예전 데이터는 그 이후 추가된 필드(directLabor 등)가 아예 없을 수 있다.
  // 매번 이 함수를 거쳐서 기본값을 채운 "정규화된" 상태만 다루면, 로컬 상태와 마지막으로
  // 동기화한 문자열이 항상 같은 모양이 되어 필드 유무 차이로 인한 무한 저장 루프를 막는다.
  function normalizeAppState(remote: AppState): AppState {
    return {
      ...remote,
      directLabor: (remote.directLabor ?? []).map((d) => ({ ...d, category: d.category ?? '기타' })),
      crewTeams: remote.crewTeams ?? [],
      processGapDays: remote.processGapDays ?? 1,
    };
  }

  function applyRemoteState(remote: AppState) {
    isApplyingRemoteRef.current = true;
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
    setProcessGapDays(state.processGapDays);
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
            processGapDays: 1,
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
      processGapDays,
    };
    const json = stableStringify(state);
    if (json === lastSyncedJsonRef.current) return;
    const handle = setTimeout(() => {
      pendingStateRef.current = state;
      flushPendingSave();
    }, 500);
    return () => clearTimeout(handle);
  }, [loaded, siteInfo, blocks, templates, holidays, processes, changeHistory, dateShiftHistory, notes, directLabor, crewTeams, processGapDays]);

  // 되돌리기 기록: 상태가 바뀌고 잠시(600ms) 조용하면, 그 직전 상태를 되돌리기 스택에
  // 쌓아둔다 — 드래그 하나, 삭제 하나처럼 "동작 하나"에 해당하는 변화 묶음이 한 칸이
  // 되도록 저장 debounce와 같은 방식을 쓴다. 원격 동기화로 반영된 변경(다른 사용자가
  // 한 행동)은 되돌리기 대상에서 제외한다.
  useEffect(() => {
    if (!loaded) {
      isApplyingRemoteRef.current = false;
      return;
    }
    const cameFromRemote = isApplyingRemoteRef.current;
    isApplyingRemoteRef.current = false;

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
      processGapDays,
    };

    if (lastUndoStateRef.current === null) {
      // 처음 불러온 상태는 그 자체가 되돌릴 대상이 아니라 기준점이다.
      lastUndoStateRef.current = state;
      return;
    }

    const handle = setTimeout(() => {
      if (cameFromRemote) {
        lastUndoStateRef.current = state;
        return;
      }
      const prev = lastUndoStateRef.current;
      if (prev && stableStringify(prev) !== stableStringify(state)) {
        undoStackRef.current.push(prev);
        if (undoStackRef.current.length > UNDO_STACK_LIMIT) undoStackRef.current.shift();
        // 새 행동이 생기면 그동안 쌓인 "다시하기" 기록은 무효가 된다(분기).
        redoStackRef.current = [];
      }
      lastUndoStateRef.current = state;
    }, 600);
    return () => clearTimeout(handle);
  }, [loaded, siteInfo, blocks, templates, holidays, processes, changeHistory, dateShiftHistory, notes, directLabor, crewTeams, processGapDays]);

  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchBlockId, setSearchBlockId] = useState<'all' | string>('all');
  const [searchNotFound, setSearchNotFound] = useState(false);
  const [scrollToBlockId, setScrollToBlockId] = useState<{ blockId: string; nonce: number } | null>(null);

  // 전체 상태를 스냅샷 하나로 그대로 되돌린다(되돌리기/다시하기 공용).
  function applyState(s: AppState) {
    lastUndoStateRef.current = s;
    setSiteInfo(s.siteInfo);
    setBlocks(s.blocks);
    setTemplates(s.templates);
    setHolidays(s.holidays);
    setProcesses(s.processes);
    setChangeHistory(s.changeHistory);
    setDateShiftHistory(s.dateShiftHistory);
    setNotes(s.notes);
    setDirectLabor(s.directLabor);
    setCrewTeams(s.crewTeams);
    setProcessGapDays(s.processGapDays);
    setSelectedProcessId(null);
    setWarning(null);
  }

  // 되돌리기: 직전 상태를 꺼내 적용하고, 지금 상태는 "다시하기" 스택에 넣는다.
  function handleUndo() {
    const prev = undoStackRef.current.pop();
    if (!prev) {
      setWarning('더 되돌릴 내용이 없습니다.');
      return;
    }
    if (lastUndoStateRef.current) redoStackRef.current.push(lastUndoStateRef.current);
    applyState(prev);
  }

  // 다시하기: 되돌리기로 취소했던 상태를 다시 적용하고, 지금 상태는 되돌리기 스택에 넣는다.
  function handleRedo() {
    const next = redoStackRef.current.pop();
    if (!next) {
      setWarning('다시 실행할 내용이 없습니다.');
      return;
    }
    if (lastUndoStateRef.current) undoStackRef.current.push(lastUndoStateRef.current);
    applyState(next);
  }

  // Ctrl+Z=되돌리기, Ctrl+Shift+Z 또는 Ctrl+Y=다시하기(맥은 Cmd). 텍스트 입력칸에
  // 포커스가 있을 때는 그 칸 자체의 되돌리기(브라우저 기본 동작)를 그대로 둔다.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        handleRedo();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleUndo, handleRedo]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [templateGenOpen, setTemplateGenOpen] = useState(false);
  const [templateGenPrefill, setTemplateGenPrefill] = useState<{ blockId: string; startDate: ISODate } | null>(null);
  const [teamViewOpen, setTeamViewOpen] = useState(false);
  const [excelExportOpen, setExcelExportOpen] = useState(false);
  const [excelScope, setExcelScope] = useState<'all' | string>('all');
  const [excelStartDate, setExcelStartDate] = useState<ISODate>(() => mondayOfWeek(todayISO()));
  const [excelWeeks, setExcelWeeks] = useState('2');
  const [excelFileName, setExcelFileName] = useState('');
  const [excelExporting, setExcelExporting] = useState(false);
  const [noteModal, setNoteModal] = useState<{ blockId: string; date: ISODate } | null>(null);
  const [reasonPopup, setReasonPopup] = useState<{ label: string; reason: string; path?: string; processId: string } | null>(null);
  const [crewModal, setCrewModal] = useState<{ processId: string; team: string; headcount: string; date: string } | null>(
    null,
  );
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
  // sortOrder는 저장돼 있지만 그동안 실제로 정렬에 쓰이지 않고 배열 순서 그대로 표시돼왔다.
  // 화면에 보여줄 때는 항상 이 정렬된 목록을 쓰고, blocks 자체(원본 배열)는 그대로 둔다.
  const sortedBlocks = useMemo(() => [...blocks].sort((a, b) => a.sortOrder - b.sortOrder), [blocks]);

  // 진척/지연 현황: 주공정+구간공정(보조공정 제외) 기준으로 동별·전체 완료율과 지연 건수를
  // 센다. 지연 = 계획 날짜가 오늘보다 지났는데 "실제 완료" 체크가 안 된 공정.
  const statusSummary = useMemo(() => {
    const today = todayISO();
    const countable = (p: ProcessInstance) => PROCESS_TYPE_MAP[p.typeCode]?.category !== 'sub';
    // 진척률은 공정 개수가 아니라 각 공정의 일수(durationDays, 없으면 1일)에 비례해 계산한다.
    // 예: 전체 10일 중 7일짜리 공정을 완료하면 그 공정이 70%를 차지한다. (건수는 라벨용으로 유지)
    const weight = (p: ProcessInstance) => Math.max(1, Math.floor(p.durationDays || 1));
    const sumW = (arr: ProcessInstance[]) => arr.reduce((s, p) => s + weight(p), 0);
    const perBlock = sortedBlocks.map((b) => {
      const ps = processes.filter((p) => p.blockId === b.id && countable(p));
      const doneList = ps.filter((p) => p.actualDone);
      const ipList = ps.filter((p) => !p.actualDone && p.inProgress);
      return {
        blockId: b.id,
        name: b.name,
        total: ps.length,
        done: doneList.length,
        inProgress: ipList.length,
        overdue: ps.filter((p) => !p.actualDone && p.date < today).length,
        totalWeight: sumW(ps),
        doneWeight: sumW(doneList),
        inProgressWeight: sumW(ipList),
      };
    });
    const sum = (k: 'total' | 'done' | 'inProgress' | 'overdue' | 'totalWeight' | 'doneWeight' | 'inProgressWeight') =>
      perBlock.reduce((s, x) => s + x[k], 0);
    return {
      perBlock,
      total: sum('total'),
      done: sum('done'),
      inProgress: sum('inProgress'),
      overdue: sum('overdue'),
      totalWeight: sum('totalWeight'),
      doneWeight: sum('doneWeight'),
      inProgressWeight: sum('inProgressWeight'),
    };
  }, [processes, sortedBlocks]);

  function handleReorderBlock(id: string, direction: 'up' | 'down') {
    setBlocks((cur) => {
      const sorted = [...cur].sort((a, b) => a.sortOrder - b.sortOrder);
      const idx = sorted.findIndex((b) => b.id === id);
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (idx === -1 || targetIdx < 0 || targetIdx >= sorted.length) return cur;
      const a = sorted[idx];
      const b = sorted[targetIdx];
      return cur.map((block) => {
        if (block.id === a.id) return { ...block, sortOrder: b.sortOrder };
        if (block.id === b.id) return { ...block, sortOrder: a.sortOrder };
        return block;
      });
    });
  }

  // 간트차트 행 헤더(동 이름)를 드래그해서 임의 위치로 옮긴다 — 인접 칸끼리만 바꾸는
  // handleReorderBlock과 달리, dragged 동을 target 동 자리로 통째로 옮기고 그 사이
  // 나머지 동들을 한 칸씩 밀어서 전체 sortOrder를 다시 매긴다.
  function handleMoveBlockTo(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    setBlocks((cur) => {
      const sorted = [...cur].sort((a, b) => a.sortOrder - b.sortOrder);
      const fromIdx = sorted.findIndex((b) => b.id === draggedId);
      const toIdx = sorted.findIndex((b) => b.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return cur;
      const [moved] = sorted.splice(fromIdx, 1);
      // splice로 이미 fromIdx 자리를 뺐으므로, toIdx(원래 배열 기준 인덱스)에 그대로
      // 다시 끼워 넣으면 dragged 동이 target 동의 원래 자리를 차지하고 target은 밀려난다.
      // 아래로 옮길 때(fromIdx < toIdx)는 이 방식이 target 바로 뒤에 꽂히는 것과 같아서,
      // 바로 다음 동을 대상으로 드래그해도(가장 작은 이동) 한 칸 밀리는 게 보장된다.
      sorted.splice(toIdx, 0, moved);
      const orderMap = new Map(sorted.map((b, i) => [b.id, i + 1]));
      return cur.map((block) => ({ ...block, sortOrder: orderMap.get(block.id) ?? block.sortOrder }));
    });
  }

  function handleSelectProcess(id: string) {
    setWarning(null);
    setSelectedProcessId((cur) => (cur === id ? null : id));
  }

  // 동 이름 또는 층수로 빠르게 찾아서 그 자리로 스크롤한다. 층수(예: "17"/"17F")를
  // 먼저 찾아보고, 없으면 동 이름(부분 일치)으로 찾는다. 층을 찾은 경우엔 그 층이
  // 보이는 주간으로 날짜도 같이 옮기고 해당 갱폼 공정을 선택 상태로 표시한다.
  function handleSearch() {
    const q = searchQuery.trim();
    // 검색 대상: 동을 골랐으면 그 동 안에서만, 아니면 전체 동.
    const scoped = searchBlockId === 'all' ? processes : processes.filter((p) => p.blockId === searchBlockId);

    // 동만 고르고 검색어가 없으면 그 동으로 스크롤만 한다.
    if (!q) {
      if (searchBlockId !== 'all') {
        setScrollToBlockId({ blockId: searchBlockId, nonce: Date.now() });
        setSearchNotFound(false);
      }
      return;
    }
    const qUpper = q.toUpperCase();
    const qDigits = q.replace(/[^0-9]/g, '');

    // 층수 검색: floorLabel이 붙은 모든 공정(기준층 갱폼 + 층수 지정한 구간공정)을 대상으로.
    // 같은 층이 여러 개면 갱폼을 우선, 없으면 가장 이른 날짜를 대표로 잡는다.
    const floorMatches = scoped
      .filter((p) => {
        if (!p.floorLabel) return false;
        const label = p.floorLabel.toUpperCase();
        return label === qUpper || (!!qDigits && label.replace(/[^0-9]/g, '') === qDigits);
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    const floorMatch = floorMatches.find((p) => p.typeCode === 'GANGFORM') ?? floorMatches[0];
    if (floorMatch) {
      setViewStartDate(mondayOfWeek(floorMatch.date));
      setSelectedProcessId(floorMatch.id);
      setScrollToBlockId({ blockId: floorMatch.blockId, nonce: Date.now() });
      setSearchNotFound(false);
      return;
    }

    // 공정명(부분 일치)으로 찾는다.
    const labelMatch = scoped
      .filter((p) => processLabel(p).includes(q))
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (labelMatch) {
      setViewStartDate(mondayOfWeek(labelMatch.date));
      setSelectedProcessId(labelMatch.id);
      setScrollToBlockId({ blockId: labelMatch.blockId, nonce: Date.now() });
      setSearchNotFound(false);
      return;
    }

    // 전체 검색일 때만 동 이름으로도 찾아본다(동을 이미 고른 경우엔 불필요).
    if (searchBlockId === 'all') {
      const blockMatch = sortedBlocks.find((b) => b.name.includes(q));
      if (blockMatch) {
        setScrollToBlockId({ blockId: blockMatch.id, nonce: Date.now() });
        setSearchNotFound(false);
        return;
      }
    }

    setSearchNotFound(true);
  }

  const EXCEL_WEEKS_MAX = 104; // 최대 2년치 — 안전장치일 뿐 실사용은 보통 전체 기간을 그대로 씀
  const excelExportWeeks = Math.min(EXCEL_WEEKS_MAX, Math.max(1, Number(excelWeeks) || 2));
  const excelScopeLabel = excelScope === 'all' ? '전체' : sortedBlocks.find((b) => b.id === excelScope)?.name ?? excelScope;
  const weeklyPrintData = useMemo(() => {
    if (!excelExportOpen) return null;
    return buildWeeklyScheduleData({
      blocks,
      processes,
      holidays,
      startDate: excelStartDate,
      weeks: excelExportWeeks,
      scopeBlockId: excelScope,
    });
  }, [excelExportOpen, blocks, processes, holidays, excelStartDate, excelExportWeeks, excelScope]);

  // 지정한 범위(전체 동이면 scopeBlockId 없음)에 실제로 공정이 걸쳐 있는 첫 날짜~마지막
  // 날짜를 찾아서, 사용자가 아무것도 따로 설정하지 않아도 "엑셀 내보내기"를 누르면 바로
  // 작업 전체 기간이 다 보이도록 시작일·기간을 미리 채워준다.
  function openExcelExport(scopeBlockId: 'all' | string) {
    const target = scopeBlockId === 'all' ? processes : processes.filter((p) => p.blockId === scopeBlockId);
    if (target.length === 0) {
      setWarning('이 동에는 아직 생성된 공정이 없습니다.');
      return;
    }
    const dates = target.map((p) => p.date);
    const minDate = dates.reduce((a, b) => (a < b ? a : b));
    const maxDate = dates.reduce((a, b) => (a > b ? a : b));
    const weeks = Math.min(EXCEL_WEEKS_MAX, Math.max(1, Math.ceil((diffDays(minDate, maxDate) + 1) / 7)));
    setExcelScope(scopeBlockId);
    setExcelStartDate(minDate);
    setExcelWeeks(String(weeks));
    const scopeLabel = scopeBlockId === 'all' ? '전체' : blocks.find((b) => b.id === scopeBlockId)?.name ?? scopeBlockId;
    setExcelFileName(`${siteInfo.name || '현장'}_주간공정표_${scopeLabel}_${minDate}`);
    setExcelExportOpen(true);
  }

  async function handleExportExcel() {
    const weeks = excelExportWeeks;
    setExcelExporting(true);
    try {
      const { downloadWeeklyScheduleExcel } = await import('@/lib/export/scheduleExcel');
      await downloadWeeklyScheduleExcel({
        siteName: siteInfo.name,
        blocks,
        processes,
        holidays,
        startDate: excelStartDate,
        weeks,
        scopeBlockId: excelScope,
        fileName: excelFileName.trim() || undefined,
      });
      setExcelExportOpen(false);
    } finally {
      setExcelExporting(false);
    }
  }

  function resetDropFlow() {
    setPendingDrop(null);
    setDropStage('idle');
    setReasonInput('');
  }

  // 다른 동으로 드래그했을 때, 그 공정이 자기 사이클의 첫 주요공정이면 이동이 아니라
  // "복사"로 처리한다 — 같은 순서(먹메김/철근/거푸집 등)를 매번 새로 입력하지 않고
  // 한 동에서 이미 만든 전체 사이클을 다른 동에 그대로 복제해 넣기 위한 기능이다.
  // 원본 동의 공정은 그대로 남고, 대상 동에 새 cycleId로 복사본이 생성된다.
  function handleCrossBlockCopy(proc: ProcessInstance, targetBlockId: string, targetDate: ISODate) {
    const cycleMembers = processes.filter((p) => p.cycleId === proc.cycleId);
    const categoryOf = (p: ProcessInstance) => {
      const def = PROCESS_TYPE_MAP[p.typeCode];
      return def?.category ?? (isKnownType(p.typeCode) ? 'sub' : 'main');
    };
    const mainMembers = cycleMembers.filter((p) => categoryOf(p) === 'main');
    const earliestMain = mainMembers.reduce(
      (min, p) => (!min || p.date < min.date ? p : min),
      null as ProcessInstance | null,
    );

    if (categoryOf(proc) !== 'main' || !earliestMain || earliestMain.id !== proc.id) {
      setWarning('다른 동으로는 사이클의 첫 주요공정만 드래그해 복사할 수 있습니다.');
      return;
    }

    const deltaDays = diffDays(proc.date, targetDate);
    const newCycleId = crypto.randomUUID();
    const idMap = new Map<string, string>();
    for (const p of cycleMembers) idMap.set(p.id, crypto.randomUUID());
    const copied: ProcessInstance[] = cycleMembers.map((p) => ({
      ...p,
      id: idMap.get(p.id)!,
      blockId: targetBlockId,
      date: addDays(p.date, deltaDays),
      cycleId: newCycleId,
      cellOrder: undefined,
      conflictGroup: undefined,
      conflictSeq: undefined,
      crew: undefined,
      linkedMainProcessId: p.linkedMainProcessId ? idMap.get(p.linkedMainProcessId) : undefined,
    }));
    setProcesses((cur) => recomputeConflicts([...cur, ...copied]));
    setWarning(null);
  }

  function handleDropProcess(processId: string, blockId: string, date: ISODate) {
    const proc = processes.find((p) => p.id === processId);
    if (!proc) return;
    if (blockId !== proc.blockId) {
      handleCrossBlockCopy(proc, blockId, date);
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

    // 지상층 엔진의 주요공정만 불변규칙 검증 대상. 구간공정(커스텀 템플릿)은 캐스케이드는
    // 안 하지만, 같은 동에서 이미 차 있는 칸에 놓으면 다음 빈 날로 밀어 배치한다(kind='custom').
    if (!isKnownType(proc.typeCode)) {
      setPendingDrop({ processId, blockId, date, kind: 'custom', collisionCount: 0 });
      setDropStage('reason');
      return;
    }

    const preview = previewMainMove(processes, processId, date);
    if (preview.blockedReason) {
      setWarning(preview.blockedReason);
      return;
    }
    // 같은 동의 이후 층과 겹치는 경우는 여기서 미리 막지 않는다 — moveMainProcess가
    // 확정 시점에 도미노로 뒤 층을 밀어서 자동으로 해결한다(이전 층과 겹치는 경우만
    // moveMainProcess가 blockedReason으로 막는다).
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
    setCrewModal({ processId, team, headcount: proc?.crew ? String(proc.crew.headcount) : '', date: proc?.date ?? '' });
  }

  function handleSaveCrew() {
    if (!crewModal) return;
    const count = Number(crewModal.headcount) || 0;
    setProcesses((cur) => setCrew(cur, crewModal.processId, crewModal.team, count));
    setCrewModal(null);
  }

  function handleMoveViaDateInput() {
    if (!crewModal) return;
    const proc = processes.find((p) => p.id === crewModal.processId);
    if (!proc || !crewModal.date || crewModal.date === proc.date) return;
    handleDropProcess(crewModal.processId, proc.blockId, crewModal.date);
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

  // 설정의 공정 템플릿 탭에서 쓴다 — 공사종류 이름을 템플릿 이름으로 그대로 매칭해서
  // 있으면 단계를 갱신하고 없으면 새로 만든다.
  function handleSaveTemplateSteps(categoryName: string, steps: TemplateStepDef[]) {
    setTemplates((cur) => {
      const existing = cur.find((t) => t.name === categoryName);
      if (existing) {
        return cur.map((t) => (t.id === existing.id ? { ...t, steps } : t));
      }
      return [...cur, { id: crypto.randomUUID(), name: categoryName, steps }];
    });
  }

  // "구간 공정 생성" 모달에서 직접 순서를 짜서 만든 경우: 그 순서를 해당 카테고리의
  // 기본 순서로도 저장해두고(다음에 재사용), 겹침 검사를 통과하면 바로 생성한다.
  // 반환값이 있으면 그 문자열을 모달에 에러로 보여준다.
  function handleGenerateFromCustomOrder(
    targetBlockId: string,
    categoryName: string,
    steps: TemplateStepDef[],
    startDate: ISODate,
    repeatCount: number,
    floorLabel: string,
  ): string | null {
    const template: ProcessTemplate = {
      id: templates.find((t) => t.name === categoryName)?.id ?? crypto.randomUUID(),
      name: categoryName,
      steps,
    };
    // 기존 공정을 넘겨서, 새 구간공정 단계가 이미 차 있는 날을 피해(다음 빈 날로 밀려)
    // 배치되게 한다 — 겹치면 막지 않고 자동으로 밀어 배치. floorLabel이 있으면 각 단계에
    // 그 층수를 붙여, 나중에 검색에서 층수로 찾을 수 있게 한다.
    const generated = generateRepeatingFromTemplate(template, targetBlockId, startDate, holidays, repeatCount, {
      floorLabel: floorLabel || undefined,
    }, processes);
    const collisions = findMainCollisions([...processes, ...generated]).filter((c) => c.blockId === targetBlockId);
    if (collisions.length > 0) {
      const list = collisions.map((c) => `${c.date} ${c.labels.join('/')}`).join(', ');
      return `이 시작일로 생성하면 기존 공정과 겹치게 되어 만들 수 없습니다: ${list}`;
    }
    handleSaveTemplateSteps(categoryName, steps);
    setProcesses((cur) => recomputeConflicts([...cur, ...generated]));
    return null;
  }

  // "구간 공정 생성" 모달의 "저장" 버튼: 지금 짠 순서를 새 이름의 템플릿으로 저장만 하고
  // (바로 생성하지 않음) 왼쪽 목록에 새 카드로 나타나게 한다.
  function handleSaveNewTemplate(title: string, steps: TemplateStepDef[]) {
    handleSaveTemplateSteps(title, steps);
  }

  function handleToggleActualDone(processId: string) {
    setProcesses((cur) => cur.map((p) => (p.id === processId ? { ...p, actualDone: !p.actualDone } : p)));
  }

  // 주공정/구간공정 상태를 클릭할 때마다 시작 전 → 진행 중 → 완료 → 시작 전으로 순환한다.
  function handleCycleStatus(processId: string) {
    setProcesses((cur) =>
      cur.map((p) => {
        if (p.id !== processId) return p;
        if (!p.actualDone && !p.inProgress) return { ...p, inProgress: true }; // 시작 전 → 진행 중
        if (p.inProgress && !p.actualDone) return { ...p, inProgress: false, actualDone: true }; // 진행 중 → 완료
        return { ...p, actualDone: false, inProgress: false }; // 완료 → 시작 전
      }),
    );
  }

  function handleSetTimeSlot(processId: string, slot: 'morning' | 'afternoon' | undefined) {
    const conflict = findTimeSlotConflict(processes, processId, slot);
    if (conflict) {
      setWarning(
        `같은 날 ${processLabel(conflict)}과(와) 겹치게 되어 바꿀 수 없습니다. 그 공정도 오전/오후로 나누거나 먼저 다른 날짜로 옮겨주세요.`,
      );
      return;
    }
    setProcesses((cur) => cur.map((p) => (p.id === processId ? { ...p, timeSlot: slot } : p)));
  }

  function handleExtendProcess(processId: string, direction: 'extend' | 'shrink') {
    // ⏩/⏪는 연달아 빠르게 눌릴 수 있는 단순 버튼이라, 클로저에 갇힌 processes를 그대로 쓰면
    // 같은 렌더 안에서 여러 번 눌렀을 때 뒤 클릭이 앞 클릭 결과를 덮어써서 클릭 수만큼
    // 반영되지 않는다. 실제 상태 반영은 항상 최신 state를 기준으로 다시 계산하는 함수형
    // 업데이트로 하고, 경고 메시지는 클릭 시점의 상태로 미리 한 번 계산해 바로 보여준다
    // (아주 드물게 그 사이 다른 업데이트가 끼어들면 경고 없이 조용히 무시될 수 있지만,
    // 상태 자체가 잘못 반영되는 일은 없다).
    const preview = extendMainProcess(processes, processId, holidays, direction, processGapDays);
    if (preview.blockedReason) {
      setWarning(preview.blockedReason);
      return;
    }
    setProcesses((prev) => {
      const result = extendMainProcess(prev, processId, holidays, direction, processGapDays);
      return result.blockedReason ? prev : recomputeConflicts(result.processes);
    });
  }

  function handleDeleteProcess(processId: string) {
    setProcesses((prev) => recomputeConflicts(deleteProcess(prev, processId)));
    setSelectedProcessId((cur) => (cur === processId ? null : cur));
  }

  function handleDeleteProcessCycle(processId: string) {
    setProcesses((prev) => recomputeConflicts(deleteProcessCycle(prev, processId)));
    setSelectedProcessId((cur) => (cur === processId ? null : cur));
  }

  function handleAddHoliday(date: ISODate, kind: HolidayKind) {
    if (holidays.some((h) => h.date === date)) return;
    const nextHolidays = [...holidays, { date, kind }];
    setHolidays(nextHolidays);
    const result = pushProcessesOffHoliday(processes, changeHistory, date, nextHolidays, processGapDays);
    setProcesses(result.processes);
    setChangeHistory(result.changeHistory);
  }

  function handleRemoveHoliday(date: ISODate) {
    setHolidays((cur) => cur.filter((h) => h.date !== date));
  }

  // 한국 공휴일 한 해치를 한꺼번에 등록한다. 이미 있는 날짜는 건너뛰고, 새로 추가한
  // 공휴일마다 그날 잡혀 있던 공정을 밀어낸다. 추가한 개수를 반환한다(안내용).
  function handleAddKoreanHolidays(year: number): number {
    const list = KOREAN_HOLIDAYS[year] ?? [];
    const existing = new Set(holidays.map((h) => h.date));
    const toAdd = list.filter((h) => !existing.has(h.date));
    if (toAdd.length === 0) return 0;
    const nextHolidays = [...holidays, ...toAdd.map((h) => ({ date: h.date, kind: h.kind }))];
    setHolidays(nextHolidays);
    let procs = processes;
    let hist = changeHistory;
    for (const h of toAdd) {
      const r = pushProcessesOffHoliday(procs, hist, h.date, nextHolidays, processGapDays);
      procs = r.processes;
      hist = r.changeHistory;
    }
    setProcesses(procs);
    setChangeHistory(hist);
    return toAdd.length;
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

  function handleAddDirectLabor(date: ISODate, category: string, workContent: string, headcount: number, manager?: string) {
    const entry: DirectLaborEntry = { id: crypto.randomUUID(), date, category, workContent, headcount, manager };
    setDirectLabor((cur) => [...cur, entry]);
  }

  // 관리자/공사/직영·용역/안전/안전시설 같은 고정 항목은 날짜당 하나뿐이라 매번 새로
  // 추가하지 않고, 있으면 고치고 없으면 만들고 비우면 지운다.
  function handleSetFixedLabor(date: ISODate, category: string, headcount: number, workContent: string) {
    setDirectLabor((cur) => {
      const idx = cur.findIndex((d) => d.date === date && d.category === category);
      const isEmpty = !workContent.trim() && headcount <= 0;
      if (idx === -1) {
        if (isEmpty) return cur;
        return [...cur, { id: crypto.randomUUID(), date, category, workContent: workContent.trim(), headcount }];
      }
      if (isEmpty) return cur.filter((_, i) => i !== idx);
      return cur.map((d, i) => (i === idx ? { ...d, workContent, headcount } : d));
    });
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
      const result = moveMainProcess(processes, changeHistory, pendingDrop.processId, pendingDrop.date, reason, holidays, processGapDays);
      if (result.blockedReason) {
        setWarning(result.blockedReason);
      } else {
        setProcesses(recomputeConflicts(result.processes));
        setChangeHistory(result.changeHistory);
        if (result.notice) setWarning(result.notice);
      }
    } else if (pendingDrop.kind === 'custom') {
      const result = moveCustomProcess(processes, changeHistory, pendingDrop.processId, pendingDrop.date, reason, holidays);
      setProcesses(recomputeConflicts(result.processes));
      setChangeHistory(result.changeHistory);
      if (result.notice) setWarning(result.notice);
    } else {
      const proc = processes.find((p) => p.id === pendingDrop.processId);
      const result = moveSubProcess(processes, pendingDrop.processId, pendingDrop.date, holidays);
      setProcesses(recomputeConflicts(result.processes));
      if (proc) {
        setChangeHistory((h) => [
          ...h,
          { id: crypto.randomUUID(), processId: pendingDrop.processId, previousDate: proc.date, newDate: result.date, reason },
        ]);
      }
      if (result.sundaySkipped) {
        setWarning(`일요일로는 옮길 수 없어 ${result.date}(으)로 자동 순연되었습니다.`);
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
    const collisions = findMainCollisions(next);
    if (collisions.length > 0) {
      const list = collisions.map((c) => `${blockNames[c.blockId] ?? c.blockId} ${c.date} ${c.labels.join('/')}`).join(', ');
      setWarning(`이렇게 순연하면 주요공정끼리 겹치게 되어 처리할 수 없습니다: ${list}`);
      setPendingHeaderShift(null);
      setHeaderShiftStage('idle');
      setHeaderReasonInput('');
      return;
    }
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


  const pendingProcess = pendingDrop ? processes.find((p) => p.id === pendingDrop.processId) : null;
  const collidingList =
    pendingDrop && pendingProcess ? collidingProcesses(processes, pendingProcess, pendingDrop.date) : [];

  return (
    <div className="h-screen overflow-hidden bg-zinc-50 p-6 flex flex-col gap-4">
      <header className="flex flex-col gap-2 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 relative">
              <h1 className="text-xl font-semibold">{siteInfo.name} — 전체 공정표</h1>
              <button
                type="button"
                onClick={() => setChangelogOpen((v) => !v)}
                title="최근 수정 내역 보기"
                className="px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 shrink-0"
                data-testid="changelog-badge"
              >
                #{APP_REVISION}차 수정
              </button>
              {changelogOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setChangelogOpen(false)} />
                  <div className="absolute left-0 top-full mt-1 z-50 w-[420px] max-w-[90vw] max-h-[60vh] overflow-y-auto rounded-lg border border-zinc-300 bg-white shadow-lg p-3 text-sm">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-semibold text-zinc-700">최근 수정 내역</span>
                      <span className="text-xs text-zinc-400">최종 업데이트 {LAST_UPDATED}</span>
                    </div>
                    <ul className="flex flex-col gap-1.5">
                      {CHANGELOG.map((c) => (
                        <li key={c.no} className="flex gap-2">
                          <span className="shrink-0 font-semibold text-blue-600 tabular-nums">#{c.no}</span>
                          <span className="shrink-0 text-xs text-zinc-400 tabular-nums mt-0.5">{c.date.slice(5)}</span>
                          <span className="text-zinc-700">{c.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}
            </div>
            {siteInfo.overview && <p className="text-xs text-zinc-500 mt-0.5">{siteInfo.overview}</p>}
            {!loaded && !syncError && <p className="text-xs text-zinc-400 mt-0.5">불러오는 중…</p>}
            {syncError && <p className="text-xs text-red-600 mt-0.5">동기화 오류: {syncError}</p>}
          </div>
          <div className="flex gap-2 text-sm">
            <button
              className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100"
              onClick={() => setViewMode((m) => (m === 'monthly' ? 'overview' : 'monthly'))}
              data-testid="view-mode-toggle"
            >
              {viewMode === 'monthly' ? '전체공정표 보기' : '월간공정표 보기'}
            </button>
            <button
              className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100"
              onClick={handleUndo}
              title="되돌리기 (Ctrl+Z)"
              data-testid="undo-button"
            >
              ↩ 되돌리기
            </button>
            <button
              className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100"
              onClick={handleRedo}
              title="앞으로 되돌리기 (Ctrl+Shift+Z)"
              data-testid="redo-button"
            >
              앞으로 되돌리기 ↪
            </button>
            <button
              className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100"
              onClick={() => setHistoryOpen(true)}
              data-testid="history-button"
            >
              변경이력
            </button>
            <button
              className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100 flex items-center gap-1"
              onClick={() => setStatusOpen(true)}
              data-testid="status-button"
              title="진척 현황과 지연 공정 보기"
            >
              진척 현황
              {statusSummary.overdue > 0 && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold">
                  지연 {statusSummary.overdue}
                </span>
              )}
            </button>
            <button
              className="px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
              onClick={() => setTemplateGenOpen(true)}
              disabled={blocks.length === 0}
            >
              구간 공정 생성
            </button>
            <button
              className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100"
              onClick={() => setTeamViewOpen(true)}
            >
              투입인원
            </button>
            <button
              className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100 disabled:opacity-40"
              onClick={() => openExcelExport('all')}
              disabled={blocks.length === 0}
              data-testid="excel-export-button"
            >
              엑셀 내보내기
            </button>
            <button
              className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100"
              onClick={() => setSettingsOpen(true)}
            >
              설정
            </button>
          </div>
        </div>
        {viewMode === 'monthly' && (
          <div className="flex items-center justify-end gap-1 text-sm">
            <button
              className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100"
              onClick={() => setViewStartDate((d) => addDays(d, -7))}
            >
              ← 이전 주
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
              다음 주 →
            </button>
            <select
              value={searchBlockId}
              onChange={(e) => {
                setSearchBlockId(e.target.value);
                setSearchNotFound(false);
              }}
              data-testid="block-search-scope"
              className="ml-3 px-2 py-1.5 rounded border border-zinc-300 text-sm bg-white"
              title="찾을 동을 고르세요. 안 고르면(전체 동) 모든 동에서 찾습니다."
            >
              <option value="all">전체 동</option>
              {sortedBlocks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSearchNotFound(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch();
              }}
              placeholder="층수(예: 3) · 공정명"
              data-testid="block-search-input"
              className="ml-1 px-2 py-1.5 rounded border border-zinc-300 text-sm w-32"
            />
            <button
              className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100"
              onClick={handleSearch}
              data-testid="block-search-button"
            >
              찾기
            </button>
            {searchNotFound && <span className="text-xs text-red-600 whitespace-nowrap">못 찾았어요</span>}
          </div>
        )}
      </header>

      <div className="min-h-[36px] flex items-center gap-2 text-sm shrink-0" data-testid="action-bar">
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
              onClick={() => {
                setTemplateGenPrefill({ blockId: selectedProcess.blockId, startDate: selectedProcess.date });
                setTemplateGenOpen(true);
              }}
            >
              이 동에 기준층 생성
            </button>
          </>
        )}

        {!warning && !selectedProcess && (
          <span className="text-zinc-400">공정 칩을 드래그해서 같은 행의 다른 날짜로, 날짜 헤더를 드래그해서 전체 일정을 옮기세요.</span>
        )}
      </div>

      {viewMode === 'monthly' && (
        <div className="flex items-center flex-wrap gap-x-4 gap-y-1 px-1 pb-1.5 text-xs text-zinc-600">
          <span className="font-medium text-zinc-500">공정 상태 — 칩 앞 네모를 클릭해서 바꿔요:</span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-flex w-3.5 h-3.5 rounded-sm border border-zinc-400 bg-white" />
            시작 전
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-sm border border-sky-600 bg-sky-500 text-white text-[9px] font-bold leading-none">
              ▶
            </span>
            진행 중
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-sm border border-emerald-700 bg-emerald-600 text-white text-[9px] font-bold leading-none">
              ✓
            </span>
            완료
          </span>
          <span className="inline-flex items-center gap-1 text-red-600">
            <span className="font-bold">⚠</span>
            지연 (계획일이 지났는데 완료 안 됨)
          </span>
        </div>
      )}

      {viewMode === 'monthly' ? (
        <>
          <GanttChart
            blocks={sortedBlocks}
            processes={processes}
            holidays={holidays}
            changeHistory={changeHistory}
            notes={notes}
            onChangeNote={handleChangeNote}
            onOpenNote={(blockId, date) => setNoteModal({ blockId, date })}
            onShowReason={(label, reason, path, processId) => setReasonPopup({ label, reason, path, processId })}
            onEditCrew={handleOpenCrew}
            onSetTimeSlot={handleSetTimeSlot}
            onChangeBlockRemark={handleChangeBlockRemark}
            onClickHeaderDate={(date) => setDateChoice(date)}
            viewStartDate={viewStartDate}
            dayCount={dayCount}
            selectedProcessId={selectedProcessId}
            onSelectProcess={handleSelectProcess}
            onDropProcess={handleDropProcess}
            onDropHeader={handleDropHeader}
            onReorderCellOrder={handleReorderCellOrder}
            onToggleActualDone={handleToggleActualDone}
            onCycleStatus={handleCycleStatus}
            onExtendProcess={handleExtendProcess}
            onDeleteProcess={handleDeleteProcess}
            onDeleteProcessCycle={handleDeleteProcessCycle}
            onMoveBlockTo={handleMoveBlockTo}
            onClickBlockName={openExcelExport}
            scrollToBlockId={scrollToBlockId}
          />
          <p className="text-xs text-zinc-500 shrink-0">
            공정 칩을 같은 행의 다른 날짜 셀로 드래그하면 이동합니다. 날짜 헤더를 클릭하면 작업일보 보기/전체 일정
            순연을 선택할 수 있고, 드래그하면 바로 그 날짜 이후 모든 동의 일정이 함께 순연됩니다. 왼쪽의 동 이름을
            드래그하면 동 순서를 자유롭게 바꿀 수 있습니다.
          </p>
        </>
      ) : (
        <>
          <div className="flex-1 min-h-0 overflow-hidden">
            <OverviewChart blocks={sortedBlocks} processes={processes} />
          </div>
          <p className="text-xs text-zinc-500 shrink-0">전체공정표는 월 단위로, 동별 타설(층 완료) 일정만 간략하게 보여줍니다.</p>
        </>
      )}

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
          blocks={sortedBlocks}
          onAddBlock={(name, info) =>
            setBlocks((cur) => [
              ...cur,
              {
                id: crypto.randomUUID(),
                name,
                sortOrder: cur.reduce((max, b) => Math.max(max, b.sortOrder), 0) + 1,
                info: info || undefined,
              },
            ])
          }
          onRemoveBlock={handleRemoveBlock}
          onReorderBlock={handleReorderBlock}
          onChangeBlockInfo={(id, info) => setBlocks((cur) => cur.map((b) => (b.id === id ? { ...b, info } : b)))}
          crewTeams={crewTeams}
          onAddCrewTeam={handleAddCrewTeam}
          onRemoveCrewTeam={handleRemoveCrewTeam}
          holidays={holidays}
          onAddHoliday={handleAddHoliday}
          onRemoveHoliday={handleRemoveHoliday}
          onAddKoreanHolidays={handleAddKoreanHolidays}
          koreanHolidayYears={KOREAN_HOLIDAY_YEARS}
          processGapDays={processGapDays}
          onChangeProcessGapDays={setProcessGapDays}
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
          blocks={sortedBlocks}
        />
      )}

      {statusOpen && (
        <Modal>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">진척 현황</h2>
            <button className="text-sm px-2 py-1 rounded border border-zinc-300" onClick={() => setStatusOpen(false)}>
              닫기
            </button>
          </div>
          <p className="text-xs text-zinc-500 -mt-2">
            공정 <span className="font-medium">일수(기간)에 비례</span>한 완료율입니다 — 예: 전체 10일 중 7일짜리 공정을
            완료하면 70%. 지연 = 계획 날짜가 오늘보다 지났는데 완료 안 된 공정 (화면에서 빨간 ⚠ 테두리로도 표시돼요).
          </p>

          {(() => {
            const { done, inProgress, overdue, totalWeight, doneWeight, inProgressWeight, perBlock } = statusSummary;
            const pct = totalWeight > 0 ? Math.round((doneWeight / totalWeight) * 100) : 0;
            // 완료(초록) + 진행 중(파랑) 두 구간으로 나눠 그린다(일수 가중). 나머지는 시작 전(회색).
            const Bar = ({ d, ip, t }: { d: number; ip: number; t: number }) => (
              <div className="h-2.5 rounded-full bg-zinc-200 overflow-hidden flex">
                <div className="h-full bg-emerald-500" style={{ width: `${t > 0 ? (d / t) * 100 : 0}%` }} />
                <div className="h-full bg-sky-400" style={{ width: `${t > 0 ? (ip / t) * 100 : 0}%` }} />
              </div>
            );
            return (
              <>
                <div className="rounded border border-zinc-200 p-3 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-semibold">전체</span>
                    <span className="text-xs">
                      <span className="font-semibold text-emerald-700 text-sm">{pct}%</span>
                      <span className="text-zinc-500 ml-1">완료 {done}개</span>
                      {inProgress > 0 && <span className="text-sky-600 ml-1">· 진행 {inProgress}개</span>}
                      {overdue > 0 && <span className="ml-2 text-red-600 font-semibold">지연 {overdue}건</span>}
                    </span>
                  </div>
                  <Bar d={doneWeight} ip={inProgressWeight} t={totalWeight} />
                </div>

                <div className="flex flex-col gap-2">
                  {perBlock.map((b) => {
                    const p = b.totalWeight > 0 ? Math.round((b.doneWeight / b.totalWeight) * 100) : 0;
                    return (
                      <div key={b.blockId} className="flex flex-col gap-1">
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium">{b.name}</span>
                          <span className="text-xs text-zinc-500">
                            {p}% (완료 {b.done}
                            {b.inProgress > 0 && <span className="text-sky-600"> · 진행 {b.inProgress}</span>}/{b.total}개)
                            {b.overdue > 0 && <span className="ml-2 text-red-600 font-semibold">지연 {b.overdue}</span>}
                          </span>
                        </div>
                        <Bar d={b.doneWeight} ip={b.inProgressWeight} t={b.totalWeight} />
                      </div>
                    );
                  })}
                  {perBlock.length === 0 && <p className="text-xs text-zinc-400">아직 동/공정이 없습니다.</p>}
                </div>

                <p className="text-[11px] text-zinc-500 mt-1">
                  %는 <span className="text-zinc-700">공정 일수 기준</span>이고, 괄호 안 개수는 공정 수예요. 칩의 상태
                  표시를 클릭하면 <span className="text-zinc-700">시작 전 → 진행 중(파랑 ▶) → 완료(초록 ✓)</span>로 바뀝니다.
                </p>
              </>
            );
          })()}
        </Modal>
      )}

      {excelExportOpen && (
        <Modal>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">엑셀 내보내기</h2>
            <button className="text-sm px-2 py-1 rounded border border-zinc-300" onClick={() => setExcelExportOpen(false)}>
              닫기
            </button>
          </div>
          <p className="text-xs text-zinc-500 -mt-2">
            공정이 실제로 있는 전체 기간으로 자동으로 채워져 있습니다. 필요하면 아래에서 바꿀 수 있어요.
          </p>
          <label className="text-sm flex flex-col gap-1">
            대상
            <select
              className="border border-zinc-300 rounded px-2 py-1.5"
              value={excelScope}
              onChange={(e) => setExcelScope(e.target.value)}
            >
              <option value="all">전체 동</option>
              {sortedBlocks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm flex flex-col gap-1">
            시작일
            <input
              type="date"
              className="border border-zinc-300 rounded px-2 py-1.5"
              value={excelStartDate}
              onChange={(e) => setExcelStartDate(e.target.value as ISODate)}
            />
          </label>
          <label className="text-sm flex flex-col gap-1">
            기간 (주)
            <input
              type="number"
              min="1"
              max="104"
              className="border border-zinc-300 rounded px-2 py-1.5"
              value={excelWeeks}
              onChange={(e) => setExcelWeeks(e.target.value)}
            />
          </label>
          <label className="text-sm flex flex-col gap-1">
            파일 이름
            <div className="flex items-center">
              <input
                type="text"
                className="border border-zinc-300 rounded px-2 py-1.5 flex-1 min-w-0"
                value={excelFileName}
                onChange={(e) => setExcelFileName(e.target.value)}
                placeholder="예: 신현대_주간공정표"
              />
              <span className="text-xs text-zinc-400 ml-1 shrink-0">.xlsx</span>
            </div>
          </label>
          <div className="flex gap-2">
            <button
              className="flex-1 px-3 py-2 rounded bg-indigo-600 text-white text-sm disabled:opacity-40"
              onClick={handleExportExcel}
              disabled={excelExporting}
            >
              {excelExporting ? '만드는 중…' : '엑셀 다운로드'}
            </button>
            <button className="flex-1 px-3 py-2 rounded border border-zinc-300 text-sm" onClick={() => window.print()}>
              PDF/인쇄
            </button>
          </div>
        </Modal>
      )}

      {excelExportOpen && weeklyPrintData && (
        <WeeklyScheduleTable siteName={siteInfo.name} scopeLabel={excelScopeLabel} data={weeklyPrintData} holidays={holidays} />
      )}

      {templateGenOpen && (
        <TemplateGenModal
          blocks={sortedBlocks}
          templates={templates}
          holidays={holidays}
          onSubmit={handleGenerateFromCustomOrder}
          onSaveNewTemplate={handleSaveNewTemplate}
          onRemoveTemplate={(id) => setTemplates((cur) => cur.filter((t) => t.id !== id))}
          onClose={() => {
            setTemplateGenOpen(false);
            setTemplateGenPrefill(null);
          }}
          initialCategory={templateGenPrefill ? GROUND_FLOOR_CATEGORY : undefined}
          initialBlockId={templateGenPrefill?.blockId}
          initialStartDate={templateGenPrefill?.startDate}
        />
      )}

      {teamViewOpen && (
        <TeamViewPanel
          onClose={() => setTeamViewOpen(false)}
          crewTeams={crewTeams}
          processes={processes}
          blocks={sortedBlocks}
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
          <p className="text-[11px] text-zinc-400">
            &lsquo;흔적 지우기&rsquo;는 이 회색 이력 표시만 지웁니다 (공정 위치는 그대로예요).
          </p>
          <div className="flex justify-between text-sm">
            <button
              className="px-3 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50"
              onClick={() => {
                setChangeHistory((cur) => cur.filter((r) => r.processId !== reasonPopup.processId));
                setReasonPopup(null);
              }}
            >
              이 이동 흔적 지우기
            </button>
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
          <div className="flex items-center gap-2 pt-2 border-t border-zinc-200">
            <span className="text-xs text-zinc-500 shrink-0">날짜 변경</span>
            <input
              className="border border-zinc-300 rounded px-2 py-1 text-sm flex-1"
              type="date"
              value={crewModal.date}
              onChange={(e) => setCrewModal((cur) => (cur ? { ...cur, date: e.target.value } : cur))}
            />
            <button className="text-xs px-2 py-1 rounded border border-zinc-300" onClick={handleMoveViaDateInput}>
              이 날짜로 이동
            </button>
          </div>
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
          blocks={sortedBlocks}
          processes={processes}
          directLabor={directLabor}
          notes={notes}
          onAddDirectLabor={handleAddDirectLabor}
          onSetFixedLabor={handleSetFixedLabor}
          onRemoveDirectLabor={handleRemoveDirectLabor}
          onClose={() => setReportDate(null)}
        />
      )}
    </div>
  );
}
