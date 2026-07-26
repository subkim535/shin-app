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
