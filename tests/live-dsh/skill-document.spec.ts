import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LIVE_TIMEOUT_MS, startManagedRuntime, type ManagedLiveRuntime } from './harness.js'
import { publicSkills, openSkillDocument } from '../../apps/extension/src/backend/skill-documents.js'

describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live skill documentation', () => {
  it(
    'discovers a real filesystem skill and resolves its instruction document',
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-skill-doc-home-'))
      let runtime: ManagedLiveRuntime | undefined
      try {
        const skillDirectory = path.join(home, 'skills', 'vscode-doc-probe')
        await mkdir(skillDirectory, { recursive: true })
        const content =
          '---\nname: vscode-doc-probe\ndescription: Documentation read probe\ndisable-model-invocation: true\n---\n# Probe instructions\nRead only.\n'
        await writeFile(path.join(skillDirectory, 'SKILL.md'), content)
        runtime = await startManagedRuntime({ dshHome: home, removeDshHomeOnStop: true })
        const workspace = await runtime.backend.workspaces.create({
          name: 'Skill document probe',
          path: runtime.snapshot.workspace,
        })
        const session = await runtime.backend.sessions.create({
          workspaceId: workspace.id,
          configuration: {
            preset: '',
            toolMode: 'native',
            permissionPreset: '',
            planMode: false,
            model: { providerId: '', modelId: '' },
          },
        })
        const skills = await runtime.backend.skills.list(session.id)
        const skill = skills.find((entry) => entry.name === 'vscode-doc-probe')
        expect(skill?.enabled).toBe(false)
        expect(skill?.documentPath).toBeDefined()
        if (skill?.documentPath === undefined) throw new Error('No provider document path')
        expect(publicSkills([skill])[0]).toMatchObject({ hasDocument: true })
        expect(publicSkills([skill])[0]).not.toHaveProperty('documentPath')
        await openSkillDocument(
          skill.documentPath,
          async (target) => {
            expect(await readFile(target, 'utf8')).toBe(content)
          },
          new AbortController().signal,
        )
      } finally {
        await runtime?.stop()
      }
    },
    LIVE_TIMEOUT_MS,
  )
})
