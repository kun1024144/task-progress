/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
// 任務進度條: every subagent the session starts (foreground or background) gets
// a row in the band above the prompt box: a progress bar, a percent and the
// minutes likely left. A subagent reports no progress of its own, so the bar
// runs against how long this agent type took before (kept across sessions in
// $.store), capped at 95% until the task really ends. A finished task turns
// into a green check; pressing a task's name scrolls the transcript back to
// the Agent call that started it.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Task, TaskStatus } from '../types'

const tasksAtom = atom({ plugin: 'task-progress', key: 'tasks' } as const, [] as Task[])
const nowAtom = atom({ plugin: 'task-progress', key: 'now' } as const, 0)

const DEFAULT_EXPECTED_MS = 3 * 60_000
const TICK_MS = 5_000
const KEEP_FINISHED_MS = 10 * 60_000
const NAME_MAX = 28

type Average = { ms: number; n: number }

function storeKey(type: string): string {
  return `avg:${type}`
}

async function expectedFor($: EngineInterface, type: string): Promise<number> {
  const avg = (await $.store.get(storeKey(type)).catch(() => undefined)) as Average | undefined
  return avg && typeof avg.ms === 'number' && avg.ms > 0 ? avg.ms : DEFAULT_EXPECTED_MS
}

async function learn($: EngineInterface, type: string, ms: number): Promise<void> {
  const avg = (await $.store.get(storeKey(type)).catch(() => undefined)) as Average | undefined
  const n = avg && typeof avg.n === 'number' ? Math.min(avg.n, 9) : 0
  const prev = avg && typeof avg.ms === 'number' ? avg.ms : ms
  // a running mean over the last ten runs or so
  await $.store.set(storeKey(type), { ms: Math.round((prev * n + ms) / (n + 1)), n: n + 1 }).catch(() => undefined)
}

export function progress(task: Task, now: number): { percent: number; minutesLeft: number } {
  if (task.status !== 'running') return { percent: 100, minutesLeft: 0 }
  const elapsed = Math.max(0, now - task.startedAt)
  const percent = Math.min(95, Math.floor((elapsed / task.expectedMs) * 100))
  const minutesLeft = Math.ceil(Math.max(0, task.expectedMs - elapsed) / 60_000)
  return { percent, minutesLeft }
}

export function bar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function shorten(name: string): string {
  const points = [...name.replace(/\s+/g, ' ').trim()]
  return points.length > NAME_MAX ? `${points.slice(0, NAME_MAX - 1).join('')}…` : points.join('')
}

// the module's own timer; a reload starts it over
let cancelTick: (() => void) | null = null

async function finish($: EngineInterface, id: string, status: TaskStatus): Promise<void> {
  const now = await $.clock.now()
  let learned: Task | null = null
  await update($, tasksAtom, tasks =>
    (tasks ?? []).map(t => {
      if (t.id !== id || t.status !== 'running') return t
      learned = t
      return { ...t, status, endedAt: now }
    }),
  )
  const done = learned as Task | null
  if (done !== null && status === 'done') await learn($, done.type, now - done.startedAt)
}

async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const agents = await $.agent.list().catch(() => null)
  const tasks = (await read($, tasksAtom)) ?? []
  // the engine's own word on agents that ended without a turn.complete we saw
  if (agents !== null) {
    for (const t of tasks) {
      if (t.status !== 'running') continue
      const a = agents.find(x => x.id === t.id)
      if (a?.status === 'completed') await finish($, t.id, 'done')
      else if (a?.status === 'failed' || a?.status === 'killed') await finish($, t.id, 'failed')
    }
  }
  await update($, tasksAtom, ts =>
    (ts ?? []).filter(t => t.endedAt === null || now - t.endedAt < KEEP_FINISHED_MS),
  )
  await update($, nowAtom, () => now)
  const left = (await read($, tasksAtom)) ?? []
  if (left.length === 0 && cancelTick !== null) {
    cancelTick()
    cancelTick = null
  }
}

function startTicking($: EngineInterface): void {
  if (cancelTick !== null) return
  const timer = $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
  cancelTick = () => timer.cancel()
}

export const register: Register = on => {
  // A reload starts the module over: pick the timer back up for tasks still shown.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const tasks = (await read($, tasksAtom)) ?? []
    if (tasks.length > 0) startTicking($)
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || result.agentId === undefined) return result
    const now = await $.clock.now()
    const task: Task = {
      id: result.agentId,
      toolUseId: e.tool_use_id,
      name: e.description || e.subagentType,
      type: e.subagentType,
      startedAt: now,
      endedAt: null,
      status: 'running',
      expectedMs: await expectedFor($, e.subagentType),
    }
    await update($, tasksAtom, tasks => [...(tasks ?? []).filter(t => t.id !== task.id), task])
    await update($, nowAtom, () => now)
    startTicking($)
    return result
  }).catch(($, e, next) => next(e)) // a fault here must never stop the subagent itself

  // A subagent's run ends in its loop's turn.complete.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      const ok = e.reason === 'answer' && !e.isAborted
      await finish($, e.agentId, ok ? 'done' : 'failed')
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const tasks = (await read($, tasksAtom)) ?? []
    if (e.props.hasSurvey || tasks.length === 0) return below
    const now = Math.max((await read($, nowAtom)) ?? 0, ...tasks.map(t => t.startedAt))
    const { Box, Text, Button } = $.ui.resolve(e)
    const barWidth = Math.max(8, Math.min(24, e.props.bodyColumns - NAME_MAX - 24))
    const running = tasks.filter(t => t.status === 'running').length
    const hasFinished = tasks.some(t => t.status !== 'running')

    return (
      <Box flexDirection="column">
        {below}
        <Box key="head">
          <Text key="title" bold>
            任務進度 {running > 0 ? `· ${running} 個進行中` : '· 全部完成'}
          </Text>
          {hasFinished ? (
            <>
              <Text key="gap"> </Text>
              <Button
                key="clear"
                plain
                label="清除已完成"
                onPress={() => update($, tasksAtom, ts => (ts ?? []).filter(t => t.status === 'running'))}
              />
            </>
          ) : null}
        </Box>
        {tasks.map(t => {
          const { percent, minutesLeft } = progress(t, now)
          const color = t.status === 'done' ? 'success' : t.status === 'failed' ? 'error' : 'claude'
          const tail =
            t.status === 'done'
              ? '✓ 完成'
              : t.status === 'failed'
                ? '✗ 失敗'
                : `${percent}%  ${percent >= 95 || minutesLeft <= 0 ? '快完成了' : `約剩 ${minutesLeft} 分鐘`}`
          return (
            <Box key={`row:${t.id}`} marginLeft={2}>
              <Button
                key={`task:${t.id}`}
                plain
                label={shorten(t.name)}
                onPress={() => void $.ui.scroll({ to: { requestId: t.toolUseId }, block: 'start' }).catch(() =>
                  $.ui.toast('那段對話已不在畫面記錄裡了'),
                )}
              />
              <Text color={color}>
                {' '}
                {bar(percent, barWidth)}{' '}
              </Text>
              <Text color={t.status === 'running' ? undefined : color} dimColor={t.status === 'running'}>
                {tail}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
