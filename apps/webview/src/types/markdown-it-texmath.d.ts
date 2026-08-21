declare module 'markdown-it-texmath' {
  import type MarkdownIt from 'markdown-it'
  import type { KatexOptions } from 'katex'
  import type * as Katex from 'katex'

  interface TexmathOptions {
    readonly engine: typeof Katex
    readonly delimiters: 'dollars' | 'brackets' | 'doxygen' | 'gitlab' | 'julia' | 'kramdown' | 'beg_end'
    readonly katexOptions?: KatexOptions
  }

  const texmath: (md: MarkdownIt, options: TexmathOptions) => void
  export default texmath
}
