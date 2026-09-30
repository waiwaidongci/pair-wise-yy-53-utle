import { seedBatches, seedDrafts } from '@/lib/distribution/seed'
import {
  auditBatch,
  digestOf,
  exclusivityDigestOf,
  materialDigestOf,
  mergeMaterials,
  mergeWindows,
  normalizePages,
  windowsDigestOf,
  type AuditBaseline,
} from '@/lib/distribution/engine'
import type {
  BatchFailure,
  DistributionDraft,
  DraftVersionRecord,
  HistoryEntry,
  MergedGroup,
  ReceiptBatch,
  ReceiptPage,
  WorkTableRow,
} from '@/lib/distribution/types'

function stamp() {
  return new Date().toISOString().slice(0, 16).replace('T', ' ')
}

function baselineOf(draft: DistributionDraft): AuditBaseline {
  return {
    windowDigest: windowsDigestOf(draft.windows),
    exclusivityDigest: exclusivityDigestOf(draft.exclusivity),
    materialDigest: materialDigestOf(draft.materials),
    windows: draft.windows.map(({ channel, rights, start, end }) => ({ channel, rights, start, end })),
    exclusivity: draft.exclusivity,
    materials: draft.materials,
  }
}

class DistributionStore {
  private drafts: DistributionDraft[]
  private batches: ReceiptBatch[]
  private history: HistoryEntry[]
  private versionRecords: DraftVersionRecord[]
  private lastFailures: BatchFailure[] = []
  private seq = 0

  constructor() {
    this.drafts = seedDrafts.map((draft) => {
      const copy = structuredClone(draft)
      if (copy.snapshot) {
        copy.snapshot.windowDigest = digestOf(copy.snapshot.windows)
        copy.snapshot.exclusivityDigest = digestOf(copy.snapshot.exclusivity)
        copy.snapshot.materialDigest = digestOf(copy.snapshot.materials)
      }
      copy.materialPackage.digest = materialDigestOf(copy.materials)
      return copy
    })
    this.batches = seedBatches.map((batch) => ({ ...batch, pages: normalizePages(batch.pages) }))
    this.history = [
      {
        id: 'H-0001',
        time: '2026-09-20 16:35',
        kind: '审批确认',
        actor: '黎清（法务）',
        draftId: 'DR-001',
        work: '《远山回声》',
        territory: '中国大陆',
        summary: 'v18 审批通过，审批快照 AP-18 生效，物料包 PKG-18 确认。',
        details: ['窗口页 / 独占范围页 / 物料清单页三页齐章'],
        batchIds: [],
      },
      {
        id: 'H-0002',
        time: '2026-09-18 10:02',
        kind: '审批确认',
        actor: '章宁（发行）',
        draftId: 'DR-002',
        work: '《深港口岸》',
        territory: '新加坡',
        summary: 'v9 审批通过，审批快照 AP-9 生效。',
        details: ['新加坡流媒体独占 2026-12-01 起'],
        batchIds: [],
      },
      {
        id: 'H-0003',
        time: '2026-09-28 11:42',
        kind: '合并失败',
        actor: '系统',
        draftId: 'DR-001',
        work: '《远山回声》',
        territory: '中国大陆',
        summary: 'RC-302 合并中止：缺页（独占范围页、物料清单页），原批次保留待补。',
        details: ['缺失：独占范围页、物料清单页'],
        batchIds: ['RC-302'],
      },
    ]
    this.versionRecords = this.drafts.map((draft) => this.snapshotRecord(draft, '初始留档', '系统'))
  }

  private nextId(prefix: string) {
    this.seq += 1
    return `${prefix}-${Date.now().toString(36)}-${this.seq}`
  }

  private snapshotRecord(draft: DistributionDraft, note: string, actor: string): DraftVersionRecord {
    return {
      draftId: draft.id,
      version: draft.version,
      time: stamp(),
      actor,
      note,
      windows: structuredClone(draft.windows),
      exclusivity: structuredClone(draft.exclusivity),
      materials: structuredClone(draft.materials),
      status: draft.status,
    }
  }

  private pushHistory(entry: Omit<HistoryEntry, 'id' | 'time'>) {
    this.history.unshift({ ...entry, id: this.nextId('H'), time: stamp() })
  }

  /* -------------------------------- 查回 -------------------------------- */

  getOverview() {
    return { drafts: this.drafts, batches: this.batches, history: this.history, lastFailures: this.lastFailures }
  }

  getLastFailures() {
    return this.lastFailures
  }

  getBatches() {
    return this.batches
  }

