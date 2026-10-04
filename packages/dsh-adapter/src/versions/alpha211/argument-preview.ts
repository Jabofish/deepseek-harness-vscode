type Container = {
  kind: 'object' | 'array'
  phase: 'first' | 'key' | 'colon' | 'value' | 'after'
}

/** Bounded JSON display projection. No argument body is retained or executed. */
export class ArgumentPreview {
  private readonly stack: Container[] = []
  private readonly keys = new Set<string>()
  private readonly counts = new Map<string, number>()
  private started = false
  private invalid = false
  private stringKind: 'key' | 'value' | undefined
  private escaped = false
  private unicode: string | undefined
  private text = ''
  private length = 0
  private key = ''
  private scalar: string | undefined
  private description: string | undefined
  private filePath: string | undefined

  public append(delta: string): void {
    for (const character of delta) {
      if (this.invalid) return
      if (this.stringKind !== undefined) {
        this.stringCharacter(character)
        continue
      }
      if (this.scalar !== undefined) {
        if (!/[\x20\t\r\n,}\]]/u.test(character)) {
          this.scalar += character
          if (this.scalar.length > 128) this.invalid = true
          continue
        }
        try {
          const value: unknown = JSON.parse(this.scalar)
          if (typeof value === 'object' && value !== null) this.invalid = true
        } catch {
          this.invalid = true
        }
        this.scalar = undefined
        this.finishValue()
        if (this.invalid) return
      }
      if (/[\x20\t\r\n]/u.test(character)) continue
      if (!this.started) {
        this.started = true
        if (character !== '{') this.invalid = true
        else this.stack.push({ kind: 'object', phase: 'first' })
        continue
      }
      const container = this.stack.at(-1)
      if (container === undefined) {
        this.invalid = true
        return
      }
      if (container.phase === 'first' && character === (container.kind === 'object' ? '}' : ']')) {
        this.closeContainer()
      } else if (container.kind === 'object' && (container.phase === 'first' || container.phase === 'key')) {
        if (character === '"') this.startString('key')
        else this.invalid = true
      } else if (container.phase === 'colon') {
        if (character === ':') container.phase = 'value'
        else this.invalid = true
      } else if (container.phase === 'value' || container.phase === 'first') {
        if (character === '"') this.startString('value')
        else if (character === '{' || character === '[') {
          if (this.stack.length >= 64) this.invalid = true
          else this.stack.push({ kind: character === '{' ? 'object' : 'array', phase: 'first' })
        } else if (/[-0-9tfn]/u.test(character)) this.scalar = character
        else this.invalid = true
      } else if (container.phase === 'after') {
        if (character === ',') container.phase = container.kind === 'object' ? 'key' : 'value'
        else if (character === (container.kind === 'object' ? '}' : ']')) this.closeContainer()
        else this.invalid = true
      }
    }
  }

  public snapshot(): {
    readonly description?: string
    readonly filePath?: string
    readonly contentCharacters?: number
  } {
    if (this.invalid) return {}
    const contentCharacters = [...this.counts.values()].reduce((total, count) => total + count, 0)
    return {
      ...(this.description === undefined ? {} : { description: this.description }),
      ...(this.filePath === undefined ? {} : { filePath: this.filePath }),
      ...(this.counts.size === 0 ? {} : { contentCharacters }),
    }
  }

  private finishValue(): void {
    const container = this.stack.at(-1)
    if (container !== undefined) container.phase = 'after'
  }

  private closeContainer(): void {
    this.stack.pop()
    this.finishValue()
  }

  private startString(kind: 'key' | 'value'): void {
    this.stringKind = kind
    this.escaped = false
    this.unicode = undefined
    this.text = ''
    this.length = 0
    if (kind === 'value' && this.stack.length === 1 && this.contentField()) this.counts.set(this.key, 0)
  }

  private stringCharacter(character: string): void {
    if (this.unicode !== undefined) {
      if (!/^[0-9a-f]$/iu.test(character)) {
        this.invalid = true
        return
      }
      this.unicode += character
      if (this.unicode.length === 4) {
        this.decoded(String.fromCharCode(Number.parseInt(this.unicode, 16)))
        this.unicode = undefined
      }
      return
    }
    if (this.escaped) {
      this.escaped = false
      if (character === 'u') this.unicode = ''
      else {
        const escapes: Record<string, string> = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        }
        const value = escapes[character]
        if (value === undefined) this.invalid = true
        else this.decoded(value)
      }
      return
    }
    if (character === '\\') this.escaped = true
    else if (character === '"') {
      const kind = this.stringKind
      this.stringKind = undefined
      if (kind === 'key') {
        if (this.stack.length === 1) {
          if (this.keys.has(this.text) || this.length > 128 || this.keys.size >= 128) this.invalid = true
          this.key = this.text
          this.keys.add(this.key)
        }
        const container = this.stack.at(-1)
        if (container !== undefined) container.phase = 'colon'
      } else {
        if (this.stack.length === 1 && this.key === 'file_path' && this.length <= 4_096)
          this.filePath = this.text
        this.finishValue()
      }
    } else if ((character.codePointAt(0) ?? 0) < 0x20) this.invalid = true
    else this.decoded(character)
  }

  private decoded(value: string): void {
    this.length += value.length
    if (this.stack.length !== 1) return
    const maximum =
      this.stringKind === 'key'
        ? 129
        : this.key === 'file_path'
          ? 4_096
          : this.key === 'description'
            ? 512
            : 0
    if (this.text.length < maximum) this.text += value.slice(0, maximum - this.text.length)
    if (this.stringKind !== 'value') return
    if (this.key === 'description') this.description = this.text
    if (this.contentField()) this.counts.set(this.key, this.length)
  }

  private contentField(): boolean {
    return this.key === 'content' || this.key === 'old_string' || this.key === 'new_string'
  }
}
