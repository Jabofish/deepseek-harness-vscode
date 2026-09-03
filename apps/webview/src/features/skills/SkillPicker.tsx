import type { ReactElement } from 'react'
import type { SkillDescriptor } from '@dsh-vscode/domain'
import { ContentFlow } from '../../components/common/ContentFlow.js'

export interface SkillPickerProps {
  readonly skills: readonly SkillDescriptor[]
  readonly onExecute: (skillId: string) => void
  readonly onRefresh: () => void
}

export function SkillPicker(props: SkillPickerProps): ReactElement {
  return (
    <section className="dsh-skills" aria-labelledby="skills-title">
      <header>
        <h2 id="skills-title">Skills</h2>
        <button type="button" onClick={props.onRefresh}>
          Refresh
        </button>
      </header>
      {props.skills.length === 0 ? (
        <p>Skills are unavailable until DSH reports a session context.</p>
      ) : (
        <ul>
          {props.skills.map((skill) => (
            <li key={skill.id}>
              <ContentFlow as="strong">{skill.name}</ContentFlow>
              <ContentFlow as="span">
                {skill.source} · {skill.enabled ? 'enabled' : 'disabled'}
              </ContentFlow>
              <ContentFlow as="p">{skill.description}</ContentFlow>
              {skill.whenToUse === undefined ? null : <ContentFlow as="p">{skill.whenToUse}</ContentFlow>}
              <button type="button" disabled={!skill.enabled} onClick={() => props.onExecute(skill.id)}>
                Use skill
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
