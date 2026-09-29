import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type {
  BackendEndpoint,
  BackendEvent,
  SessionProjectionValues,
  UserQuestionRepository,
} from '@dsh-vscode/domain'
import type { AlphaLoopbackApiClient, AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import { Rc201VersionAdapter } from '../rc201/adapter.js'
import { Rc202UserQuestionRepository } from './user-question-repository.js'
import { normalizeRc202ErrorCode } from './error-vocabulary.js'
import { mapRc202BackendEvent, mapRc202ProjectionValues } from './user-question-projections.js'

/** Exact adapter for DSH dsh-v0.2.0-rc.2 at 639ed015397290b3745d163aafe02ffee4aa3f84. */
export class Rc202VersionAdapter extends Rc201VersionAdapter {
  protected override readonly supportsUserQuestions = true
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.0-rc.2',
    supportedVersion: '0.2.0-rc.2',
    protocolVersion: 'rc202',
    compatibilityPriority: 260,
    fallback: false,
  }

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return { ...super.createTransportOptions(endpoint), normalizeErrorCode: normalizeRc202ErrorCode }
  }

  protected override createUserQuestionRepository(transport: AlphaLoopbackApiClient): UserQuestionRepository {
    return new Rc202UserQuestionRepository(transport)
  }

  protected override mapProjectionValues(values: Readonly<Record<string, unknown>>): SessionProjectionValues {
    return mapRc202ProjectionValues(values)
  }

  protected override mapBackendEvent(event: BackendEvent): BackendEvent {
    return mapRc202BackendEvent(event)
  }
}
