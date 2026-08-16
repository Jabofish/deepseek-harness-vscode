import type { ReactElement } from 'react'
import type { SkillDescriptor } from '@dsh-vscode/domain'

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
              <strong>{skill.name}</strong>
              <span>
                {skill.source} · {skill.enabled ? 'enabled' : 'disabled'}
              </span>
              <p>{skill.description}</p>
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