  getDraft(draftId: string) {
    return this.drafts.find((draft) => draft.id === draftId) ?? null
  }

  getDraftHistory(draftId: string) {
    return this.versionRecords.filter((record) => record.draftId === draftId).sort((a, b) => b.version - a.version)
  }

  getWorkTable(): WorkTableRow[] {
    const workIds = new Set([...this.drafts.map((d) => d.workId), ...this.batches.map((b) => b.workId)])
    return [...workIds].map((workId) => {
      const drafts = this.drafts.filter((d) => d.workId === workId)
      const batches = this.batches.filter((b) => b.workId === workId)
      const work = drafts[0]?.work ?? batches[0]?.work ?? workId
      const statusRank: Record<WorkTableRow['status'], number> = { 待重新确认: 0, 待审批: 1, 已确认: 2, 无草案: 3 }
      const statuses = drafts.map((d) => d.status) as WorkTableRow['status'][]
      const status = statuses.length ? statuses.sort((a, b) => statusRank[a] - statusRank[b])[0]! : '无草案'
      return {
        workId,
        work,
        draftCount: drafts.length,
        territories: [...new Set(drafts.map((d) => d.territory))],
        windowCount: drafts.reduce((sum, d) => sum + d.windows.length, 0),
        pendingReceipts: batches.filter((b) => b.status === '待处理').length,
        failedReceipts: batches.filter((b) => b.status === '合并失败').length,
        mergedReceipts: batches.filter((b) => b.status === '已合并').length,
        status,
      }
    })
  }

  /* ------------------------------ 回执合并事务 ------------------------------ */

