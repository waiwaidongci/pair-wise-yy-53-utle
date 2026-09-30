// 国际发行回执合并 · 服务端内存存储与核心逻辑
// 合并为原子操作：整批回执要么全部并入草案，要么全部保留原批次并列出差异。
// 窗口或独占范围一旦变化，旧审批快照与物料包立即失效，须重新确认。

import type {
  ApprovalSnapshot,
  ConfirmResult,
  ContractReceipt,
  DraftWindow,
  IssuanceVersion,
  MaterialPackage,
  MergeResult,
  MissingPage,
  ReceiptBatch,
  SnapshotDiff,
  WorkMaster,
} from '@/lib/issuance-types'

// ---- 作品总表 ----
export const works: WorkMaster[] = [
  { id: 'W-001', title: '《远山回声》', type: '电影', regions: ['中国大陆', '中国香港', '中国台湾', '新加坡'] },
  { id: 'W-002', title: '《深港口岸》', type: '剧集', regions: ['新加坡', '马来西亚', '东南亚区域'] },
]

// ---- 发行草案窗口（按作品 + 地区归并）----
export let draftWindows: DraftWindow[] = [
  { id: 'DW-001', workId: 'W-001', work: '《远山回声》', channel: '星海影院', rights: '院线', territory: '中国大陆', start: '2026-10-18', end: '2026-12-05', exclusive: true, sublicense: false, status: '已确认' },
  { id: 'DW-002', workId: 'W-001', work: '《远山回声》', channel: '云帆视频', rights: '流媒体', territory: '中国大陆', start: '2026-11-20', end: '2027-11-19', exclusive: true, sublicense: false, status: '已确认' },
  { id: 'DW-003', workId: 'W-001', work: '《远山回声》', channel: '云帆视频', rights: '流媒体', territory: '中国香港', start: '2026-12-01', end: '2027-11-30', exclusive: false, sublicense: false, status: '已确认' },
  { id: 'DW-004', workId: 'W-001', work: '《远山回声》', channel: '云帆视频', rights: '流媒体', territory: '中国台湾', start: '2026-12-01', end: '2027-11-30', exclusive: false, sublicense: false, status: '已确认' },
  { id: 'DW-005', workId: 'W-001', work: '《远山回声》', channel: '南华卫视', rights: '电视', territory: '新加坡', start: '2027-01-15', end: '2027-07-14', exclusive: false, sublicense: true, status: '已确认' },
  { id: 'DW-006', workId: 'W-002', work: '《深港口岸》', channel: '云帆视频', rights: '流媒体', territory: '新加坡', start: '2026-12-01', end: '2027-05-31', exclusive: true, sublicense: false, status: '已确认' },
  { id: 'DW-007', workId: 'W-002', work: '《深港口岸》', channel: '海岛航空', rights: '航空', territory: '马来西亚', start: '2027-01-15', end: '2027-07-14', exclusive: false, sublicense: true, status: '已确认' },
]

