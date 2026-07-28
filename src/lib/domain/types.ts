import { ISODate } from './dateUtils';

export type ProcessCategory = 'main' | 'sub';

export interface ProcessTypeDef {
  code: string;
  name: string;
  category: ProcessCategory;
  mainSequence?: number; // 1..5, main only
  showFloorLabel?: boolean;
}

export type FacilityType = 'building' | 'auxiliary';

export interface Block {
  id: string;
  name: string;
  sortOrder: number;
  facilityType?: FacilityType; // 본동(building, 기본) / 부속시설(auxiliary)
  info?: string; // 세대/층수 등 자유텍스트 (예: "5세대/22층")
  remark?: string; // 동 단위 비고 (날짜와 무관, 오른쪽 고정 열에 표시)
}

export interface SiteInfo {
  name: string;
  overview: string;
}

// 기초/지하층 등 지상층과 순서가 다른 구간을 위한 커스텀 공정 템플릿.
// 지상층(갱폼~타설)은 전용 엔진을 계속 쓰고, 커스텀 템플릿은 이 단순 순차 스텝만 지원한다.
export interface TemplateStepDef {
  code: string;
  name: string;
}

export interface ProcessTemplate {
  id: string;
  name: string;
  steps: TemplateStepDef[];
}

export interface DateShiftRecord {
  id: string;
  fromDate: ISODate;
  deltaDays: number;
  reason: string;
  at: string; // ISO datetime
}

// 특정 공정에 딸린 협력사 작업팀 배정 (작업일보의 "작업내용" 항목에 쓰인다).
export interface CrewAssignment {
  team: string;
  headcount: number;
}

// 설정에서 미리 등록해두는 작업팀 목록 — 공정에 배정할 때 매번 입력하지 않고 여기서 고른다.
export interface CrewTeam {
  id: string;
  name: string;
}

// 공정표에 안 묶이는 직영(자체) 인력 작업 — 날짜 단위로 자유롭게 추가/삭제한다.
export interface DirectLaborEntry {
  id: string;
  date: ISODate;
  category: string; // 구분 (예: 공사, 안전, 견출 등 — DailyReportModal의 프리셋 목록에서 선택)
  workContent: string;
  headcount: number;
}

// Supabase에 JSONB 하나로 저장/동기화하는 전체 상태.
export interface AppState {
  siteInfo: SiteInfo;
  blocks: Block[];
  templates: ProcessTemplate[];
  holidays: Holiday[];
  processes: ProcessInstance[];
  changeHistory: ChangeRecord[];
  dateShiftHistory: DateShiftRecord[];
  notes: Record<string, string>;
  directLabor: DirectLaborEntry[];
  crewTeams: CrewTeam[];
}

export interface ProcessInstance {
  id: string;
  blockId: string;
  typeCode: string;
  date: ISODate;
  floorLabel?: string;
  linkedMainProcessId?: string; // sub -> owning main process
  cycleId: string; // 하나의 기준층 생성 호출로 만들어진 주요/보조공정 묶음 (같은 동에 여러 층 사이클이 동시에 흐를 수 있음)
  customLabel?: string; // 커스텀 템플릿(기초·지하층 등)으로 만든 공정의 이름 (PROCESS_TYPE_MAP에 없는 코드일 때 사용)
  conflictGroup?: string; // 같은 날짜·같은 공종이 여러 동에서 겹칠 때의 그룹 (기존 충돌순번용)
  conflictSeq?: number;
  cellOrder?: number; // 같은 동·같은 날짜에 서로 다른 주요공정이 함께 놓였을 때의 수동 작업 순서
  crew?: CrewAssignment; // 작업팀 + 투입인원
}

export interface ChangeRecord {
  id: string;
  processId: string;
  previousDate: ISODate;
  newDate: ISODate;
  reason: string;
}

export type HolidayKind = 'sunday' | 'public_holiday' | 'substitute_holiday' | 'temporary_holiday';

export interface Holiday {
  date: ISODate;
  kind: HolidayKind;
}
