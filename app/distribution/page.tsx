'use client'

import { Fragment, useState } from 'react'
import {
  Box, Flex, Grid, Heading, Text, Badge, Button, Checkbox, Table, Thead, Tbody, Tr, Th, Td,
  Tabs, TabList, Tab, TabPanels, TabPanel, useToast, HStack, Divider,
} from '@chakra-ui/react'
import { trpc } from '@/trpc/client'
import type { BatchFailure, ReceiptBatch, TermDiff } from '@/lib/distribution/types'

function statusBadge(status: ReceiptBatch['status']) {
  if (status === '已合并') return <Badge colorScheme="green">已合并</Badge>
  if (status === '合并失败') return <Badge colorScheme="red">合并失败</Badge>
  return <Badge colorScheme="orange">待处理</Badge>
}

function draftBadge(status: string) {
  if (status === '已确认') return <Badge colorScheme="green">已确认</Badge>
  if (status === '待重新确认') return <Badge colorScheme="red">待重新确认</Badge>
  return <Badge colorScheme="orange">待审批</Badge>
}

function DiffList({ diffs }: { diffs: TermDiff[] }) {
  if (!diffs.length) return <Text color="gray.500" fontSize="sm">差异明细由审批快照对账生成。</Text>
  return (
    <Box>
      {diffs.map((diff, index) => (
        <Flex key={index} fontSize="sm" py={1} align="baseline" gap={2} flexWrap="wrap">
          <Badge colorScheme={diff.kind === '独占范围' ? 'purple' : diff.kind === '窗口' ? 'blue' : 'cyan'}>{diff.kind}</Badge>
          <Text fontWeight="600">{diff.target} · {diff.field}</Text>
          <Text color="red.500" textDecoration="line-through">{diff.before}</Text>
          <Text color="gray.400">⇒</Text>
          <Text color="green.600" fontWeight="600">{diff.after}</Text>
        </Flex>
      ))}
    </Box>
  )
}

