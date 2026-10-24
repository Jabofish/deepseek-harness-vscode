import type {
  BillingCandidate,
  BillingExchangeRate,
  BillingPrice,
  BillingRoute,
  BillingSettings,
} from '@dsh-vscode/domain'

export interface BillingExchangeSource {
  read(signal: AbortSignal): Promise<BillingExchangeRate>
}

export interface BillingSettingsPort {
  read(): Promise<BillingSettings>
  save(settings: Omit<BillingSettings, 'revision'>, expectedRevision: number): Promise<BillingSettings>
}

export interface BillingReference {
  readonly status: 'found' | 'missing' | 'unsupported'
  readonly price?: BillingPrice
  readonly fetchedAt: string
}

export interface BillingReferenceSource {
  read(providerId: string, modelId: string, signal: AbortSignal): Promise<BillingReference>
  match?(route: BillingRoute, signal: AbortSignal, label?: string): Promise<BillingMatch>
  search?(query: string, offset: number, signal: AbortSignal): Promise<BillingReferenceList>
}
export interface BillingReferenceList {
  readonly entries: readonly BillingCandidate[]
  readonly hasMore: boolean
  readonly nextOffset: number
  readonly fetchedAt: string
}
export interface BillingMatch extends BillingReference {
  readonly candidates: readonly BillingCandidate[]
  readonly reference?: BillingCandidate
}
export interface BillingPriceResolver {
  resolve(routes: readonly BillingRoute[], signal: AbortSignal): Promise<readonly BillingPrice[]>
}
