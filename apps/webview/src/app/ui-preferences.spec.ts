// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONVERSATION_FONT_SIZE_STORAGE_KEY,
  DEFAULT_CONVERSATION_FONT_SIZE,
  DEFAULT_THEME_PREFERENCE,
  THEME_PREFERENCE_STORAGE_KEY,
  readConversationFontSize,
  readThemePreference,
  rememberConversationFontSize,
  rememberThemePreference,
} from './ui-preferences.js'

describe('conversation UI preferences', () => {
  afterEach(() => {
    window.localStorage.clear()
  })

  it('defaults to medium and restores a saved preset', () => {
    expect(readConversationFontSize()).toBe(DEFAULT_CONVERSATION_FONT_SIZE)

    rememberConversationFontSize('large')

    expect(readConversationFontSize()).toBe('large')
    expect(window.localStorage.getItem(CONVERSATION_FONT_SIZE_STORAGE_KEY)).toBe('large')
  })

  it('ignores an unknown stored preset', () => {
    window.localStorage.setItem(CONVERSATION_FONT_SIZE_STORAGE_KEY, 'extra-large')

    expect(readConversationFontSize()).toBe(DEFAULT_CONVERSATION_FONT_SIZE)
  })

  it('does not let restricted storage block the preference', () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('storage unavailable')
      }),
      setItem: vi.fn(() => {
        throw new Error('storage unavailable')
      }),
    }

    expect(readConversationFontSize(storage)).toBe(DEFAULT_CONVERSATION_FONT_SIZE)
    expect(() => rememberConversationFontSize('small', storage)).not.toThrow()
  })

  it('defaults to system and restores a saved theme', () => {
    expect(readThemePreference()).toBe(DEFAULT_THEME_PREFERENCE)

    rememberThemePreference('light')

    expect(readThemePreference()).toBe('light')
    expect(window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY)).toBe('light')
  })

  it('ignores an unknown stored theme', () => {
    window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, 'sepia')

    expect(readThemePreference()).toBe(DEFAULT_THEME_PREFERENCE)
  })

  it('does not let restricted storage block the theme preference', () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('storage unavailable')
      }),
      setItem: vi.fn(() => {
        throw new Error('storage unavailable')
      }),
    }

    expect(readThemePreference(storage)).toBe(DEFAULT_THEME_PREFERENCE)
    expect(() => rememberThemePreference('dark', storage)).not.toThrow()
  })
})
