import type {
  ApprovalSnapshot,
  ExclusivityScope,
  MaterialItem,
  PageCode,
  ReceiptBatch,
  ReceiptPage,
  ReceiptPagePayload,
  ReceiptWindow,
  TermDiff,
  WindowTerm,
} from './types'
import { REQUIRED_PAGES } from './types'

/* ------------------------------- 内容指纹 ------------------------------- */

/** 规范化 JSON：键排序 + 无多余空白，保证同样条款指纹相同 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** FNV-1a 32 位指纹，足够演示阶段做审批快照对账 */
export function digestOf(value: unknown): string {
  const text = canonicalJson(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const digestWindows = (w: ReceiptWindow[]): string => digestOf(w)
const digestExclusivity = (ex: ExclusivityScope): string => digestOf(ex)
const digestMaterials = (items: MaterialItem[]): string => digestOf(items)

export function snapshotDigests(snapshot: Pick<ApprovalSnapshot, 'windows' | 'exclusivity' | 'materials'>) {
  return { windowDigest: digestWindows(snapshot.windows), exclusivityDigest: digestExclusivity(snapshot.exclusivity), materialDigest: digestMaterials(snapshot.materials) }
}

export function materialDigestOf(items: MaterialItem[]): string {
  return digestMaterials(items)
}

function pageExpectedDigest(page: ReceiptPage, snapshot: ApprovalSnapshot | null, baseline: AuditBaseline): string {
  if (page.code === '窗口页') return snapshot?.valid ? snapshot.windowDigest : baseline.windowDigest
  if (page.code === '独占范围页') return snapshot?.valid ? snapshot.exclusivityDigest : baseline.exclusivityDigest
  return baseline.materialDigest
}

function pageOwnDigest(page: ReceiptPage): string | null {
  if (page.code === '窗口页') return digestWindows(page.payload?.windows ?? [])
  if (page.code === '独占范围页') return digestExclusivity(page.payload?.exclusivity as ExclusivityScope)
  return digestMaterials(page.payload?.materials ?? [])
}

/** 回填页指纹（构造种子数据时只写 payload 即可） */
export function normalizePages(pages: ReceiptPage[]): ReceiptPage[] {
  return pages.map((page) => ({ ...page, digest: page.present ? pageOwnDigest(page) : null }))
}

/* -------------------------------- 差异计算 -------------------------------- */

const sameWindow = (a: ReceiptWindow, b: ReceiptWindow) => a.channel === b.channel && a.rights === b.rights

export function diffWindows(before: ReceiptWindow[], after: ReceiptWindow[]): TermDiff[] {
  const diffs: TermDiff[] = []
  after.forEach((win) => {
    const old = before.find((item) => sameWindow(item, win))
    if (!old) {
      diffs.push({ kind: '窗口', target: `${win.channel} · ${win.rights}`, field: '窗口', before: '（无）', after: `${win.start} → ${win.end}` })
      return
    }
    if (old.start !== win.start) diffs.push({ kind: '窗口', target: `${win.channel} · ${win.rights}`, field: '开始日期', before: old.start, after: win.start })
    if (old.end !== win.end) diffs.push({ kind: '窗口', target: `${win.channel} · ${win.rights}`, field: '结束日期', before: old.end, after: win.end })
  })
  before.forEach((win) => {
    if (!after.some((item) => sameWindow(item, win))) diffs.push({ kind: '窗口', target: `${win.channel} · ${win.rights}`, field: '窗口', before: `${win.start} → ${win.end}`, after: '（删除）' })
  })
  return diffs
}

export function diffExclusivity(before: ExclusivityScope, after: ExclusivityScope): TermDiff[] {
  const diffs: TermDiff[] = []
  if (before.exclusive !== after.exclusive) diffs.push({ kind: '独占范围', target: '独占标记', field: '是否独占', before: String(before.exclusive), after: String(after.exclusive) })
  ;(['channels', 'languages', 'subTerritories'] as const).forEach((field) => {
    const label = field === 'channels' ? '独占渠道' : field === 'languages' ? '独占语言' : '独占子地区'
    const left = before[field].join('、') || '（无）'
    const right = after[field].join('、') || '（无）'
    if (left !== right) diffs.push({ kind: '独占范围', target: label, field: label, before: left, after: right })
  })
  return diffs
}

const materialKey = (item: MaterialItem) => `${item.code}`

export function diffMaterials(before: MaterialItem[], after: MaterialItem[]): TermDiff[] {
  const diffs: TermDiff[] = []
  after.forEach((item) => {
    const old = before.find((candidate) => materialKey(candidate) === materialKey(item))
    if (!old) diffs.push({ kind: '物料', target: `${item.code} ${item.name}`, field: '物料', before: '（无）', after: `${item.locale}` })
  })
  before.forEach((item) => {
    if (!after.some((candidate) => materialKey(candidate) === materialKey(item))) diffs.push({ kind: '物料', target: `${item.code} ${item.name}`, field: '物料', before: item.locale, after: '（删除）' })
  })
  return diffs
}

/* ----------------------------- 批次 vs 审批快照 ----------------------------- */

export interface AuditBaseline {
  /** 当前草案窗口指纹（无有效快照时作为对账基线） */
  windowDigest: string
  /** 当前草案独占范围指纹 */
  exclusivityDigest: string
  /** 当前物料包指纹 */
  materialDigest: string
  windows: ReceiptWindow[]
  exclusivity: ExclusivityScope
  materials: MaterialItem[]
}

export interface BatchAudit {
  missingPages: PageCode[]
  /** 与审批快照不一致的页（仅窗口页 / 独占范围页会阻断；缺页不计入） */
  mismatchPages: PageCode[]
  diffs: TermDiff[]
  /** 物料差异仅作告知：物料包独立更新，不阻断合并、不使审批失效 */
  materialDiffs: TermDiff[]
}

/**
 * 对账：缺页 → 整单中止。
 * 窗口页 / 独占范围页对照有效审批快照（快照已失效则对照当前草案条款），
 * 不一致即阻断并列出字段级差异，须操作员显式接受差异后才能重试；
 * 物料清单页永远不阻断——物料包可以随回执独立更新。
 * requireMatch=false（全新地区、从未审批）时只查缺页。
 */
export function auditBatch(batch: ReceiptBatch, snapshot: ApprovalSnapshot | null, baseline: AuditBaseline, requireMatch = true): BatchAudit {
  const present = new Map(batch.pages.map((page) => [page.code, page]))
  const missingPages = REQUIRED_PAGES.filter((code) => !present.get(code)?.present)
  if (missingPages.length) return { missingPages, mismatchPages: [], diffs: [], materialDiffs: [] }

  const mismatchPages: PageCode[] = []
  const diffs: TermDiff[] = []
  if (requireMatch) {
    const winPage = present.get('窗口页')
    const exPage = present.get('独占范围页')
    if (winPage && winPage.digest !== pageExpectedDigest(winPage, snapshot, baseline)) mismatchPages.push('窗口页')
    if (exPage && exPage.digest !== pageExpectedDigest(exPage, snapshot, baseline)) mismatchPages.push('独占范围页')
    if (winPage && mismatchPages.includes('窗口页')) diffs.push(...diffWindows(snapshot?.valid ? snapshot.windows : baseline.windows, winPage.payload?.windows ?? []))
    if (exPage && mismatchPages.includes('独占范围页')) diffs.push(...diffExclusivity(snapshot?.valid ? snapshot.exclusivity : baseline.exclusivity, exPage.payload?.exclusivity as ExclusivityScope))
  }
  const matPage = present.get('物料清单页')
  const materialDiffs = matPage ? diffMaterials(baseline.materials, matPage.payload?.materials ?? []) : []
  return { missingPages, mismatchPages, diffs, materialDiffs }
}

/* -------------------------------- 条款合并 -------------------------------- */

/** 同渠道同权利类型的窗口视为同一条：回执覆盖日期，新渠道追加，回执里没有的保留。 */
export function mergeWindows(current: WindowTerm[], incoming: ReceiptWindow[], idPrefix: string): WindowTerm[] {
  const result = current.map((win) => ({ ...win }))
  incoming.forEach((incomingWindow) => {
    const index = result.findIndex((win) => win.channel === incomingWindow.channel && win.rights === incomingWindow.rights)
    if (index >= 0) result[index] = { ...result[index]!, start: incomingWindow.start, end: incomingWindow.end }
    else result.push({ id: `${idPrefix}-W${result.length + 1}`, ...incomingWindow })
  })
  return result
}

export function mergeMaterials(current: MaterialItem[], incoming: MaterialItem[]): MaterialItem[] {
  const result = [...current]
  incoming.forEach((item) => {
    const index = result.findIndex((candidate) => candidate.code === item.code)
    if (index >= 0) result[index] = item
    else result.push(item)
  })
  return result
}

export function windowsDigestOf(windows: WindowTerm[]): string {
  const plain: ReceiptWindow[] = windows.map(({ channel, rights, start, end }) => ({ channel, rights, start, end }))
  return digestWindows(plain)
}

export function exclusivityDigestOf(exclusivity: ExclusivityScope): string {
  return digestExclusivity(exclusivity)
}

export function payloadOfPage(page: ReceiptPage): ReceiptPagePayload {
  return page.payload ?? {}
}
