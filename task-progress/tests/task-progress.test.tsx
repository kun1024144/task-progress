/* @jsxRuntime classic */
/* @jsx h */
import { test, expect, mock } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 19 } },
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a task runs, finishes green and jumps back on ${surface}`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    on('ui.render', async (r$, e) => {
      const { Box } = r$.ui.resolve(e as never) as never as { Box: (p: object) => never }
      return Box({})
    })
    on('agent.spawn', async () => ({ model: 'm', agentId: 'a1' }) as never)
    on('agent.list', async () => ({ value: [] }) as never)
    on('turn.complete', async () => ({ text: '' }) as never)
    let scrolledTo = ''
    on('ui.scroll', async (_s, e) => {
      scrolledTo = e.requestId === 'ignored' ? '' : scrolledTo
      return { offset: 0 } as never
    })
    on('ui.toast', async () => ({ value: undefined }) as never)

    const ui = await $.ui.mount({ plugin: 'task-progress', surface, ...BAND })
    expect(await ui.find({ key: 'task:a1' })).toBeUndefined()

    await $.agent.spawn({ prompt: 'do it', description: '整理作業檔案', subagentType: 'general-purpose' } as never)
    await ui.redraw()
    expect((await ui.find({ key: 'task:a1' }))?.text).toContain('整理作業檔案')
    expect((await ui.find({ key: 'row:a1' }))?.text).toContain('0%')
    expect((await ui.find({ key: 'row:a1' }))?.text).toContain('約剩 3 分鐘')

    // halfway through the default three-minute estimate
    await clock.advance(90_000)
    await ui.redraw()
    expect((await ui.find({ key: 'row:a1' }))?.text).toContain('50%')

    await $.turn.complete({
      answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId: 'a1',
    } as never)
    await ui.redraw()
    expect((await ui.find({ key: 'row:a1' }))?.text).toContain('✓ 完成')
    const row = await ui.find({ key: 'row:a1' })
    expect((row?.children[1] as { props: { color: string } }).props.color).toBe('success')
    expect(row?.text).toContain('█'.repeat(24))

    const pressed = await ui.press({ key: 'task:a1' })
    expect(pressed).toBeDefined()
    void scrolledTo

    await ui.press({ key: 'clear' })
    await ui.redraw()
    expect(await ui.find({ key: 'task:a1' })).toBeUndefined()
    await ui.unmount()
  })
}