  /**
   * 原子合并：选中回执按 作品 × 地区 归并到同一份草案。
   * 任一批次缺页或与审批快照不符 → 整个事务不提交任何条款，
   * 问题批次保留在收件箱并记录差异；其余批次状态不变，可随时重试。
   */
  mergeReceipts(
    batchIds: string[],
    acceptedBatchIds: string[] = [],
  ): { ok: true; merged: MergedGroup[] } | { ok: false; code: 'MISSING_PAGES' | 'SNAPSHOT_MISMATCH'; message: string; failures: BatchFailure[] } {
    const selected = batchIds
      .map((id) => this.batches.find((batch) => batch.id === id))
      .filter((b): b is ReceiptBatch => b !== undefined && b.status !== '已合并')
    if (!selected.length) return { ok: false, code: 'MISSING_PAGES', message: '没有可合并的回执批次。', failures: [] }

    const accepted = new Set(acceptedBatchIds)

    // 第一阶段：在草稿副本上完成全部校验，任何一组失败都不触碰正式状态
    const groupKeys = [...new Set(selected.map((b) => `${b.workId}__${b.territory}`))]
    const draftByKey = new Map<string, DistributionDraft>()
    const failures: BatchFailure[] = []
    let anyMissing = false

    for (const key of groupKeys) {
      const [workId, territory] = key.split('__')
      const groupBatches = selected.filter((b) => b.workId === workId && b.territory === territory)
      const existing = this.drafts.find((d) => d.workId === workId && d.territory === territory)
      const draft: DistributionDraft = existing
        ? structuredClone(existing)
        : {
            id: this.nextId('DR'),
            workId: workId!,
            work: groupBatches[0]!.work,
            territory: territory as DistributionDraft['territory'],
            windows: [],
            exclusivity: { exclusive: false, channels: [], languages: [], subTerritories: [] },
            materials: [],
            version: 0,
            status: '待审批',
            snapshot: null,
            materialPackage: { id: this.nextId('PKG'), items: [], digest: materialDigestOf([]), status: '待确认', snapshotVersion: null, updatedAt: stamp() },
            updatedAt: stamp(),
          }
      draftByKey.set(key, draft)

      for (const batch of groupBatches) {
        // 只有已审批且快照仍有效的草案才做窗口/独占对账拦截；全新地区、待审批/待重新确认的草案自由合并；
        // 物料清单差异永远不阻断（物料包独立更新）
        const requireMatch = existing?.snapshot?.valid === true
        const audit = auditBatch(batch, draft.snapshot, baselineOf(draft), requireMatch)
        const blocked = audit.missingPages.length > 0 || (audit.mismatchPages.length > 0 && !accepted.has(batch.id))
        if (blocked) {
          anyMissing ||= audit.missingPages.length > 0
          failures.push({ batchId: batch.id, work: batch.work, territory: batch.territory, missingPages: audit.missingPages, diffs: audit.diffs, materialDiffs: [] })
        }
      }
    }

    if (failures.length) {
      // 事务中止：只对问题批次记账（保留原件 + 差异），绝不写入半句条款
      this.lastFailures = failures
      const failedIds = new Set(failures.map((f) => f.batchId))
      this.batches = this.batches.map((batch) => failedIds.has(batch.id)
        ? { ...batch, status: '合并失败', attempts: batch.attempts + 1, lastError: this.describeFailure(failures.find((f) => f.batchId === batch.id)!) }
        : batch)
      failures.forEach((failure) => {
        this.pushHistory({
          kind: '合并失败',
          actor: '系统',
          draftId: this.drafts.find((d) => d.workId === this.batches.find((b) => b.id === failure.batchId)!.workId && d.territory === failure.territory)?.id ?? null,
          work: failure.work,
          territory: failure.territory,
          summary: `${failure.batchId} 合并中止，原批次保留，可补齐/接受差异后重试。`,
          details: [
            ...(failure.missingPages.length ? [`缺页：${failure.missingPages.join('、')}`] : []),
            ...failure.diffs.map((d) => `${d.kind}｜${d.target}｜${d.field}：${d.before} ⇒ ${d.after}`),
          ],
          batchIds: [failure.batchId],
        })
      })
      const code = anyMissing ? 'MISSING_PAGES' : 'SNAPSHOT_MISMATCH'
      return { ok: false, code, message: code === 'MISSING_PAGES' ? '存在缺页批次：请补齐页后重试，本次未写入任何条款。' : '回执与审批快照不符：差异已列出，确认接受差异后可重试合并。', failures }
    }

    // 第二阶段：全部校验通过，一次性提交
    this.lastFailures = []
    const merged: MergedGroup[] = []
    for (const key of groupKeys) {
      const [workId, territory] = key.split('__')
      const draft = draftByKey.get(key)!
      const groupBatches = selected.filter((b) => b.workId === workId && b.territory === territory)
      const beforeWindowDigest = windowsDigestOf(draft.windows)
      const beforeExclusivityDigest = exclusivityDigestOf(draft.exclusivity)
      const beforeMaterialDigest = materialDigestOf(draft.materials)
      const isNewDraft = draft.version === 0 && !this.drafts.some((d) => d.id === draft.id)

      groupBatches.forEach((batch) => {
        batch.pages.forEach((page) => {
          if (page.code === '窗口页' && page.payload?.windows) draft.windows = mergeWindows(draft.windows, page.payload.windows, draft.id)
          if (page.code === '独占范围页' && page.payload?.exclusivity) draft.exclusivity = structuredClone(page.payload.exclusivity)
          if (page.code === '物料清单页' && page.payload?.materials) draft.materials = mergeMaterials(draft.materials, page.payload.materials)
        })
      })

      const windowChanged = windowsDigestOf(draft.windows) !== beforeWindowDigest
      const exclusivityChanged = exclusivityDigestOf(draft.exclusivity) !== beforeExclusivityDigest
      const materialsChanged = materialDigestOf(draft.materials) !== beforeMaterialDigest
      // 规则：任一窗口或独占范围变化，旧审批快照与物料包立即失效
      const invalidated = (windowChanged || exclusivityChanged) && draft.snapshot?.valid === true
      if (invalidated && draft.snapshot) {
        draft.snapshot = { ...draft.snapshot, valid: false, invalidatedAt: stamp(), invalidatedReason: windowChanged ? '窗口条款被新回执合并' : '独占范围被新回执合并' }
        draft.materialPackage = { ...draft.materialPackage, status: '已失效', snapshotVersion: draft.snapshot.version }
        draft.status = '待重新确认'
      }
      if (materialsChanged || windowChanged || exclusivityChanged) {
        // 快照仍有效且未被本次合并失效 → 物料更新可直接生效；否则沿用失效/待确认态
        const packageStatus = invalidated ? '已失效' : draft.snapshot?.valid ? '有效' : draft.materialPackage.status
        draft.materialPackage = {
          ...draft.materialPackage,
          items: structuredClone(draft.materials),
          digest: materialDigestOf(draft.materials),
          status: packageStatus,
          updatedAt: stamp(),
        }
      }
      if (isNewDraft) draft.materialPackage = { ...draft.materialPackage, status: '待确认' }

      draft.version += 1
      draft.updatedAt = stamp()
      this.drafts = this.drafts.some((d) => d.id === draft.id) ? this.drafts.map((d) => (d.id === draft.id ? draft : d)) : [...this.drafts, draft]
      this.versionRecords.push(this.snapshotRecord(draft, `合并回执 ${groupBatches.map((b) => b.id).join('、')}`, '发行操作员'))
      this.batches = this.batches.map((batch) => groupBatches.some((b) => b.id === batch.id)
        ? { ...batch, status: '已合并', attempts: batch.attempts, lastError: null, mergedDraftId: draft.id, mergedVersion: draft.version }
        : batch)

      const detailLines: string[] = []
      if (groupBatches.some((b) => accepted.has(b.id))) detailLines.push('操作员已接受与审批快照的差异，旧快照随条款变化失效')
      if (windowChanged) detailLines.push('窗口条款发生变化')
      if (exclusivityChanged) detailLines.push('独占范围发生变化')
      if (materialsChanged) detailLines.push('物料清单发生变化')
      if (invalidated) detailLines.push(`旧审批快照 ${draft.snapshot?.id ?? ''} 与物料包立即失效，须重新确认`)
      this.pushHistory({
        kind: '回执合并',
        actor: '发行操作员',
        draftId: draft.id,
        work: draft.work,
        territory: draft.territory,
        summary: `${groupBatches.map((b) => b.id).join('、')} 合并入 ${draft.id} v${draft.version}（${draft.territory}）。`,
        details: detailLines.length ? detailLines : ['三页与审批快照一致，仅留档，条款无变化'],
        batchIds: groupBatches.map((b) => b.id),
      })

      merged.push({ draftId: draft.id, workId: draft.workId, territory: draft.territory, newDraft: isNewDraft, fromVersion: isNewDraft ? null : draft.version - 1, version: draft.version, windowChanged, exclusivityChanged, materialsChanged, invalidated, batchIds: groupBatches.map((b) => b.id) })
    }
    return { ok: true, merged }
  }

