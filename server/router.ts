import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import { initialComments, initialWindows } from '@/lib/mock-data'
import { findConflicts } from '@/lib/rules'
import { distributionStore } from './distribution-store'

const t = initTRPC.create({
  // 把抛出 TRPCError 时附带的 cause（缺页/差异/版本冲突明细）回传给前端
  errorFormatter({ shape, error }) {
    return { ...shape, data: { ...shape.data, cause: error.cause } }
  },
})
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

  /* ------------------------- 国际发行回执合并业务线 ------------------------- */
  distributionOverview: t.procedure.query(() => distributionStore.getOverview()),
  workTable: t.procedure.query(() => distributionStore.getWorkTable()),
  mergeFailures: t.procedure.query(() => distributionStore.getLastFailures()),
  draftHistory: t.procedure.input(z.object({ draftId: z.string() })).query(({ input }) => distributionStore.getDraftHistory(input.draftId)),
  mergeReceipts: t.procedure
    .input(z.object({ batchIds: z.array(z.string()).min(1), acceptedBatchIds: z.array(z.string()).optional() }))
    .mutation(({ input }) => {
      const result = distributionStore.mergeReceipts(input.batchIds, input.acceptedBatchIds ?? [])
      if (!result.ok) {
        throw new TRPCError({
          code: result.code === 'MISSING_PAGES' ? 'BAD_REQUEST' : 'CONFLICT',
          message: result.message,
          cause: { code: result.code, failures: result.failures },
        })
      }
      return result
    }),
  fillMissingPages: t.procedure.input(z.object({ batchId: z.string() })).mutation(({ input }) => distributionStore.fillMissingPages(input.batchId)),
  confirmDraft: t.procedure
    .input(z.object({ draftId: z.string(), expectedVersion: z.number().int().nonnegative(), actor: z.string().min(1) }))
    .mutation(({ input }) => {
      try {
        return distributionStore.confirmDraft(input.draftId, input.expectedVersion, input.actor)
      } catch (error) {
        if ((error as Error).name === 'VERSION_CONFLICT') {
          throw new TRPCError({ code: 'CONFLICT', message: (error as Error).message, cause: { code: 'VERSION_CONFLICT' } })
        }
        throw error
      }
    }),
  simulateConcurrentConfirm: t.procedure
    .input(z.object({ draftId: z.string(), actorA: z.string().min(1), actorB: z.string().min(1) }))
    .mutation(({ input }) => distributionStore.simulateConcurrentConfirm(input.draftId, input.actorA, input.actorB)),
  distributionReset: t.procedure.mutation(() => { distributionStore.reset(); return { ok: true } }),
})

export type AppRouter = typeof appRouter
