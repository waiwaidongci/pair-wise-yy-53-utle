import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { initialComments, initialWindows } from '@/lib/mock-data'
import { findConflicts } from '@/lib/rules'
import { alignReceipt, batches, completePages, computeTermsHash, confirmDraft, draftVersion, draftWindows, materialPackages, mergeBatch, receipts, simulateConcurrentEdit, snapshots, versions, works } from './issuance-store'

const t = initTRPC.create()
const windowInput = z.object({
  channel: z.string().min(2),
  start: z.string().date(),
  end: z.string().date(),
  exclusive: z.boolean(),
})

export const appRouter = t.router({
  catalog: t.procedure.query(() => ({ works: ['W-001', 'W-002'], channels: ['星海影院', '云帆视频', '南华卫视', '海岛航空', '环球新媒体'] })),
  windows: t.procedure.query(() => initialWindows),
  conflicts: t.procedure.query(() => findConflicts(initialWindows)),
  validateWindow: t.procedure.input(windowInput).mutation(({ input }) => {
    if (new Date(input.end) < new Date(input.start)) return { valid: false, message: '窗口结束日期不能早于开始日期。' }
    const collision = initialWindows.find((item) => item.channel === input.channel && input.start <= item.end && item.start <= input.end)
    return collision ? { valid: false, message: `与现有窗口 ${collision.id} 重叠，请调整窗口或明确优先级。` } : { valid: true, message: '窗口结构校验通过。' }
  }),
  comments: t.procedure.query(() => initialComments),

  // ---- 国际发行回执合并 ----
  issuanceWorks: t.procedure.query(() => works),
  issuanceReceipts: t.procedure.query(() => receipts),
  issuanceBatches: t.procedure.query(() => batches),
  issuanceDraftWindows: t.procedure.query(() => draftWindows),
  issuanceMaterialPackages: t.procedure.query(() => materialPackages),
  issuanceSnapshots: t.procedure.query(() => Object.values(snapshots).map((s) => ({ ...s, status: (s.termsHash === computeTermsHash(s.workId) ? '有效' : '已失效') as '有效' | '已失效' }))),
  issuanceVersions: t.procedure.query(() => versions),
  issuanceDraftVersion: t.procedure.query(() => draftVersion),

  mergeBatch: t.procedure.input(z.object({ batchId: z.string() })).mutation(({ input }) => mergeBatch(input.batchId)),
  confirmDraft: t.procedure.input(z.object({ expectedVersion: z.number() })).mutation(({ input }) => confirmDraft(input.expectedVersion)),
  completeReceiptPages: t.procedure.input(z.object({ receiptId: z.string() })).mutation(({ input }) => { completePages(input.receiptId); return { ok: true } }),
  alignReceiptToSnapshot: t.procedure.input(z.object({ receiptId: z.string() })).mutation(({ input }) => { alignReceipt(input.receiptId); return { ok: true } }),
  simulateConcurrentEdit: t.procedure.mutation(() => ({ version: simulateConcurrentEdit() })),
})

export type AppRouter = typeof appRouter
