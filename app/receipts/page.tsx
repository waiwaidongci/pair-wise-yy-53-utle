'use client'

import { useMemo, useState } from 'react'
import {
  Box, Flex, Grid, Heading, Text, Badge, Button, Table, Thead, Tbody, Tr, Th, Td,
  useToast, Tabs, TabList, Tab, TabPanels, TabPanel, Stat, StatLabel, StatNumber,
  Alert, AlertIcon, AlertTitle, AlertDescription, HStack, VStack, Divider,
} from '@chakra-ui/react'
import { trpc } from '@/trpc/client'
import type { MergeResult } from '@/lib/issuance-types'

const pageLabels = ['授权条款页', '独占范围页', '物料清单页']

export default function ReceiptsPage() {
  const toast = useToast()
  const utils = trpc.useContext()

  const works = trpc.issuanceWorks.useQuery()
  const receipts = trpc.issuanceReceipts.useQuery()
  const batches = trpc.issuanceBatches.useQuery()
  const draftWindows = trpc.issuanceDraftWindows.useQuery()
  const materialPackages = trpc.issuanceMaterialPackages.useQuery()
  const snapshots = trpc.issuanceSnapshots.useQuery()
  const versions = trpc.issuanceVersions.useQuery()
  const draftVersion = trpc.issuanceDraftVersion.useQuery()

  const [results, setResults] = useState<Record<string, MergeResult>>({})

  const invalidateAll = () => Promise.all([
    utils.issuanceWorks.invalidate(),
    utils.issuanceReceipts.invalidate(),
    utils.issuanceBatches.invalidate(),
    utils.issuanceDraftWindows.invalidate(),
    utils.issuanceMaterialPackages.invalidate(),
    utils.issuanceSnapshots.invalidate(),
    utils.issuanceVersions.invalidate(),
    utils.issuanceDraftVersion.invalidate(),
  ])

  const mergeMutation = trpc.mergeBatch.useMutation()
  const confirmMutation = trpc.confirmDraft.useMutation()
  const completePagesMutation = trpc.completeReceiptPages.useMutation()
  const alignMutation = trpc.alignReceiptToSnapshot.useMutation()
  const simulateMutation = trpc.simulateConcurrentEdit.useMutation()

  const workTitle = (workId: string) => works.data?.find((w) => w.id === workId)?.title ?? workId
  const receiptsOf = (batchId: string) => receipts.data?.filter((r) => r.batchId === batchId) ?? []

  const stats = useMemo(() => ({
    works: works.data?.length ?? 0,
    batches: batches.data?.length ?? 0,
    pending: receipts.data?.filter((r) => r.status === '待合并').length ?? 0,
    invalidated: materialPackages.data?.filter((m) => m.status === '已失效').length ?? 0,
  }), [works.data, batches.data, receipts.data, materialPackages.data])

  async function handleMerge(batchId: string) {
    const res = await mergeMutation.mutateAsync({ batchId })
    setResults((prev) => ({ ...prev, [batchId]: res }))
    if (res.ok) {
      toast({
        title: '回执已并入发行草案',
        description: res.invalidated
          ? `窗口/独占范围变化，旧审批快照与物料包已失效（v${res.newVersion}），请重新确认。`
          : `整批回执合并完成，草案版本 v${res.newVersion}。`,
        status: res.invalidated ? 'warning' : 'success',
      })
    } else {
      toast({ title: '批次未并入，已保留原批次', description: res.reason === '缺页' ? '存在缺页，请补齐后重试。' : '回执与审批快照不符，请对齐后重试。', status: 'error' })
    }
    await invalidateAll()
  }

  async function handleFixAndRetry(batchId: string, result: MergeResult) {
    if (!result.ok) {
      if (result.reason === '缺页' && result.missingPages) {
        const receiptIds = Array.from(new Set(result.missingPages.map((p) => p.receiptId)))
        for (const rid of receiptIds) await completePagesMutation.mutateAsync({ receiptId: rid })
      } else if (result.reason === '快照不符' && result.diffs) {
        for (const d of result.diffs) {
          const r = receipts.data?.find((x) => x.workId === d.workId && x.region === d.region)
          if (r) await alignMutation.mutateAsync({ receiptId: r.id })
        }
      }
    }
    await handleMerge(batchId)
  }

  async function handleConfirm() {
    const expected = draftVersion.data ?? 0
    const res = await confirmMutation.mutateAsync({ expectedVersion: expected })
    if (res.ok) {
      toast({ title: '发行草案已确认', description: `审批快照 v${res.version} 生效，物料包恢复有效。`, status: 'success' })
    } else {
      toast({
        title: '版本冲突',
        description: `你看到的是 v${res.expected}，当前草案已是 v${res.current}。后提交者请刷新版本后重新确认。`,
        status: 'error',
        duration: 6000,
      })
    }
    await invalidateAll()
  }

  async function handleSimulateConcurrent() {
    await simulateMutation.mutateAsync()
    toast({ title: '已模拟另一用户提交', description: '草案版本已变化，原确认将收到版本冲突。', status: 'info' })
    await invalidateAll()
  }

  return (
    <Box>
      <Flex justify="space-between" mb={5} gap={4} direction={{ base: 'column', md: 'row' }}>
        <Box>
          <Text color="brand.600" fontSize="xs" fontWeight="bold">RECEIPT MERGE & RELEASE DRAFT</Text>
          <Heading fontSize={{ base: '2xl', md: '3xl' }} my={1}>国际发行回执合并</Heading>
          <Text color="gray.600">按作品和地区把多地区合同回执合并进同一份发行草案；缺页或与审批快照不符时保留原批次并列出差异，失败可重试且不留下半份结果。</Text>
        </Box>
        <HStack>
          <Button variant="outline" onClick={handleSimulateConcurrent} isLoading={simulateMutation.isPending}>模拟并发提交</Button>
          <Button colorScheme="blue" onClick={handleConfirm} isLoading={confirmMutation.isPending}>重新确认发行草案</Button>
        </HStack>
      </Flex>

      <Grid templateColumns={{ base: 'repeat(2,1fr)', lg: 'repeat(4,1fr)' }} gap={4} mb={5}>
        <Stat bg="white" border="1px solid" borderColor="gray.200" borderLeft="4px solid" borderLeftColor="brand.500" borderRadius="8px" p={4}>
          <StatLabel color="gray.500">作品总表</StatLabel>
          <StatNumber>{stats.works}</StatNumber>
        </Stat>
        <Stat bg="white" border="1px solid" borderColor="gray.200" borderLeft="4px solid" borderLeftColor="brand.500" borderRadius="8px" p={4}>
          <StatLabel color="gray.500">回执批次</StatLabel>
          <StatNumber>{stats.batches}</StatNumber>
        </Stat>
        <Stat bg="white" border="1px solid" borderColor="gray.200" borderLeft="4px solid" borderLeftColor="brand.500" borderRadius="8px" p={4}>
          <StatLabel color="gray.500">待合并回执</StatLabel>
          <StatNumber>{stats.pending}</StatNumber>
        </Stat>
        <Stat bg="white" border="1px solid" borderColor="gray.200" borderLeft="4px solid" borderLeftColor={stats.invalidated ? 'red.500' : 'brand.500'} borderRadius="8px" p={4}>
          <StatLabel color="gray.500">已失效物料包</StatLabel>
          <StatNumber color={stats.invalidated ? 'red.500' : 'inherit'}>{stats.invalidated}</StatNumber>
        </Stat>
      </Grid>

      <Tabs colorScheme="blue" variant="enclosed">
        <TabList>
          <Tab>回执合并</Tab>
          <Tab>作品总表</Tab>
          <Tab>历史版本</Tab>
          <Tab>回执查回</Tab>
        </TabList>
        <TabPanels>
          {/* ============ 回执合并 ============ */}
          <TabPanel px={0} pt={4}>
            {/* 审批快照状态 */}
            <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={4} mb={4}>
              <Flex justify="space-between" align="center" mb={3}>
                <Box>
                  <Heading size="md">审批快照与物料包</Heading>
                  <Text color="gray.500" fontSize="sm">任一窗口或独占范围变化，旧快照与物料包立即失效，须重新确认。当前草案版本 <Badge>v{draftVersion.data ?? '—'}</Badge></Text>
                </Box>
                <Button size="sm" colorScheme="blue" onClick={handleConfirm} isLoading={confirmMutation.isPending}>重新确认</Button>
              </Flex>
              <Grid templateColumns={{ base: '1fr', lg: '1fr 1fr' }} gap={3}>
                {(snapshots.data ?? []).map((snap) => (
                  <Box key={snap.workId} border="1px solid" borderColor="gray.200" borderRadius="6px" p={3}>
                    <Flex justify="space-between" align="center" mb={2}>
                      <Text fontWeight="700">{workTitle(snap.workId)}</Text>
                      <Badge colorScheme={snap.status === '有效' ? 'green' : 'red'}>{snap.status}</Badge>
                    </Flex>
                    <Text fontSize="xs" color="gray.500">快照版本 v{snap.version} · 确认于 {snap.confirmedAt}</Text>
                    <Text fontSize="xs" color="gray.500" mt={1}>条款哈希 {snap.termsHash}</Text>
                    <Divider my={2} />
                    <Text fontSize="xs" color="gray.500" mb={1}>物料包</Text>
                    <HStack flexWrap="wrap" gap={1}>
                      {(materialPackages.data ?? []).filter((m) => m.workId === snap.workId).map((m) => (
                        <Badge key={m.id} colorScheme={m.status === '有效' ? 'green' : 'red'} variant="subtle">{m.region} · {m.status}</Badge>
                      ))}
                    </HStack>
                  </Box>
                ))}
              </Grid>
            </Box>

            {/* 批次合并 */}
            <VStack align="stretch" gap={4}>
              {(batches.data ?? []).map((batch) => {
                const batchReceipts = receiptsOf(batch.id)
                const result = results[batch.id]
                const merged = batch.status === '已合并'
                return (
                  <Box key={batch.id} bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" overflow="hidden">
                    <Flex p={4} justify="space-between" align="center" bg="gray.50">
                      <Box>
                        <HStack>
                          <Heading size="md">{batch.id}</Heading>
                          <Badge colorScheme={merged ? 'green' : 'orange'}>{merged ? '已合并' : '待合并'}</Badge>
                        </HStack>
                        <Text color="gray.500" fontSize="sm" mt={1}>{workTitle(batch.workId)} · {batch.regions.join(' / ')} · 收到于 {batch.receivedAt}</Text>
                      </Box>
                      <Button size="sm" colorScheme="blue" isDisabled={merged} isLoading={mergeMutation.isPending} onClick={() => handleMerge(batch.id)}>
                        {merged ? '已并入草案' : '合并批次'}
                      </Button>
                    </Flex>

                    <Box px={4} pb={4}>
                      <Table size="sm" mt={2}>
                        <Thead><Tr><Th>回执</Th><Th>地区</Th><Th>渠道 / 权利</Th><Th>基于版本</Th><Th>页数</Th><Th>窗口</Th><Th>独占</Th></Tr></Thead>
                        <Tbody>
                          {batchReceipts.map((r) => {
                            const missing = r.pages.filter((p) => !p.present)
                            return (
                              <Tr key={r.id}>
                                <Td><Text fontWeight="600">{r.id}</Text></Td>
                                <Td>{r.region}</Td>
                                <Td>{r.channel} · {r.rights}</Td>
                                <Td><Badge variant="outline">v{r.baseVersion}</Badge></Td>
                                <Td>
                                  <HStack gap={1}>
                                    {r.pages.map((p) => (
                                      <Badge key={p.pageNo} colorScheme={p.present ? 'green' : 'red'} variant={p.present ? 'subtle' : 'solid'} title={p.label}>P{p.pageNo}</Badge>
                                    ))}
                                    {missing.length > 0 && <Text fontSize="xs" color="red.500">缺 {missing.length} 页</Text>}
                                  </HStack>
                                </Td>
                                <Td fontSize="xs">{r.terms.start} → {r.terms.end}</Td>
                                <Td><Badge colorScheme={r.terms.exclusive ? 'purple' : 'gray'}>{r.terms.exclusive ? '独占' : '非独占'}</Badge></Td>
                              </Tr>
                            )
                          })}
                        </Tbody>
                      </Table>

                      {/* 合并结果 */}
                      {result && result.ok && (
                        <Alert status="success" mt={3} borderRadius="6px">
                          <AlertIcon />
                          <Box>
                            <AlertTitle>整批回执已并入发行草案</AlertTitle>
                            <AlertDescription fontSize="sm">
                              已并入 {result.applied.length} 条回执。
                              {result.invalidated ? ' 窗口或独占范围变化，旧审批快照与物料包已立即失效，请重新确认。' : ' 窗口与独占范围未变化，审批快照继续有效。'}
                            </AlertDescription>
                          </Box>
                        </Alert>
                      )}
                      {result && !result.ok && result.reason === '缺页' && (
                        <Alert status="error" mt={3} borderRadius="6px">
                          <AlertIcon />
                          <Box flex={1}>
                            <AlertTitle>缺页 · 批次未并入，已保留原批次</AlertTitle>
                            <AlertDescription fontSize="sm">
                              缺失页面：
                              {(result.missingPages ?? []).map((p) => `${p.receiptId} P${p.pageNo}（${p.label}）`).join('、')}
                            </AlertDescription>
                            <HStack mt={2}>
                              <Button size="xs" colorScheme="red" variant="outline" onClick={() => handleFixAndRetry(batch.id, result)}>补齐缺页并重试</Button>
                              <Button size="xs" variant="ghost" onClick={() => handleMerge(batch.id)}>直接重试</Button>
                            </HStack>
                          </Box>
                        </Alert>
                      )}
                      {result && !result.ok && result.reason === '快照不符' && (
                        <Alert status="warning" mt={3} borderRadius="6px">
                          <AlertIcon />
                          <Box flex={1}>
                            <AlertTitle>与审批快照不符 · 批次未并入，已保留原批次</AlertTitle>
                            <AlertDescription fontSize="sm">
                              <Table size="sm" mt={2} variant="simple">
                                <Thead><Tr><Th>地区</Th><Th>字段</Th><Th>快照值</Th><Th>回执值</Th></Tr></Thead>
                                <Tbody>
                                  {(result.diffs ?? []).map((d, i) => (
                                    <Tr key={i}><Td>{d.region}</Td><Td>{d.field}</Td><Td>{d.expected}</Td><Td>{d.actual}</Td></Tr>
                                  ))}
                                </Tbody>
                              </Table>
                            </AlertDescription>
                            <HStack mt={2}>
                              <Button size="xs" colorScheme="orange" variant="outline" onClick={() => handleFixAndRetry(batch.id, result)}>按当前草案对齐并重试</Button>
                              <Button size="xs" variant="ghost" onClick={() => handleMerge(batch.id)}>直接重试</Button>
                            </HStack>
                          </Box>
                        </Alert>
                      )}
                    </Box>
                  </Box>
                )
              })}
            </VStack>

            {/* 发行草案窗口 */}
            <Heading size="md" mt={6} mb={3}>发行草案窗口（按作品 × 地区）</Heading>
            <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" overflow="hidden">
              <Table size="sm">
                <Thead><Tr><Th>作品</Th><Th>地区</Th><Th>渠道</Th><Th>权利</Th><Th>窗口</Th><Th>独占</Th><Th>状态</Th></Tr></Thead>
                <Tbody>
                  {(draftWindows.data ?? []).map((w) => (
                    <Tr key={w.id}>
                      <Td><Text fontWeight="600">{w.work}</Text></Td>
                      <Td>{w.territory}</Td>
                      <Td>{w.channel}</Td>
                      <Td>{w.rights}</Td>
                      <Td fontSize="xs">{w.start} → {w.end}</Td>
                      <Td><Badge colorScheme={w.exclusive ? 'purple' : 'gray'}>{w.exclusive ? '独占' : '非独占'}</Badge></Td>
                      <Td><Badge colorScheme={w.status === '已确认' ? 'green' : 'orange'}>{w.status}</Badge></Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </Box>
          </TabPanel>

          {/* ============ 作品总表 ============ */}
          <TabPanel px={0} pt={4}>
            <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" overflow="hidden">
              <Table size="sm">
                <Thead><Tr><Th>作品编号</Th><Th>作品名称</Th><Th>类型</Th><Th>发行地区</Th></Tr></Thead>
                <Tbody>
                  {(works.data ?? []).map((w) => (
                    <Tr key={w.id}>
                      <Td><Badge>{w.id}</Badge></Td>
                      <Td><Text fontWeight="600">{w.title}</Text></Td>
                      <Td>{w.type}</Td>
                      <Td><HStack flexWrap="wrap" gap={1}>{w.regions.map((r) => <Badge key={r} variant="outline">{r}</Badge>)}</HStack></Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </Box>
          </TabPanel>

          {/* ============ 历史版本 ============ */}
          <TabPanel px={0} pt={4}>
            <VStack align="stretch" gap={3}>
              {(versions.data ?? []).map((v) => (
                <Box key={v.id} bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={4}>
                  <Flex justify="space-between" align="center">
                    <HStack><Badge colorScheme="blue">v{v.version}</Badge><Text fontWeight="700">{v.summary}</Text></HStack>
                    <Text color="gray.500" fontSize="sm">{v.author} · {v.time}</Text>
                  </Flex>
                  <VStack align="stretch" mt={2} gap={1}>
                    {v.changes.map((c, i) => <Text key={i} fontSize="sm" color="gray.600">· {c}</Text>)}
                  </VStack>
                </Box>
              ))}
            </VStack>
          </TabPanel>

          {/* ============ 回执查回 ============ */}
          <TabPanel px={0} pt={4}>
            <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" overflow="hidden">
              <Table size="sm">
                <Thead><Tr><Th>回执编号</Th><Th>作品</Th><Th>地区</Th><Th>批次</Th><Th>渠道 / 权利</Th><Th>收到日期</Th><Th>状态</Th></Tr></Thead>
                <Tbody>
                  {(receipts.data ?? []).map((r) => (
                    <Tr key={r.id}>
                      <Td><Text fontWeight="600">{r.id}</Text></Td>
                      <Td>{workTitle(r.workId)}</Td>
                      <Td>{r.region}</Td>
                      <Td><Badge variant="outline">{r.batchId}</Badge></Td>
                      <Td>{r.channel} · {r.rights}</Td>
                      <Td fontSize="xs">{r.receivedAt}</Td>
                      <Td><Badge colorScheme={r.status === '已合并' ? 'green' : r.status === '异常' ? 'red' : 'orange'}>{r.status}</Badge></Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </Box>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </Box>
  )
}
