'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import DailyReportModal from '@/components/DailyReportModal';
import GanttChart from '@/components/GanttChart';
import HistoryPanel from '@/components/HistoryPanel';
import OverviewChart from '@/components/OverviewChart';
import SettingsPanel from '@/components/SettingsPanel';
import TeamViewPanel from '@/components/TeamViewPanel';
import { addDays, addMonths, diffDays, endOfMonth, ISODate, mondayOfWeek, todayISO } from '@/lib/domain/dateUtils';
import { PROCESS_TYPE_MAP } from '@/lib/domain/processTypes';
import {
  collidingProcesses,
  deleteProcess,
  extendMainProcess,
  findMainCollisions,
  generateBaseFloorSequence,
  generateRepeatingFloors,
  generateRepeatingFromTemplate,
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

  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [genFloorForm, setGenFloorForm] = useState<{
    blockId: string;
    floor: string;
    startDate: ISODate;
    templateId: string;
    repeatCount: string;
    skipOptional: boolean;
  } | null>(
    null,
  );

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [teamViewOpen, setTeamViewOpen] = useState(false);
  const [noteModal, setNoteModal] = useState<{ blockId: string; date: ISODate } | null>(null);
  const [reasonPopup, setReasonPopup] = useState<{ label: string; reason: string; path?: string } | null>(null);
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
      // fromIdx보다 뒤로 옮길 때는 방금 제거한 자리만큼 뒤쪽 인덱스가 하나씩 당겨졌으므로
      // 보정해야, dragged 동이 정확히 target 동의 원래 자리(그 앞)에 들어간다.
      const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx;
      sorted.splice(insertAt, 0, moved);
      const orderMap = new Map(sorted.map((b, i) => [b.id, i + 1]));
      return cur.map((block) => ({ ...block, sortOrder: orderMap.get(block.id) ?? block.sortOrder }));
    });
  }

  function handleSelectProcess(id: string) {
    setWarning(null);
    setSelectedProcessId((cur) => (cur === id ? null : id));
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

  function handleToggleActualDone(processId: string) {
    setProcesses((cur) => cur.map((p) => (p.id === processId ? { ...p, actualDone: !p.actualDone } : p)));
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

  function handleAddHoliday(date: ISODate, kind: HolidayKind) {
    setHolidays((cur) => (cur.some((h) => h.date === date) ? cur : [...cur, { date, kind }]));
  }

  function handleRemoveHoliday(date: ISODate) {
    setHolidays((cur) => cur.filter((h) => h.date !== date));
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

  function submitGenFloor() {
    if (!genFloorForm) return;
    let generated: ProcessInstance[];
    if (genFloorForm.templateId === 'ground') {
      // 기준층은 한 번으로 끝나지 않으니 시작 층부터 해당월 + 익월 말일까지 자동으로
      // 한 층씩 올려가며 반복 생성한다.
      const untilDate = endOfMonth(addMonths(genFloorForm.startDate, 1));
      generated = generateRepeatingFloors(genFloorForm.blockId, genFloorForm.floor, genFloorForm.startDate, holidays, untilDate, processGapDays);
    } else {
      const template = templates.find((t) => t.id === genFloorForm.templateId);
      if (!template) return;
      const repeatCount = Math.max(1, Number(genFloorForm.repeatCount) || 1);
      generated = generateRepeatingFromTemplate(template, genFloorForm.blockId, genFloorForm.startDate, holidays, repeatCount, {
        skipOptional: genFloorForm.skipOptional,
      });
    }
    const collisions = findMainCollisions([...processes, ...generated]).filter((c) => c.blockId === genFloorForm.blockId);
    if (collisions.length > 0) {
      const list = collisions.map((c) => `${c.date} ${c.labels.join('/')}`).join(', ');
      setWarning(`이 시작일로 생성하면 기존 공정과 겹치게 되어 만들 수 없습니다: ${list}`);
      return;
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
            onClick={() => setViewMode((m) => (m === 'monthly' ? 'overview' : 'monthly'))}
            data-testid="view-mode-toggle"
          >
            {viewMode === 'monthly' ? '전체공정표 보기' : '월간공정표 보기'}
          </button>
          {viewMode === 'monthly' && (
            <>
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
            </>
          )}
          <button
            className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100 disabled:opacity-40"
            onClick={() =>
              setGenFloorForm({
                blockId: sortedBlocks[0]?.id ?? '',
                floor: '16F',
                startDate: todayISO(),
                templateId: 'ground',
                repeatCount: '1',
                skipOptional: false,
              })
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
            onClick={() => setTeamViewOpen(true)}
          >
            투입인원
          </button>
          <button
            className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100"
            onClick={() => setSettingsOpen(true)}
          >
            설정
          </button>
          <a
            href="https://noreal.juankim.org/login?redirect=%2Fdashboard"
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 rounded border border-zinc-300 bg-white hover:bg-zinc-100"
          >
            다른 시스템 열기 ↗
          </a>
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
                setGenFloorForm({
                  blockId: selectedProcess.blockId,
                  floor: '16F',
                  startDate: selectedProcess.date,
                  templateId: 'ground',
                  repeatCount: '1',
                  skipOptional: false,
                })
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
            {sortedBlocks.map((b) => (
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
          {genFloorForm.templateId !== 'ground' && (
            <>
              <span>반복횟수:</span>
              <input
                type="number"
                min="1"
                className="border border-zinc-300 rounded px-2 py-1 w-16"
                value={genFloorForm.repeatCount}
                onChange={(e) => setGenFloorForm((cur) => (cur ? { ...cur, repeatCount: e.target.value } : cur))}
              />
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={genFloorForm.skipOptional}
                  onChange={(e) => setGenFloorForm((cur) => (cur ? { ...cur, skipOptional: e.target.checked } : cur))}
                />
                필요시 단계 제외
              </label>
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
            onToggleActualDone={handleToggleActualDone}
            onExtendProcess={handleExtendProcess}
            onDeleteProcess={handleDeleteProcess}
            onMoveBlockTo={handleMoveBlockTo}
          />
          <p className="text-xs text-zinc-500">
            공정 칩을 같은 행의 다른 날짜 셀로 드래그하면 이동합니다. 날짜 헤더를 클릭하면 작업일보 보기/전체 일정
            순연을 선택할 수 있고, 드래그하면 바로 그 날짜 이후 모든 동의 일정이 함께 순연됩니다. 왼쪽의 동 이름을
            드래그하면 동 순서를 자유롭게 바꿀 수 있습니다.
          </p>
        </>
      ) : (
        <>
          <OverviewChart blocks={sortedBlocks} processes={processes} />
          <p className="text-xs text-zinc-500">전체공정표는 월 단위로, 동별 타설(층 완료) 일정만 간략하게 보여줍니다.</p>
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
          onAddBlock={(name, facilityType, info) =>
            setBlocks((cur) => [
              ...cur,
              {
                id: crypto.randomUUID(),
                name,
                sortOrder: cur.reduce((max, b) => Math.max(max, b.sortOrder), 0) + 1,
                facilityType,
                info: info || undefined,
              },
            ])
          }
          onRemoveBlock={handleRemoveBlock}
          onReorderBlock={handleReorderBlock}
          onChangeBlockType={(id, facilityType) =>
            setBlocks((cur) => cur.map((b) => (b.id === id ? { ...b, facilityType } : b)))
          }
          onChangeBlockInfo={(id, info) => setBlocks((cur) => cur.map((b) => (b.id === id ? { ...b, info } : b)))}
          templates={templates}
          onSaveTemplateSteps={handleSaveTemplateSteps}
          onRemoveTemplate={(id) => setTemplates((cur) => cur.filter((t) => t.id !== id))}
          crewTeams={crewTeams}
          onAddCrewTeam={handleAddCrewTeam}
          onRemoveCrewTeam={handleRemoveCrewTeam}
          holidays={holidays}
          onAddHoliday={handleAddHoliday}
          onRemoveHoliday={handleRemoveHoliday}
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
          onRemoveDirectLabor={handleRemoveDirectLabor}
          onClose={() => setReportDate(null)}
        />
      )}
    </div>
  );
}
