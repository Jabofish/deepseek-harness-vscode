import type { ModsBandRepository, ModsBandReadResult, ModsBandSnapshot } from '@dsh-vscode/domain'

export class ModsBandUseCases {
  public constructor(private readonly repository: ModsBandRepository) {}
  public read(
    sessionId: string,
    afterGeneration?: number,
    signal?: AbortSignal,
  ): Promise<ModsBandReadResult> {
    return this.repository.read(sessionId, afterGeneration, signal)
  }
  public press(
    sessionId: string,
    generation: number,
    actionId: string,
    signal?: AbortSignal,
  ): Promise<ModsBandSnapshot> {
    return this.repository.press(sessionId, generation, actionId, signal)
  }
}
