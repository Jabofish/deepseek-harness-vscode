import type { PropsWithChildren, ReactElement } from 'react'
import { unimplemented } from '@dsh-vscode/domain'

export interface DrawerProps extends PropsWithChildren {
  readonly title: string
  readonly open: boolean
  readonly side?: 'left' | 'right'
  readonly onClose: () => void
}

export function Drawer(props: DrawerProps): ReactElement | null {
  return unimplemented<ReactElement | null>('accessible reusable drawer', [
    'render nothing while closed without losing caller-controlled state',
    'use an accessible dialog label, focus trapping, Escape close, and focus restoration',
    'fit narrow VS Code sidebars and respect reduced motion',
    'use VS Code theme variables only',
    `title ${props.title}; side ${props.side ?? 'right'}; open ${String(props.open)}; children present ${String(props.children !== undefined)}; close callback ${typeof props.onClose}`,
  ])
}