  private describeFailure(failure: BatchFailure): string {
    const parts: string[] = []
    if (failure.missingPages.length) parts.push(`缺页：${failure.missingPages.join('、')}`)
    if (failure.diffs.length) parts.push(`与审批快照 ${failure.diffs.length} 处差异`)
    return parts.join('；') || '回执校验未通过'
  }

  /* ------------------------------- 缺页补齐 ------------------------------- */

  /** 对方重新寄来缺页：用当前草案基线页补齐（演示重寄路径），批次回到待处理。 */
  fillMissingPages(batchId: string): ReceiptBatch {
    const batch = this.batches.find((item) => item.id === batchId)
    if (!batch) throw new Error('批次不存在')
    if (batch.status === '已合并') throw new Error('已合并批次不可补页')
    const draft = this.drafts.find((d) => d.workId === batch.workId && d.territory === batch.territory)
    const pages: ReceiptPage[] = batch.pages.map((page) => {
      if (page.present) return page
      if (page.code === '窗口页') return { code: page.code, present: true, digest: '', payload: { windows: draft ? draft.windows.map(({ channel, rights, start, end }) => ({ channel, rights, start, end })) : [] } }
      if (page.code === '独占范围页') return { code: page.code, present: true, digest: '', payload: { exclusivity: draft ? draft.exclusivity : { exclusive: false, channels: [], languages: [], subTerritories: [] } } }
      return { code: page.code, present: true, digest: '', payload: { materials: draft ? draft.materials : [] } }
    })
    this.batches = this.batches.map((item) => item.id === batchId ? { ...item, pages: normalizePages(pages), status: '待处理', lastError: null } : item)
    this.pushHistory({ kind: '缺页补齐', actor: '发行操作员', draftId: draft?.id ?? null, work: batch.work, territory: batch.territory, summary: `${batchId} 已收到对方重寄的缺页，回到待处理可重新合并。`, details: batch.pages.filter((p) => !p.present).map((p) => `补齐：${p.code}`), batchIds: [batchId] })
    return this.batches.find((item) => item.id === batchId)!
  }

  /* ----------------------------- 乐观锁确认 ----------------------------- */

