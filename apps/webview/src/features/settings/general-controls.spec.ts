import { describe, expect, it } from 'vitest'
import type { DshSettingsSnapshot } from '../../app/store.js'
import { parsePermissionCatalog } from '../../app/store/permission-catalog.js'
import { PERMISSION_DEFAULT_SETTING_PATH } from '../../app/ui-preferences.js'
import { generalRowOptions, hasPreferencesContent, visibleGeneralRows } from './general-controls.js'
import { isValidGeneralSettingChange } from './provider-helpers.js'

/** The rc.5 `permission` namespace: `defaultPreset` is `z.string()`, not an enum. */
function rc5PermissionSnapshot(): DshSettingsSnapshot {
  return {
    schema: {
      version: 'rc2-settings-v1',
      writable: true,
      hasDocument: false,
      fields: [
        {
          path: PERMISSION_DEFAULT_SETTING_PATH,
          label: 'defaultPreset',
          type: 'string',
          required: false,
          restartRequired: false,
        },
      ],
      namespaces: [],
    },
    values: { permission: {} },
  }
}

const choices = ['read-only', 'workspace-write', 'danger-full-access']

describe('permission default row on rc.5', () => {
  it('offers the catalog default choices for a string-typed field', () => {
    const snapshot = rc5PermissionSnapshot()
    const field = snapshot.schema.fields[0]
    expect(
      generalRowOptions(field, PERMISSION_DEFAULT_SETTING_PATH, { permissionDefaultOptions: choices }),
    ).toEqual(choices)
    expect(
      visibleGeneralRows(snapshot, { permissionDefaultOptions: choices }).map((row) => row.path),
    ).toEqual([PERMISSION_DEFAULT_SETTING_PATH])
    expect(hasPreferencesContent(snapshot, { permissionDefaultOptions: choices })).toBe(true)
  })

  it('stays hidden until the host publishes choices', () => {
    const snapshot = rc5PermissionSnapshot()
    expect(visibleGeneralRows(snapshot)).toEqual([])
    expect(visibleGeneralRows(snapshot, { permissionDefaultOptions: [] })).toEqual([])
  })

  it('writes only a preset the catalog offers', () => {
    const snapshot = rc5PermissionSnapshot()
    expect(isValidGeneralSettingChange(snapshot, PERMISSION_DEFAULT_SETTING_PATH, 'read-only', choices)).toBe(
      true,
    )
    expect(isValidGeneralSettingChange(snapshot, PERMISSION_DEFAULT_SETTING_PATH, 'auto', choices)).toBe(
      false,
    )
    expect(isValidGeneralSettingChange(snapshot, PERMISSION_DEFAULT_SETTING_PATH, 'read-only')).toBe(false)
  })

  it('carries defaultOptions from the Host catalog and rejects a malformed list', () => {
    expect(
      parsePermissionCatalog({
        items: ['read-only', 'auto'],
        defaultPreset: 'read-only',
        defaultOptions: ['read-only'],
      }),
    ).toEqual({ items: ['read-only', 'auto'], defaultPreset: 'read-only', defaultOptions: ['read-only'] })
    expect(parsePermissionCatalog({ items: ['read-only'], defaultOptions: [1] })).toBeUndefined()
    expect(parsePermissionCatalog({ items: ['read-only'] })).toEqual({ items: ['read-only'] })
  })
})