// ---- 合同回执（多地区）----
export let receipts: ContractReceipt[] = [
  // B-2026-091：W-001 中国大陆 / 中国香港 / 中国台湾（台湾缺页）
  { id: 'R-001', workId: 'W-001', region: '中国大陆', batchId: 'B-2026-091', channel: '星海影院', rights: '院线', baseVersion: 18, receivedAt: '2026-09-28', materialPackageId: 'MP-001', status: '待合并',
    pages: [{ pageNo: 1, label: '授权条款页', present: true }, { pageNo: 2, label: '独占范围页', present: true }, { pageNo: 3, label: '物料清单页', present: true }],
    terms: { start: '2026-10-18', end: '2026-12-05', exclusive: true, sublicense: false } },
  { id: 'R-002', workId: 'W-001', region: '中国香港', batchId: 'B-2026-091', channel: '云帆视频', rights: '流媒体', baseVersion: 18, receivedAt: '2026-09-28', materialPackageId: 'MP-002', status: '待合并',
    pages: [{ pageNo: 1, label: '授权条款页', present: true }, { pageNo: 2, label: '独占范围页', present: true }, { pageNo: 3, label: '物料清单页', present: true }],
    terms: { start: '2026-12-01', end: '2027-11-30', exclusive: false, sublicense: false } },
  { id: 'R-003', workId: 'W-001', region: '中国台湾', batchId: 'B-2026-091', channel: '云帆视频', rights: '流媒体', baseVersion: 18, receivedAt: '2026-09-28', materialPackageId: 'MP-003', status: '待合并',
    pages: [{ pageNo: 1, label: '授权条款页', present: true }, { pageNo: 2, label: '独占范围页', present: true }, { pageNo: 3, label: '物料清单页', present: false }],
    terms: { start: '2026-12-01', end: '2027-11-30', exclusive: false, sublicense: false } },
  // B-2026-092：W-001 新加坡（回执基于旧版 v17，与当前审批快照不符）
  { id: 'R-004', workId: 'W-001', region: '新加坡', batchId: 'B-2026-092', channel: '南华卫视', rights: '电视', baseVersion: 17, receivedAt: '2026-09-27', materialPackageId: 'MP-004', status: '待合并',
    pages: [{ pageNo: 1, label: '授权条款页', present: true }, { pageNo: 2, label: '独占范围页', present: true }, { pageNo: 3, label: '物料清单页', present: true }],
    terms: { start: '2027-02-01', end: '2027-08-15', exclusive: false, sublicense: true } },
  // B-2026-093：W-002 新加坡（窗口变化）/ 马来西亚（一致）
  { id: 'R-005', workId: 'W-002', region: '新加坡', batchId: 'B-2026-093', channel: '云帆视频', rights: '流媒体', baseVersion: 18, receivedAt: '2026-09-28', materialPackageId: 'MP-005', status: '待合并',
    pages: [{ pageNo: 1, label: '授权条款页', present: true }, { pageNo: 2, label: '独占范围页', present: true }, { pageNo: 3, label: '物料清单页', present: true }],
    terms: { start: '2026-12-15', end: '2027-06-15', exclusive: true, sublicense: false } },
  { id: 'R-006', workId: 'W-002', region: '马来西亚', batchId: 'B-2026-093', channel: '海岛航空', rights: '航空', baseVersion: 18, receivedAt: '2026-09-28', materialPackageId: 'MP-006', status: '待合并',
    pages: [{ pageNo: 1, label: '授权条款页', present: true }, { pageNo: 2, label: '独占范围页', present: true }, { pageNo: 3, label: '物料清单页', present: true }],
    terms: { start: '2027-01-15', end: '2027-07-14', exclusive: false, sublicense: true } },
]

// ---- 回执批次 ----
export let batches: ReceiptBatch[] = [
  { id: 'B-2026-091', workId: 'W-001', regions: ['中国大陆', '中国香港', '中国台湾'], receivedAt: '2026-09-28', status: '待合并' },
  { id: 'B-2026-092', workId: 'W-001', regions: ['新加坡'], receivedAt: '2026-09-27', status: '待合并' },
  { id: 'B-2026-093', workId: 'W-002', regions: ['新加坡', '马来西亚'], receivedAt: '2026-09-28', status: '待合并' },
]

// ---- 物料包（按地区）----
export let materialPackages: MaterialPackage[] = [
  { id: 'MP-001', workId: 'W-001', region: '中国大陆', items: ['普通话版海报', '预告片 30s', '地区标识'], status: '有效' },
  { id: 'MP-002', workId: 'W-001', region: '中国香港', items: ['粤语版海报', '预告片 30s', '地区标识'], status: '有效' },
  { id: 'MP-003', workId: 'W-001', region: '中国台湾', items: ['国语版海报', '预告片 30s', '地区标识'], status: '有效' },
  { id: 'MP-004', workId: 'W-001', region: '新加坡', items: ['英文版海报', '预告片 30s', '地区标识'], status: '有效' },
  { id: 'MP-005', workId: 'W-002', region: '新加坡', items: ['英文版海报', '预告片 30s', '地区标识'], status: '有效' },
  { id: 'MP-006', workId: 'W-002', region: '马来西亚', items: ['马来语版海报', '预告片 30s', '地区标识'], status: '有效' },
]

