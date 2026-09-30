// 国际发行回执合并相关类型定义

export interface WorkMaster {
  id: string
  title: string
  type: string
  regions: string[]
}

export interface ReceiptPage {
  pageNo: number
  label: string
  present: boolean
}

export interface ReceiptTerms {
  start: string
  end: string
  exclusive: boolean
  sublicense: boolean
}

export interface ContractReceipt {
  id: string
  workId: string
  region: string
  batchId: string
  channel: string
  rights: string
  baseVersion: number
  pages: ReceiptPage[]
  terms: ReceiptTerms
  materialPackageId: string
  status: '待合并' | '已合并' | '异常'
  receivedAt: string
}

export interface ReceiptBatch {
  id: string
  workId: string
  regions: string[]
  receivedAt: string
  status: '待合并' | '已合并' | '异常'
}

export interface DraftWindow {
  id: string
  workId: string
  work: string
  channel: string
  rights: string
  territory: string
  start: string
  end: string
  exclusive: boolean
  sublicense: boolean
  status: '草案' | '已确认'
}

export interface MaterialPackage {
  id: string
  workId: string
  region: string
  items: string[]
  status: '有效' | '已失效'
}

export interface ApprovalSnapshot {
  workId: string
  version: number
  status: '有效' | '已失效'
  confirmedAt: string
  termsHash: string
}

export interface IssuanceVersion {
  id: string
  version: number
  author: string
  time: string
  summary: string
  changes: string[]
}

export interface MissingPage {
  receiptId: string
  pageNo: number
  label: string
}

export interface SnapshotDiff {
  workId: string
  region: string
  field: string
  expected: string
  actual: string
}

export type MergeResult =
  | { ok: true; batchId: string; applied: string[]; invalidated: boolean; newVersion: number }
  | {
      ok: false
      batchId: string
      reason: '缺页' | '快照不符'
      missingPages?: MissingPage[]
      diffs?: SnapshotDiff[]
      retryable: true
    }

export type ConfirmResult =
  | { ok: true; version: number }
  | { ok: false; conflict: true; expected: number; current: number }
