import type { BillingCandidate, BillingPrice, BillingRoute, BillingSettings } from '@dsh-vscode/domain'

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
}
export interface BillingMatch extends BillingReference {
  readonly candidates: readonly BillingCandidate[]
  readonly reference?: BillingCandidate
}
export interface BillingPriceResolver {
  resolve(routes: readonly BillingRoute[], signal: AbortSignal): Promise<readonly BillingPrice[]>
}
