'use client';

import { useState } from 'react';
import { ISODate } from '@/lib/domain/dateUtils';
import {
  Block,
  CrewTeam,
  FacilityType,
  Holiday,
  HolidayKind,
  ProcessTemplate,
  SiteInfo,
  TemplateStepDef,
} from '@/lib/domain/types';

const HOLIDAY_KIND_LABEL: Record<HolidayKind, string> = {
  sunday: '일요일',
  public_holiday: '공휴일',
  substitute_holiday: '대체휴일',
  temporary_holiday: '임시공휴일',
  vacation: '휴가',
};

// 문서 기획서의 대공종 분류 — 각 이름을 그대로 템플릿 이름으로 사용한다.
// 지상 기본층(갱폼~타설)은 별도 전용 엔진이라 여기 포함하지 않는다.
const TEMPLATE_CATEGORIES = ['기초공사', '지하층공사', '지상 PIT층', '주차장', '부속건물', '옥탑'];

interface SettingsPanelProps {
  onClose: () => void;
  siteInfo: SiteInfo;
  onChangeSiteInfo: (info: SiteInfo) => void;
  blocks: Block[];
  onAddBlock: (name: string, facilityType: FacilityType, info: string) => void;
  onRemoveBlock: (id: string) => void;
  onChangeBlockType: (id: string, facilityType: FacilityType) => void;
  onChangeBlockInfo: (id: string, info: string) => void;
  templates: ProcessTemplate[];
  onSaveTemplateSteps: (categoryName: string, steps: TemplateStepDef[]) => void;
  onRemoveTemplate: (id: string) => void;
  crewTeams: CrewTeam[];
  onAddCrewTeam: (name: string) => void;
  onRemoveCrewTeam: (id: string) => void;
  holidays: Holiday[];
  onAddHoliday: (date: ISODate, kind: HolidayKind) => void;
  onRemoveHoliday: (date: ISODate) => void;
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
  onChangeBlockType,
  onChangeBlockInfo,
  templates,
  onSaveTemplateSteps,
  onRemoveTemplate,
  crewTeams,
  onAddCrewTeam,
  onRemoveCrewTeam,
  holidays,
  onAddHoliday,
  onRemoveHoliday,
  lastSavedAt,
  syncError,
}: SettingsPanelProps) {
  const [newBlockName, setNewBlockName] = useState('');
  const [newBlockType, setNewBlockType] = useState<FacilityType>('building');
  const [newBlockInfo, setNewBlockInfo] = useState('');

  const [activeCategory, setActiveCategory] = useState(TEMPLATE_CATEGORIES[0]);
  const [stepInput, setStepInput] = useState('');
  const [stepDuration, setStepDuration] = useState('1');
  const [stepOptional, setStepOptional] = useState(false);

  const activeTemplate = templates.find((t) => t.name === activeCategory);
  const activeSteps = activeTemplate?.steps ?? [];

  const [newTeamName, setNewTeamName] = useState('');

  function addTeam() {
    const name = newTeamName.trim();
    if (!name) return;
    onAddCrewTeam(name);
    setNewTeamName('');
  }

  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayKind, setNewHolidayKind] = useState<HolidayKind>('public_holiday');

  function addHoliday() {
    if (!newHolidayDate) return;
    onAddHoliday(newHolidayDate, newHolidayKind);
    setNewHolidayDate('');
  }

  function addBlock() {
    const name = newBlockName.trim();
    if (!name) return;
    onAddBlock(name, newBlockType, newBlockInfo.trim());
    setNewBlockName('');
    setNewBlockInfo('');
  }

  function addStep() {
    const name = stepInput.trim();
    if (!name) return;
    const durationDays = Math.max(1, Number(stepDuration) || 1);
    const code = `CUSTOM_${activeCategory}_${activeSteps.length}_${name}`.replace(/\s+/g, '_');
    onSaveTemplateSteps(activeCategory, [
      ...activeSteps,
      { code, name, durationDays, optional: stepOptional || undefined },
    ]);
    setStepInput('');
    setStepDuration('1');
    setStepOptional(false);
  }

  function updateStep(idx: number, patch: Partial<TemplateStepDef>) {
    onSaveTemplateSteps(
      activeCategory,
      activeSteps.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    );
  }

  function removeStep(idx: number) {
    onSaveTemplateSteps(
      activeCategory,
      activeSteps.filter((_, i) => i !== idx),
    );
  }

  function moveStep(idx: number, dir: 'up' | 'down') {
    const target = dir === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= activeSteps.length) return;
    const next = [...activeSteps];
    [next[idx], next[target]] = [next[target], next[idx]];
    onSaveTemplateSteps(activeCategory, next);
  }

  function resetCategory() {
    if (activeTemplate) onRemoveTemplate(activeTemplate.id);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-lg max-h-[85vh] overflow-y-auto p-4 flex flex-col gap-5">
        <div className="flex items-center justify-between">
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
            {blocks.map((b) => (
              <div key={b.id} className="flex items-center gap-2 text-sm">
                <span className="w-14 shrink-0">{b.name}</span>
                <input
                  className="border border-zinc-300 rounded px-2 py-0.5 text-xs flex-1"
                  value={b.info ?? ''}
                  onChange={(e) => onChangeBlockInfo(b.id, e.target.value)}
                  placeholder="세대/층수 (예: 5세대/22층)"
                />
                <select
                  className="border border-zinc-300 rounded px-1 py-0.5 text-xs"
                  value={b.facilityType ?? 'building'}
                  onChange={(e) => onChangeBlockType(b.id, e.target.value as FacilityType)}
                >
                  <option value="building">본동</option>
                  <option value="auxiliary">부속시설</option>
                </select>
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
            <select
              className="border border-zinc-300 rounded px-1 py-1 text-xs"
              value={newBlockType}
              onChange={(e) => setNewBlockType(e.target.value as FacilityType)}
            >
              <option value="building">본동</option>
              <option value="auxiliary">부속시설</option>
            </select>
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
          <div className="flex flex-col gap-1">
            {[...holidays]
              .filter((h) => h.kind !== 'sunday')
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((h) => (
                <div key={h.date} className="flex items-center gap-2 text-sm border border-zinc-200 rounded px-2 py-1">
                  <span className="flex-1">{h.date}</span>
                  <span className="text-xs text-zinc-500">{HOLIDAY_KIND_LABEL[h.kind]}</span>
                  <button className="text-xs text-red-600" onClick={() => onRemoveHoliday(h.date)}>
                    삭제
                  </button>
                </div>
              ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              className="border border-zinc-300 rounded px-2 py-1 text-sm"
              value={newHolidayDate}
              onChange={(e) => setNewHolidayDate(e.target.value)}
            />
            <select
              className="border border-zinc-300 rounded px-2 py-1 text-sm"
              value={newHolidayKind}
              onChange={(e) => setNewHolidayKind(e.target.value as HolidayKind)}
            >
              <option value="public_holiday">공휴일</option>
              <option value="substitute_holiday">대체휴일</option>
              <option value="temporary_holiday">임시공휴일</option>
              <option value="vacation">휴가</option>
            </select>
            <button className="px-3 py-1 rounded bg-indigo-600 text-white text-sm" onClick={addHoliday}>
              추가
            </button>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-zinc-700">공정 템플릿 (기초·지하층 등)</h3>
          <p className="text-xs text-zinc-500">
            지상층(갱폼~타설)은 기존 방식 그대로이고, 여기서는 기초·지하층처럼 순서가 다른 구간의 공정 순서를
            공사종류별로 직접 정의합니다. 여기서 만든 공정은 후속 자동 재계산 없이 자유롭게 이동합니다.
          </p>

          <div className="flex flex-wrap gap-1 border-b border-zinc-200 pb-2">
            {TEMPLATE_CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setActiveCategory(c)}
                className={[
                  'px-2 py-1 rounded text-xs',
                  activeCategory === c ? 'bg-indigo-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200',
                ].join(' ')}
              >
                {c}
                {templates.some((t) => t.name === c) ? '' : ' (미설정)'}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            {activeSteps.length === 0 && (
              <p className="text-xs text-zinc-400">아직 등록된 단계가 없습니다. 아래에서 단계를 추가해주세요.</p>
            )}
            {activeSteps.map((s, idx) => (
              <div key={idx} className="flex items-center gap-2 text-xs border border-zinc-200 rounded px-2 py-1.5">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 shrink-0 font-semibold">
                  {idx + 1}
                </span>
                <span className="flex-1 min-w-0 truncate">{s.name}</span>
                <input
                  type="number"
                  min="1"
                  className="border border-zinc-300 rounded px-1 py-0.5 text-xs w-12 shrink-0"
                  value={s.durationDays}
                  onChange={(e) => updateStep(idx, { durationDays: Math.max(1, Number(e.target.value) || 1) })}
                />
                <span className="text-zinc-400 shrink-0">일</span>
                <label className="flex items-center gap-0.5 text-zinc-500 shrink-0">
                  <input
                    type="checkbox"
                    checked={!!s.optional}
                    onChange={(e) => updateStep(idx, { optional: e.target.checked || undefined })}
                  />
                  필요시
                </label>
                <button onClick={() => moveStep(idx, 'up')} disabled={idx === 0}>
                  ▲
                </button>
                <button onClick={() => moveStep(idx, 'down')} disabled={idx === activeSteps.length - 1}>
                  ▼
                </button>
                <button className="text-red-600" onClick={() => removeStep(idx)}>
                  삭제
                </button>
              </div>
            ))}

            <div className="flex items-center gap-2 pt-1 border-t border-zinc-200">
              <input
                className="border border-zinc-300 rounded px-2 py-1 text-sm flex-1"
                value={stepInput}
                onChange={(e) => setStepInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addStep();
                }}
                placeholder="공정 단계 이름 (예: 터파기)"
              />
              <input
                type="number"
                min="1"
                className="border border-zinc-300 rounded px-2 py-1 text-sm w-14 shrink-0"
                value={stepDuration}
                onChange={(e) => setStepDuration(e.target.value)}
                placeholder="일수"
              />
              <label className="flex items-center gap-1 text-xs shrink-0">
                <input type="checkbox" checked={stepOptional} onChange={(e) => setStepOptional(e.target.checked)} />
                필요시
              </label>
              <button className="px-2 py-1 rounded border border-zinc-300 text-sm" onClick={addStep}>
                단계 추가
              </button>
            </div>

            {activeTemplate && (
              <button className="self-end text-xs text-red-600" onClick={resetCategory}>
                이 공사종류 전체 초기화
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