// ---- 草案版本号（乐观锁）----
export let draftVersion = 18

export function computeTermsHash(workId: string): string {
  const terms = draftWindows
    .filter((w) => w.workId === workId)
    .map((w) => `${w.territory}|${w.start}|${w.end}|${w.exclusive}`)
    .sort()
    .join(';')
  let h = 0
  for (let i = 0; i < terms.length; i += 1) h = (h * 31 + terms.charCodeAt(i)) | 0
  return `h${(h >>> 0).toString(16)}`
}

// 快照是否仍有效：该作品当前条款哈希与快照条款哈希一致才有效
export function isSnapshotValid(workId: string): boolean {
  const snap = snapshots[workId]
  return !!snap && snap.termsHash === computeTermsHash(workId)
}

// ---- 审批快照（按作品）----
export let snapshots: Record<string, ApprovalSnapshot> = {
  'W-001': { workId: 'W-001', version: 18, status: '有效', confirmedAt: '2026-09-28 16:35', termsHash: computeTermsHash('W-001') },
  'W-002': { workId: 'W-002', version: 18, status: '有效', confirmedAt: '2026-09-28 16:35', termsHash: computeTermsHash('W-002') },
}

// ---- 历史版本 ----
export let versions: IssuanceVersion[] = [
  { id: 'v18', version: 18, author: '章宁', time: '今天 16:35', summary: '调整《远山回声》流媒体窗口并增加港台地区', changes: ['RW-102 开窗日期由 11-15 调整为 11-20', '新增流媒体中国香港、中国台湾窗口', '独占范围拆分与宣传物料条件'] },
  { id: 'v17', version: 17, author: '黎清', time: '今天 14:08', summary: '补充院线优先权和次级授权限制', changes: ['院线窗口优先级提升为 1', '电视窗口禁止提前点映', '转授权增加地区与时长限制'] },
]

// ---- 内部工具 ----
function workTitle(workId: string): string {
  return works.find((w) => w.id === workId)?.title ?? ''
}

function invalidateForWork(workId: string) {
  if (snapshots[workId]) snapshots[workId]!.status = '已失效'
  for (const mp of materialPackages) if (mp.workId === workId) mp.status = '已失效'
}

function bumpVersion(summary: string, changes: string[]) {
  draftVersion += 1
  versions.unshift({ id: `v${draftVersion}`, version: draftVersion, author: '系统', time: '刚刚', summary, changes })
}