export default function DistributionPage() {
  const overview = trpc.distributionOverview.useQuery()
  const workTable = trpc.workTable.useQuery()
  const [selected, setSelected] = useState<string[]>([])
  const [accepted, setAccepted] = useState<string[]>([])
  const [activeFailures, setActiveFailures] = useState<BatchFailure[]>([])
  const [historyDraftId, setHistoryDraftId] = useState<string | null>(null)
  const draftHistory = trpc.draftHistory.useQuery({ draftId: historyDraftId ?? '' }, { enabled: Boolean(historyDraftId) })
  const toast = useToast()
  const utils = trpc.useUtils()

  const batches = overview.data?.batches ?? []
  const drafts = overview.data?.drafts ?? []
  const history = overview.data?.history ?? []
  const selectable = batches.filter((b) => b.status !== '已合并')

  const mergeMutation = trpc.mergeReceipts.useMutation({
    onSuccess: (data) => {
      setSelected([])
      setAccepted([])
      setActiveFailures([])
      utils.distributionOverview.invalidate()
      const groups = data.merged
      const invalidated = groups.filter((g) => g.invalidated)
      toast({
        title: `已原子合并 ${groups.reduce((sum, g) => sum + g.batchIds.length, 0)} 份回执，覆盖 ${groups.length} 个作品×地区`,
        description: invalidated.length ? `${invalidated.length} 份草案的旧审批快照与物料包已失效，须重新确认。` : '全部事务一次提交成功。',
        status: invalidated.length ? 'warning' : 'success',
        duration: 6000,
      })
    },
    onError: (error) => {
      const cause = (error as unknown as { data?: { cause?: { failures?: BatchFailure[] } } }).data?.cause
      const failures = cause?.failures ?? []
      setActiveFailures(failures)
      utils.distributionOverview.invalidate()
      toast({ title: '合并不成立，已整单回滚', description: error.message, status: 'error', duration: 7000 })
    },
  })

  const fillMutation = trpc.fillMissingPages.useMutation({
    onSuccess: () => { utils.distributionOverview.invalidate(); setActiveFailures([]); toast({ title: '缺页已补齐，批次回到待处理，可重新合并', status: 'success' }) },
    onError: (error) => toast({ title: '补页失败', description: error.message, status: 'error' }),
  })

  const confirmMutation = trpc.confirmDraft.useMutation({
    onSuccess: (data) => {
      utils.distributionOverview.invalidate()
      toast({ title: `${data.draft.id} v${data.draft.version} 已确认`, description: `新审批快照 ${data.snapshotId} 生效，物料包恢复有效。`, status: 'success' })
    },
    onError: (error) => {
      utils.distributionOverview.invalidate()
      const isConflict = (error as unknown as { data?: { cause?: { code?: string } } }).data?.cause?.code === 'VERSION_CONFLICT'
      toast({ title: isConflict ? '版本冲突' : '确认失败', description: error.message, status: 'error', duration: 7000 })
    },
  })

  const concurrentMutation = trpc.simulateConcurrentConfirm.useMutation({
    onSuccess: (data) => {
      utils.distributionOverview.invalidate()
      if (data.second.ok) toast({ title: '异常：两人不应同时确认成功', status: 'warning' })
      else toast({ title: `先提交者 ${data.first.actor} 成功（v${data.first.version}），后提交者收到版本冲突`, description: data.second.message, status: 'warning', duration: 8000 })
    },
  })

  const resetMutation = trpc.distributionReset.useMutation({
    onSuccess: () => { utils.distributionOverview.invalidate(); setSelected([]); setActiveFailures([]); toast({ title: '演示数据已重置', status: 'info' }) },
  })

  function toggle(id: string, checked: boolean) {
    setSelected((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id))
  }

  return (
    <Box>
      <Flex justify="space-between" mb={5} gap={4} direction={{ base: 'column', md: 'row' }}>
        <Box>
          <Text color="brand.600" fontSize="xs" fontWeight="bold">RECEIPTS × WORK × TERRITORY</Text>
          <Heading fontSize="3xl" my={1}>多地区合同回执合并</Heading>
          <Text color="gray.600">按作品 × 地区把窗口、独占范围、物料包归并进同一份发行草案；缺页或与审批快照不符整单回滚，可重试不留半成品。</Text>
        </Box>
        <Button variant="outline" onClick={() => resetMutation.mutate()}>重置演示数据</Button>
      </Flex>

      <Grid templateColumns={{ base: 'repeat(2,1fr)', lg: 'repeat(4,1fr)' }} gap={4} mb={5}>
        {[
          { label: '待处理回执', value: batches.filter((b) => b.status === '待处理').length, color: 'orange' },
          { label: '合并失败（可重试）', value: batches.filter((b) => b.status === '合并失败').length, color: 'red' },
          { label: '发行草案', value: drafts.length, color: 'blue' },
          { label: '待重新确认', value: drafts.filter((d) => d.status === '待重新确认').length, color: 'purple' },
        ].map((card) => (
          <Box key={card.label} bg="white" border="1px solid" borderColor="gray.200" borderLeft="4px solid" borderLeftColor={`${card.color}.400`} borderRadius="8px" p={4}>
            <Text color="gray.500" fontSize="sm">{card.label}</Text>
            <Heading size="lg" my={1}>{card.value}</Heading>
          </Box>
        ))}
      </Grid>

      <Tabs colorScheme="blue" variant="enclosed">
        <TabList>
          <Tab>合同回执收件箱</Tab>
          <Tab>发行草案 / 确认</Tab>
          <Tab>作品总表</Tab>
          <Tab>历史版本（可查回）</Tab>
        </TabList>
        <TabPanels>
          {/* ------------------------------ 收件箱 ------------------------------ */}
          <TabPanel px={0} pt={4}>
            <Flex mb={3} justify="space-between" align="center" direction={{ base: 'column', md: 'row' }} gap={2}>
              <Text color="gray.600" fontSize="sm">勾选回执后一次性提交；跨作品、跨地区也在同一事务里，任一失败全部不提交。</Text>
              <HStack>
                <Button size="sm" variant="outline" onClick={() => setSelected(selectable.map((b) => b.id))}>全选可合并</Button>
                <Button size="sm" colorScheme="blue" isLoading={mergeMutation.isPending} isDisabled={!selected.length} onClick={() => { setAccepted([]); mergeMutation.mutate({ batchIds: selected }) }}>
                  合并选中回执（{selected.length}）
                </Button>
              </HStack>
            </Flex>
            <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" overflow="hidden">
              <Table size="sm">
                <Thead><Tr><Th w="36px"></Th><Th>批次 / 来源</Th><Th>作品</Th><Th>地区</Th><Th>三页齐全度</Th><Th>状态 / 重试</Th></Tr></Thead>
                <Tbody>
                  {batches.map((batch) => {
                    const failure = activeFailures.find((f) => f.batchId === batch.id)
                    return (
                      <Fragment key={batch.id}>
                        <Tr bg={selected.includes(batch.id) ? 'blue.50' : undefined}>
                          <Td>{batch.status !== '已合并' && <Checkbox isChecked={selected.includes(batch.id)} onChange={(e) => toggle(batch.id, e.target.checked)} />}</Td>
                          <Td><Text fontWeight="600">{batch.id}</Text><Text color="gray.500" fontSize="xs">{batch.source} · {batch.receivedAt}</Text>{batch.attempts > 0 && <Text color="red.400" fontSize="xs">已尝试 {batch.attempts} 次</Text>}</Td>
                          <Td>{batch.work}</Td>
                          <Td>{batch.territory}</Td>
                          <Td><HStack spacing={1}>{batch.pages.map((page) => <Badge key={page.code} colorScheme={page.present ? 'green' : 'red'} variant={page.present ? 'subtle' : 'solid'}>{page.code.replace('页', '')}{page.present ? '' : '缺'}</Badge>)}</HStack>{batch.lastError && <Text color="red.500" fontSize="xs" mt={1}>{batch.lastError}</Text>}</Td>
                          <Td>{statusBadge(batch.status)}{batch.status !== '已合并' && <Button mt={1} size="xs" variant="outline" colorScheme="orange" isLoading={fillMutation.isPending} onClick={() => fillMutation.mutate({ batchId: batch.id })}>模拟对方重寄缺页</Button>}{batch.mergedDraftId && <Text color="gray.500" fontSize="xs" mt={1}>{batch.mergedDraftId} v{batch.mergedVersion}</Text>}</Td>
                        </Tr>
                        {failure && (
                          <Tr key={`${batch.id}-diff`}>
                            <Td></Td>
                            <Td colSpan={5} bg="red.50">
                              <Box py={2}>
                                <Text fontWeight="700" color="red.600" fontSize="sm">{failure.missingPages.length ? `缺页：${failure.missingPages.join('、')}——原件保留，补齐后可立即重试` : '窗口/独占页与审批快照不符——原批次保留，差异如下，确认接受后重试合并'}</Text>
                                <DiffList diffs={failure.diffs} />
                                <Text color="gray.500" fontSize="xs" mt={1}>本次事务未写入任何条款（无半份结果）。</Text>
                                {!failure.missingPages.length && (
                                  <HStack mt={2}>
                                    <Button size="xs" colorScheme="red" variant="solid"
                                      isLoading={mergeMutation.isPending}
                                      onClick={() => {
                                        const ids = [...new Set([...selected, batch.id])]
                                        setAccepted(ids)
                                        mergeMutation.mutate({ batchIds: ids, acceptedBatchIds: ids })
                                      }}>
                                      接受以上差异并重试合并 {batch.id}
                                    </Button>
                                    <Text fontSize="xs" color="red.400">接受后旧审批快照与物料包将立即失效</Text>
                                  </HStack>
                                )}
                              </Box>
                            </Td>
                          </Tr>
                        )}
                      </Fragment>
                    )
                  })}
                </Tbody>
              </Table>
            </Box>
          </TabPanel>

          {/* ------------------------------ 草案 ------------------------------ */}
          <TabPanel px={0} pt={4}>
            <Grid templateColumns={{ base: '1fr', xl: '1fr 1fr' }} gap={4}>
              {drafts.map((draft) => (
                <Box key={draft.id} bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={4}>
                  <Flex justify="space-between" align="center">
                    <Box><Heading size="md">{draft.work} · {draft.territory}</Heading><Text color="gray.500" fontSize="xs">{draft.id} · 更新于 {draft.updatedAt}</Text></Box>
                    <HStack>{draftBadge(draft.status)}<Badge colorScheme="blue">v{draft.version}</Badge></HStack>
                  </Flex>
                  <Divider my={3} />
                  <Text fontSize="xs" fontWeight="bold" color="gray.500">窗口条款</Text>
                  {draft.windows.map((win) => (
                    <Flex key={win.id} justify="space-between" fontSize="sm" py={0.5}><Text>{win.channel} · {win.rights}</Text><Text color="gray.600">{win.start} → {win.end}</Text></Flex>
                  ))}
                  <Text fontSize="xs" fontWeight="bold" color="gray.500" mt={2}>独占范围</Text>
                  <Text fontSize="sm">{draft.exclusivity.exclusive ? `独占｜渠道：${draft.exclusivity.channels.join('、')}｜语言：${draft.exclusivity.languages.join('、')}｜子地区：${draft.exclusivity.subTerritories.join('、')}` : '非独占'}</Text>
                  <Flex mt={3} gap={2} align="center" wrap="wrap">
                    <Badge colorScheme={draft.snapshot?.valid ? 'green' : 'red'}>{draft.snapshot ? `快照 ${draft.snapshot.id}${draft.snapshot.valid ? ' · 有效' : ' · 已失效'}` : '无审批快照'}</Badge>
                    <Badge colorScheme={draft.materialPackage.status === '有效' ? 'green' : draft.materialPackage.status === '已失效' ? 'red' : 'orange'}>物料包 {draft.materialPackage.status}{draft.materialPackage.snapshotVersion ? ` · v${draft.materialPackage.snapshotVersion}` : ''}（{draft.materialPackage.items.length} 件）</Badge>
                  </Flex>
                  {draft.snapshot && !draft.snapshot.valid && <Text color="red.500" fontSize="xs" mt={1}>失效原因：{draft.snapshot.invalidatedReason}（{draft.snapshot.invalidatedAt}）</Text>}
                  <HStack mt={4}>
                    <Button size="sm" colorScheme="blue" isLoading={confirmMutation.isPending} onClick={() => confirmMutation.mutate({ draftId: draft.id, expectedVersion: draft.version, actor: '黎清（法务）' })}>基于 v{draft.version} 重新确认</Button>
                    <Button size="sm" variant="outline" isLoading={concurrentMutation.isPending} onClick={() => concurrentMutation.mutate({ draftId: draft.id, actorA: '黎清（法务）', actorB: '章宁（发行）' })}>模拟两人同版本同时确认</Button>
                    <Button size="sm" variant="ghost" onClick={() => setHistoryDraftId(draft.id)}>查看历史版本</Button>
                  </HStack>
                </Box>
              ))}
            </Grid>
            {historyDraftId && (
              <Box mt={4} bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={4}>
                <Flex justify="space-between" mb={2}><Heading size="sm">{historyDraftId} 的版本留档</Heading><Button size="xs" variant="ghost" onClick={() => setHistoryDraftId(null)}>关闭</Button></Flex>
                {draftHistory.data?.map((record) => (
                  <Box key={record.version} p={3} mb={2} bg="gray.50" borderRadius="6px">
                    <Flex justify="space-between"><Text fontWeight="700">v{record.version} · {record.status}</Text><Text color="gray.500" fontSize="xs">{record.actor} · {record.time}</Text></Flex>
                    <Text color="gray.600" fontSize="sm">{record.note}</Text>
                    <Text color="gray.500" fontSize="xs" mt={1}>{record.windows.length} 条窗口 · {record.materials.length} 件物料 · 独占语言 {record.exclusivity.languages.join('、')}</Text>
                  </Box>
                ))}
              </Box>
            )}
          </TabPanel>

          {/* ------------------------------ 作品总表 ------------------------------ */}
          <TabPanel px={0} pt={4}>
            <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" overflow="hidden">
              <Table size="sm">
                <Thead><Tr><Th>作品</Th><Th>草案数</Th><Th>覆盖地区</Th><Th>窗口</Th><Th>待处理回执</Th><Th>失败回执</Th><Th>已合并回执</Th><Th>总状态</Th></Tr></Thead>
                <Tbody>
                  {(workTable.data ?? []).map((row) => (
                    <Tr key={row.workId}>
                      <Td><Text fontWeight="600">{row.work}</Text><Text color="gray.500" fontSize="xs">{row.workId}</Text></Td>
                      <Td>{row.draftCount}</Td>
                      <Td>{row.territories.length ? row.territories.join('、') : '—'}</Td>
                      <Td>{row.windowCount}</Td>
                      <Td>{row.pendingReceipts}</Td>
                      <Td color={row.failedReceipts ? 'red.500' : undefined}>{row.failedReceipts}</Td>
                      <Td>{row.mergedReceipts}</Td>
                      <Td>{draftBadge(row.status)}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </Box>
          </TabPanel>

          {/* ------------------------------- 历史 -------------------------------- */}
          <TabPanel px={0} pt={4}>
            <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px">
              {history.map((entry) => (
                <Box key={entry.id} p={4} borderBottom="1px solid" borderColor="gray.100">
                  <Flex justify="space-between" gap={3}>
                    <HStack align="flex-start">
                      <Badge colorScheme={entry.kind.includes('失败') ? 'red' : entry.kind.includes('失效') ? 'purple' : entry.kind.includes('确认') ? 'green' : 'blue'}>{entry.kind}</Badge>
                      <Box><Text fontWeight="700" fontSize="sm">{entry.summary}</Text><Text color="gray.500" fontSize="xs">{entry.actor} · {entry.time}{entry.territory ? ` · ${entry.work} / ${entry.territory}` : ''}</Text></Box>
                    </HStack>
                    {entry.batchIds.length > 0 && <Badge variant="outline">{entry.batchIds.join('、')}</Badge>}
                  </Flex>
                  {entry.details.map((detail, index) => <Text key={index} fontSize="sm" color="gray.600" mt={1}>· {detail}</Text>)}
                </Box>
              ))}
            </Box>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </Box>
  )
}
