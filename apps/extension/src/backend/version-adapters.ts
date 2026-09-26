import {
  type DshVersionAdapter,
  Alpha151VersionAdapter,
  Alpha152VersionAdapter,
  Alpha161VersionAdapter,
  Alpha162VersionAdapter,
  Alpha171VersionAdapter,
  Alpha172VersionAdapter,
  Alpha132VersionAdapter,
  Alpha13VersionAdapter,
  Alpha5VersionAdapter,
  Alpha4VersionAdapter,
  Alpha3VersionAdapter,
  Alpha2VersionAdapter,
  Alpha1VersionAdapter,
  LegacyRc1VersionAdapter,
  LegacyRc2VersionAdapter,
  LegacyRc5VersionAdapter,
  Rc02VersionAdapter,
  Rc03VersionAdapter,
  Rc6VersionAdapter,
  Rc7VersionAdapter,
  Rc8VersionAdapter,
  Rc11VersionAdapter,
  Rc12VersionAdapter,
  Rc13VersionAdapter,
  Rc151VersionAdapter,
  Rc152VersionAdapter,
  Rc153VersionAdapter,
  Rc171VersionAdapter,
  Rc172VersionAdapter,
} from '@dsh-vscode/dsh-adapter'
import type { createAdapterOptions } from './adapter-options.js'

export function createVersionAdapters(
  adapterOptions: ReturnType<typeof createAdapterOptions>,
): readonly DshVersionAdapter[] {
  const alpha2Adapter = new Alpha2VersionAdapter(adapterOptions)
  const alpha132Adapter = new Alpha132VersionAdapter(adapterOptions)
  const alpha151Adapter = new Alpha151VersionAdapter(adapterOptions)
  const alpha152Adapter = new Alpha152VersionAdapter(adapterOptions)
  const rc151Adapter = new Rc151VersionAdapter(adapterOptions)
  const rc152Adapter = new Rc152VersionAdapter(adapterOptions)
  const alpha161Adapter = new Alpha161VersionAdapter(adapterOptions)
  const alpha162Adapter = new Alpha162VersionAdapter(adapterOptions)
  const alpha171Adapter = new Alpha171VersionAdapter(adapterOptions)
  const alpha172Adapter = new Alpha172VersionAdapter(adapterOptions)
  const rc153Adapter = new Rc153VersionAdapter(adapterOptions)
  const rc171Adapter = new Rc171VersionAdapter(adapterOptions)
  const rc172Adapter = new Rc172VersionAdapter(adapterOptions)
  const alpha13Adapter = new Alpha13VersionAdapter(adapterOptions)
  const rc13Adapter = new Rc13VersionAdapter(adapterOptions)
  const alpha3Adapter = new Alpha3VersionAdapter(adapterOptions)
  const alpha5Adapter = new Alpha5VersionAdapter(adapterOptions)
  const alpha4Adapter = new Alpha4VersionAdapter(adapterOptions)
  const alpha1Adapter = new Alpha1VersionAdapter(adapterOptions)
  const rc12Adapter = new Rc12VersionAdapter(adapterOptions)
  const rc11Adapter = new Rc11VersionAdapter(adapterOptions)
  const rc8Adapter = new Rc8VersionAdapter(adapterOptions)
  const rc7Adapter = new Rc7VersionAdapter(adapterOptions)
  const rc6Adapter = new Rc6VersionAdapter(adapterOptions)
  const rc03Adapter = new Rc03VersionAdapter(adapterOptions)
  const rc02Adapter = new Rc02VersionAdapter(adapterOptions)
  const legacyRc5Adapter = new LegacyRc5VersionAdapter(adapterOptions)
  const legacyRc2Adapter = new LegacyRc2VersionAdapter(adapterOptions)
  const legacyRc1Adapter = new LegacyRc1VersionAdapter(adapterOptions)
  const adapters = [
    rc172Adapter,
    rc171Adapter,
    alpha172Adapter,
    alpha171Adapter,
    alpha162Adapter,
    alpha161Adapter,
    rc153Adapter,
    rc152Adapter,
    rc151Adapter,
    alpha152Adapter,
    alpha151Adapter,
    alpha132Adapter,
    alpha13Adapter,
    rc13Adapter,
    alpha5Adapter,
    alpha4Adapter,
    alpha3Adapter,
    alpha2Adapter,
    alpha1Adapter,
    rc12Adapter,
    rc11Adapter,
    rc8Adapter,
    rc7Adapter,
    rc6Adapter,
    rc03Adapter,
    rc02Adapter,
    legacyRc5Adapter,
    legacyRc2Adapter,
    legacyRc1Adapter,
  ] as const
  return adapters
}
