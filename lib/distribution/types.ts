import type { RightsType, Territory } from '@/lib/types'

/** 合同回执必到的三页：窗口页、独占范围页、物料清单页 */
export type PageCode = '窗口页' | '独占范围页' | '物料清单页'
export const REQUIRED_PAGES: PageCode[] = ['窗口页', '独占范围页', '物料清单页']

export interface ReceiptWindow {
  channel: string
  rights: RightsType
  start: string
  end: string
}

export interface WindowTerm extends ReceiptWindow {
  id: string
}

/** 独占范围：独占标记 + 独占渠道 / 语言 / 子地区三维范围 */
export interface ExclusivityScope {
  exclusive: boolean
  channels: string[]
  languages: string[]
  subTerritories: string[]
}

export interface MaterialItem {
  code: string
  name: string
  locale: string
}

export interface ReceiptPagePayload {
  windows?: ReceiptWindow[]
  exclusivity?: ExclusivityScope
  materials?: MaterialItem[]
}

export interface ReceiptPage {
  code: PageCode
  present: boolean
  /** 内容指纹；缺页时为 null，用于与审批快照指纹比对 */
  digest: string | null
  payload?: ReceiptPagePayload
}

export type BatchStatus = '待处理' | '已合并' | '合并失败'

export interface ReceiptBatch {
  id: string
  workId: string
  work: string
  territory: Territory
  source: string
  receivedAt: string
  pages: ReceiptPage[]
  status: BatchStatus
  attempts: number
  lastError: string | null
  mergedDraftId: string | null
  mergedVersion: number | null
}

export interface ApprovalSnapshot {
  id: string
  version: number
  approver: string
  approvedAt: string
  windows: ReceiptWindow[]
  exclusivity: ExclusivityScope
  materials: MaterialItem[]
  windowDigest: string
  exclusivityDigest: string
  materialDigest: string
  valid: boolean
  invalidatedAt: string | null
  invalidatedReason: string | null
}

export interface MaterialPackage {
  id: string
  items: MaterialItem[]
  digest: string
  status: '有效' | '已失效' | '待确认'
  snapshotVersion: number | null
  updatedAt: string
}

export type DraftStatus = '待审批' | '已确认' | '待重新确认'

export interface DistributionDraft {
  id: string
  workId: string
  work: string
  territory: Territory
  windows: WindowTerm[]
  exclusivity: ExclusivityScope
  materials: MaterialItem[]
  version: number
  status: DraftStatus
  snapshot: ApprovalSnapshot | null
  materialPackage: MaterialPackage
  updatedAt: string
}

export type DiffKind = '窗口' | '独占范围' | '物料'

export interface TermDiff {
  kind: DiffKind
  target: string
  field: string
  before: string
  after: string
}

export interface BatchFailure {
  batchId: string
  work: string
  territory: Territory
  missingPages: PageCode[]
  diffs: TermDiff[]
  materialDiffs: TermDiff[]
}

/** 草案的每个历史版本完整留档，可按版本查回条款 */
export interface DraftVersionRecord {
  draftId: string
  version: number
  time: string
  actor: string
  note: string
  windows: WindowTerm[]
  exclusivity: ExclusivityScope
  materials: MaterialItem[]
  status: DraftStatus
}

export interface HistoryEntry {
  id: string
  time: string
  kind: '草案建立' | '回执合并' | '审批确认' | '快照失效' | '合并失败' | '缺页补齐'
  actor: string
  draftId: string | null
  work: string
  territory: Territory | null
  summary: string
  details: string[]
  batchIds: string[]
}

export interface WorkTableRow {
  workId: string
  work: string
  draftCount: number
  territories: Territory[]
  windowCount: number
  pendingReceipts: number
  failedReceipts: number
  mergedReceipts: number
  status: '已确认' | '待重新确认' | '待审批' | '无草案'
}

export interface MergedGroup {
  draftId: string
  workId: string
  territory: Territory
  newDraft: boolean
  fromVersion: number | null
  version: number
  windowChanged: boolean
  exclusivityChanged: boolean
  materialsChanged: boolean
  invalidated: boolean
  batchIds: string[]
}

export type MergeResult =
  | { ok: true; merged: MergedGroup[] }
  | { ok: false; code: 'MISSING_PAGES' | 'SNAPSHOT_MISMATCH'; message: string; failures: BatchFailure[] }