// ---- 原子合并：整批回执并入同一份发行草案 ----
export function mergeBatch(batchId: string): MergeResult {
  const batch = batches.find((b) => b.id === batchId)
  if (!batch) throw new Error(`批次 ${batchId} 不存在`)
  const batchReceipts = receipts.filter((r) => r.batchId === batchId)
  if (batchReceipts.length === 0) throw new Error(`批次 ${batchId} 无回执`)

  // 1. 缺页校验：任一回执缺页则整批不并入，保留原批次并列出差异
  const missingPages: MissingPage[] = []
  for (const r of batchReceipts) {
    for (const p of r.pages) {
      if (!p.present) missingPages.push({ receiptId: r.id, pageNo: p.pageNo, label: p.label })
    }
  }
  if (missingPages.length > 0) {
    return { ok: false, batchId, reason: '缺页', missingPages, retryable: true }
  }

  // 2. 快照不符校验：回执基于旧版草案（baseVersion 落后）时，与当前审批快照不符
  const diffs: SnapshotDiff[] = []
  for (const r of batchReceipts) {
    if (r.baseVersion !== draftVersion) {
      const current = draftWindows.find((w) => w.workId === r.workId && w.territory === r.region)
      if (current) {
        if (current.start !== r.terms.start) diffs.push({ workId: r.workId, region: r.region, field: '开始日期', expected: current.start, actual: r.terms.start })
        if (current.end !== r.terms.end) diffs.push({ workId: r.workId, region: r.region, field: '结束日期', expected: current.end, actual: r.terms.end })
        if (current.exclusive !== r.terms.exclusive) diffs.push({ workId: r.workId, region: r.region, field: '独占范围', expected: current.exclusive ? '独占' : '非独占', actual: r.terms.exclusive ? '独占' : '非独占' })
      }
    }
  }
  if (diffs.length > 0) {
    return { ok: false, batchId, reason: '快照不符', diffs, retryable: true }
  }

  // 3. 整批并入（原子：全部成功才落库）
  let changed = false
  for (const r of batchReceipts) {
    const idx = draftWindows.findIndex((w) => w.workId === r.workId && w.territory === r.region)
    if (idx >= 0) {
      const w = draftWindows[idx]!
      if (w.start !== r.terms.start || w.end !== r.terms.end || w.exclusive !== r.terms.exclusive || w.sublicense !== r.terms.sublicense) {
        draftWindows[idx] = { ...w, start: r.terms.start, end: r.terms.end, exclusive: r.terms.exclusive, sublicense: r.terms.sublicense, status: '草案' }
        changed = true
      }
    } else {
      draftWindows.push({
        id: `DW-${r.id}`, workId: r.workId, work: workTitle(r.workId), channel: r.channel, rights: r.rights,
        territory: r.region, start: r.terms.start, end: r.terms.end, exclusive: r.terms.exclusive, sublicense: r.terms.sublicense, status: '草案',
      })
      changed = true
    }
    r.status = '已合并'
  }
  batch.status = '已合并'

  // 4. 窗口或独占范围变化 → 旧审批快照与物料包立即失效
  let invalidated = false
  if (changed) {
    invalidated = true
    invalidateForWork(batch.workId)
    bumpVersion(`合并回执批次 ${batchId}`, batchReceipts.map((r) => `${r.region} 回执并入发行草案`))
  }

  return { ok: true, batchId, applied: batchReceipts.map((r) => r.id), invalidated, newVersion: draftVersion }
}

// ---- 确认：乐观锁，版本不符则后提交者收到冲突 ----
export function confirmDraft(expectedVersion: number): ConfirmResult {
  if (expectedVersion !== draftVersion) {
    return { ok: false, conflict: true, expected: expectedVersion, current: draftVersion }
  }
  for (const work of works) {
    snapshots[work.id] = { workId: work.id, version: draftVersion, status: '有效', confirmedAt: '刚刚', termsHash: computeTermsHash(work.id) }
  }
  for (const mp of materialPackages) mp.status = '有效'
  for (const w of draftWindows) w.status = '已确认'
  versions.unshift({ id: `v${draftVersion}-confirm`, version: draftVersion, author: '发行负责人', time: '刚刚', summary: `确认发行草案 v${draftVersion}`, changes: ['审批快照生效', '物料包恢复有效'] })
  return { ok: true, version: draftVersion }
}

// ---- 补齐缺页（缺页重试前置）----
export function completePages(receiptId: string) {
  const r = receipts.find((x) => x.id === receiptId)
  if (r) r.pages = r.pages.map((p) => ({ ...p, present: true }))
  return r
}

// ---- 按当前草案对齐回执版本（快照不符重试前置）----
export function alignReceipt(receiptId: string) {
  const r = receipts.find((x) => x.id === receiptId)
  if (r) {
    r.baseVersion = draftVersion
    const current = draftWindows.find((w) => w.workId === r.workId && w.territory === r.region)
    if (current) r.terms = { start: current.start, end: current.end, exclusive: current.exclusive, sublicense: current.sublicense }
  }
  return r
}

// ---- 模拟另一用户并发修改（用于演示版本冲突）----
export function simulateConcurrentEdit(): number {
  bumpVersion('模拟并发修改', ['另一用户提交了窗口调整'])
  return draftVersion
}
