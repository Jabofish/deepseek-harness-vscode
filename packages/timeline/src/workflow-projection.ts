import type { TimelineNode } from './nodes.js'
import { findNodeIndexFromEnd } from './node-lookup.js'

function workflowPhaseKey(phase: string | null): string {
  return phase === null ? 'missing' : `value:${phase.length}:${phase}`
}

export function updateWorkflow(
  nodes: TimelineNode[],
  runId: string,
  update: (
    workflow: Extract<TimelineNode, { readonly kind: 'workflow' }>['workflow'],
  ) => Extract<TimelineNode, { readonly kind: 'workflow' }>['workflow'],
): void {
  const index = findNodeIndexFromEnd(nodes, (node) => node.kind === 'workflow' && node.workflow.id === runId)
  const node = index < 0 ? undefined : nodes[index]
  if (node?.kind !== 'workflow') return
  nodes[index] = { ...node, workflow: update(node.workflow) }
}

export function addWorkflowMember(
  workflow: Extract<TimelineNode, { readonly kind: 'workflow' }>['workflow'],
  phase: string | null,
  member: Extract<
    TimelineNode,
    { readonly kind: 'workflow' }
  >['workflow']['stages'][number]['members'][number],
): Extract<TimelineNode, { readonly kind: 'workflow' }>['workflow'] {
  if (workflow.stages.some((stage) => stage.members.some((entry) => entry.seq === member.seq)))
    return workflow
  const id = workflowPhaseKey(phase)
  const index = workflow.stages.findIndex((stage) => stage.id === id)
  if (index < 0) return { ...workflow, stages: [...workflow.stages, { id, phase, members: [member] }] }
  const stages = [...workflow.stages]
  const stage = stages[index]
  if (stage !== undefined) stages[index] = { ...stage, members: [...stage.members, member] }
  return { ...workflow, stages }
}

export function settleWorkflowMember(
  workflow: Extract<TimelineNode, { readonly kind: 'workflow' }>['workflow'],
  seq: number,
  outcome: 'completed' | 'failed' | 'cancelled',
): Extract<TimelineNode, { readonly kind: 'workflow' }>['workflow'] {
  return {
    ...workflow,
    stages: workflow.stages.map((stage) => ({
      ...stage,
      members: stage.members.map((member) => (member.seq === seq ? { ...member, status: outcome } : member)),
    })),
  }
}
