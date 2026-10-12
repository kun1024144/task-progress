export type TaskStatus = 'running' | 'done' | 'failed'

export type Task = {
  /** the subagent's id */
  id: string
  /** the Agent tool call that started it: its transcript row */
  toolUseId: string
  name: string
  type: string
  startedAt: number
  endedAt: number | null
  status: TaskStatus
  /** the estimate the bar runs against, from past runs of this agent type */
  expectedMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'task-progress': { tasks: Task[]; now: number }
  }
}