  /** 确认草案：expectedVersion 必须等于当前版本，否则后提交者收到版本冲突。 */
  confirmDraft(draftId: string, expectedVersion: number, actor: string): { draft: DistributionDraft; snapshotId: string } {
    const draft = this.drafts.find((item) => item.id === draftId)
    if (!draft) throw new Error('草案不存在')
    if (draft.version !== expectedVersion) {
      const error = new Error(`版本冲突：你基于 v${expectedVersion} 提交，但 ${draft.id} 已是 v${draft.version}（${draft.status}）。请刷新查看最新版本后再确认。`)
      error.name = 'VERSION_CONFLICT'
      throw error
    }
    const newVersion = draft.version + 1
    const snapshotId = `AP-${newVersion}`
    draft.snapshot = {
      id: snapshotId,
      version: newVersion,
      approver: actor,
      approvedAt: stamp(),
      windows: draft.windows.map(({ channel, rights, start, end }) => ({ channel, rights, start, end })),
      exclusivity: structuredClone(draft.exclusivity),
      materials: structuredClone(draft.materials),
      windowDigest: windowsDigestOf(draft.windows),
      exclusivityDigest: exclusivityDigestOf(draft.exclusivity),
      materialDigest: materialDigestOf(draft.materials),
      valid: true,
      invalidatedAt: null,
      invalidatedReason: null,
    }
    draft.materialPackage = { ...draft.materialPackage, items: structuredClone(draft.materials), digest: materialDigestOf(draft.materials), status: '有效', snapshotVersion: newVersion, updatedAt: stamp() }
    draft.status = '已确认'
    draft.version = newVersion
    draft.updatedAt = stamp()
    this.versionRecords.push(this.snapshotRecord(draft, `重新确认，快照 ${snapshotId} 生效`, actor))
    this.pushHistory({ kind: '审批确认', actor, draftId: draft.id, work: draft.work, territory: draft.territory, summary: `${draft.id} v${newVersion} 确认通过，新审批快照 ${snapshotId} 生效，物料包恢复有效。`, details: ['窗口页 / 独占范围页 / 物料清单页重新核对'], batchIds: [] })
    return { draft, snapshotId }
  }

  /** 两人同时确认的确定性演示：A 带当前版本提交成功，B 用同版本提交被拒。 */
  simulateConcurrentConfirm(draftId: string, actorA: string, actorB: string) {
    const draft = this.drafts.find((item) => item.id === draftId)
    if (!draft) throw new Error('草案不存在')
    const expected = draft.version
    const first = this.confirmDraft(draftId, expected, actorA)
    let second: { ok: false; code: 'VERSION_CONFLICT'; message: string; currentVersion: number } | { ok: true; snapshotId: string }
    try {
      const result = this.confirmDraft(draftId, expected, actorB)
      second = { ok: true, snapshotId: result.snapshotId }
    } catch (error) {
      second = { ok: false, code: 'VERSION_CONFLICT', message: (error as Error).message, currentVersion: draft.version }
    }
    return { first: { ok: true as const, snapshotId: first.snapshotId, actor: actorA, version: expected + 1 }, second }
  }

  reset() {
    this.drafts = seedDrafts.map((draft) => {
      const copy = structuredClone(draft)
      if (copy.snapshot) {
        copy.snapshot.windowDigest = digestOf(copy.snapshot.windows)
        copy.snapshot.exclusivityDigest = digestOf(copy.snapshot.exclusivity)
        copy.snapshot.materialDigest = digestOf(copy.snapshot.materials)
      }
      copy.materialPackage.digest = materialDigestOf(copy.materials)
      return copy
    })
    this.batches = seedBatches.map((batch) => ({ ...batch, pages: normalizePages(batch.pages) }))
    this.versionRecords = this.drafts.map((draft) => this.snapshotRecord(draft, '初始留档', '系统'))
    this.lastFailures = []
    this.history = [
      {
        id: 'H-0001', time: '2026-09-20 16:35', kind: '审批确认', actor: '黎清（法务）', draftId: 'DR-001', work: '《远山回声》', territory: '中国大陆',
        summary: 'v18 审批通过，审批快照 AP-18 生效，物料包 PKG-18 确认。', details: ['窗口页 / 独占范围页 / 物料清单页三页齐章'], batchIds: [],
      },
      {
        id: 'H-0002', time: '2026-09-18 10:02', kind: '审批确认', actor: '章宁（发行）', draftId: 'DR-002', work: '《深港口岸》', territory: '新加坡',
        summary: 'v9 审批通过，审批快照 AP-9 生效。', details: ['新加坡流媒体独占 2026-12-01 起'], batchIds: [],
      },
      {
        id: 'H-0003', time: '2026-09-28 11:42', kind: '合并失败', actor: '系统', draftId: 'DR-001', work: '《远山回声》', territory: '中国大陆',
        summary: 'RC-302 合并中止：缺页（独占范围页、物料清单页），原批次保留待补。', details: ['缺失：独占范围页、物料清单页'], batchIds: ['RC-302'],
      },
    ]
  }
}

// 开发热更新下保留同一份内存状态
const globalForDistribution = globalThis as unknown as { distributionStore?: DistributionStore }
export const distributionStore = globalForDistribution.distributionStore ?? new DistributionStore()
globalForDistribution.distributionStore = distributionStore
