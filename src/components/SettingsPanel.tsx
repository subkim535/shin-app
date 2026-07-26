'use client';

import { useState } from 'react';
import { Block, FacilityType, ProcessTemplate, SiteInfo } from '@/lib/domain/types';

interface SettingsPanelProps {
  onClose: () => void;
  siteInfo: SiteInfo;
  onChangeSiteInfo: (info: SiteInfo) => void;
  blocks: Block[];
  onAddBlock: (name: string, facilityType: FacilityType) => void;
  onRemoveBlock: (id: string) => void;
  onChangeBlockType: (id: string, facilityType: FacilityType) => void;
  templates: ProcessTemplate[];
  onAddTemplate: (template: ProcessTemplate) => void;
  onRemoveTemplate: (id: string) => void;
}

export default function SettingsPanel({
  onClose,
  siteInfo,
  onChangeSiteInfo,
  blocks,
  onAddBlock,
  onRemoveBlock,
  onChangeBlockType,
  templates,
  onAddTemplate,
  onRemoveTemplate,
}: SettingsPanelProps) {
  const [newBlockName, setNewBlockName] = useState('');
  const [newBlockType, setNewBlockType] = useState<FacilityType>('building');

  const [templateName, setTemplateName] = useState('');
  const [templateSteps, setTemplateSteps] = useState<string[]>([]);
  const [stepInput, setStepInput] = useState('');

  function addBlock() {
    const name = newBlockName.trim();
    if (!name) return;
    onAddBlock(name, newBlockType);
    setNewBlockName('');
  }

  function addStep() {
    const name = stepInput.trim();
    if (!name) return;
    setTemplateSteps((s) => [...s, name]);
    setStepInput('');
  }

  function removeStep(idx: number) {
    setTemplateSteps((s) => s.filter((_, i) => i !== idx));
  }

  function moveStep(idx: number, dir: 'up' | 'down') {
    setTemplateSteps((s) => {
      const next = [...s];
      const target = dir === 'up' ? idx - 1 : idx + 1;
      if (target < 0 || target >= next.length) return s;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  function saveTemplate() {
    const name = templateName.trim();
    if (!name || templateSteps.length === 0) return;
    onAddTemplate({
      id: crypto.randomUUID(),
      name,
      steps: templateSteps.map((s, i) => ({ code: `CUSTOM_${name}_${i}_${s}`.replace(/\s+/g, '_'), name: s })),
    });
    setTemplateName('');
    setTemplateSteps([]);
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
                <span className="flex-1">{b.name}</span>
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
          <h3 className="text-sm font-semibold text-zinc-700">공정 템플릿 (기초·지하층 등)</h3>
          <p className="text-xs text-zinc-500">
            지상층(갱폼~타설)은 기존 방식 그대로이고, 여기서는 기초·지하층처럼 순서가 다른 구간의 공정 순서를
            직접 정의합니다. 이 템플릿으로 만든 공정은 후속 자동 재계산 없이 자유롭게 이동합니다.
          </p>
          <div className="flex flex-col gap-1">
            {templates.map((t) => (
              <div key={t.id} className="flex items-center gap-2 text-sm border border-zinc-200 rounded px-2 py-1">
                <span className="flex-1">
                  <strong>{t.name}</strong>
                  <span className="text-zinc-500"> — {t.steps.map((s) => s.name).join(' → ')}</span>
                </span>
                <button className="text-xs text-red-600" onClick={() => onRemoveTemplate(t.id)}>
                  삭제
                </button>
              </div>
            ))}
          </div>

          <div className="border border-zinc-200 rounded p-2 flex flex-col gap-2">
            <input
              className="border border-zinc-300 rounded px-2 py-1 text-sm"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="템플릿 이름 (예: 기초, 지하층)"
            />
            <div className="flex flex-col gap-1">
              {templateSteps.map((s, idx) => (
                <div key={idx} className="flex items-center gap-2 text-xs">
                  <span className="w-4 text-zinc-400">{idx + 1}</span>
                  <span className="flex-1">{s}</span>
                  <button onClick={() => moveStep(idx, 'up')} disabled={idx === 0}>
                    ▲
                  </button>
                  <button onClick={() => moveStep(idx, 'down')} disabled={idx === templateSteps.length - 1}>
                    ▼
                  </button>
                  <button className="text-red-600" onClick={() => removeStep(idx)}>
                    삭제
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                className="border border-zinc-300 rounded px-2 py-1 text-sm flex-1"
                value={stepInput}
                onChange={(e) => setStepInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addStep();
                }}
                placeholder="공정 단계 이름 (예: 터파기)"
              />
              <button className="px-2 py-1 rounded border border-zinc-300 text-sm" onClick={addStep}>
                단계 추가
              </button>
            </div>
            <button
              className="self-end px-3 py-1 rounded bg-indigo-600 text-white text-sm disabled:opacity-40"
              onClick={saveTemplate}
              disabled={!templateName.trim() || templateSteps.length === 0}
            >
              템플릿 저장
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
