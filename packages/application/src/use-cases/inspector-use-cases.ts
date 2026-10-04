import type { InspectorDevtoolsRepository, InspectorDevtoolsTarget } from '@dsh-vscode/domain'
/** The result remains Extension Host owned; only availability/actions are public. */
export class InspectorUseCases {
  public constructor(private readonly repository: InspectorDevtoolsRepository) {}
  public discover(signal?: AbortSignal): Promise<InspectorDevtoolsTarget> {
    return this.repository.discover(signal)
  }
}
