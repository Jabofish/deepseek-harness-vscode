import type { ReactElement } from 'react'

export type IconName =
  | 'add'
  | 'alert'
  | 'arrow-down'
  | 'box'
  | 'branch'
  | 'check'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'clock'
  | 'close'
  | 'copy'
  | 'edit'
  | 'file'
  | 'folder'
  | 'image'
  | 'list'
  | 'model'
  | 'paperclip'
  | 'plan'
  | 'person'
  | 'play'
  | 'refresh'
  | 'search'
  | 'send'
  | 'settings'
  | 'session'
  | 'sparkles'
  | 'status'
  | 'stop'
  | 'target'
  | 'terminal'
  | 'thumb-down'
  | 'thumb-up'
  | 'tool'
  | 'trash'
  | 'users'

export interface IconProps {
  readonly name: IconName
  readonly className?: string
}

export function Icon({ name, className }: IconProps): ReactElement {
  const classes = className === undefined ? 'dsh-icon' : `dsh-icon ${className}`
  return (
    <svg
      className={classes}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {renderIcon(name)}
    </svg>
  )
}

function renderIcon(name: IconName): ReactElement {
  switch (name) {
    case 'add':
      return (
        <>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </>
      )
    case 'alert':
      return (
        <>
          <path d="m12 3 9 17H3L12 3Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </>
      )
    case 'arrow-down':
      return (
        <>
          <path d="M12 4v15" />
          <path d="m6 13 6 6 6-6" />
        </>
      )
    case 'box':
      return (
        <>
          <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
          <path d="m4.5 7.8 7.5 4.3 7.5-4.3" />
          <path d="M12 12.1V21" />
        </>
      )
    case 'branch':
      return (
        <>
          <circle cx="6" cy="5" r="2" />
          <circle cx="18" cy="5" r="2" />
          <circle cx="18" cy="19" r="2" />
          <path d="M8 5h4a6 6 0 0 1 6 6v6" />
          <path d="M6 7v10a2 2 0 0 0 2 2h8" />
        </>
      )
    case 'check':
      return <path d="m5 12 4.2 4.2L19 6.5" />
    case 'chevron-down':
      return <path d="m6 9 6 6 6-6" />
    case 'chevron-left':
      return <path d="m15 6-6 6 6 6" />
    case 'chevron-right':
      return <path d="m9 6 6 6-6 6" />
    case 'clock':
      return (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7v5l3.5 2" />
        </>
      )
    case 'close':
      return (
        <>
          <path d="m6 6 12 12" />
          <path d="m18 6-12 12" />
        </>
      )
    case 'copy':
      return (
        <>
          <rect x="8" y="8" width="11" height="11" rx="1.5" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </>
      )
    case 'edit':
      return (
        <>
          <path d="m4 16.5-.8 3.3 3.3-.8L18.8 6.7a2.2 2.2 0 0 0-3.1-3.1L4 16.5Z" />
          <path d="m13.8 5.2 3.1 3.1" />
        </>
      )
    case 'folder':
      return <path d="M3.5 6.5h6l2 2h9v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-8.5a2 2 0 0 1 2-2Z" />
    case 'file':
      return (
        <>
          <path d="M6.5 3.5h7l4 4v13h-11a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z" />
          <path d="M13.5 3.5v4h4" />
          <path d="M8 12h6M8 15.5h6" />
        </>
      )
    case 'image':
      return (
        <>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <circle cx="8.5" cy="9" r="1.5" />
          <path d="m4.5 17 4.5-4.5 3 3 2.5-2.5 5 5" />
        </>
      )
    case 'list':
      return (
        <>
          <path d="M8.5 6h12M8.5 12h12M8.5 18h12" />
          <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
        </>
      )
    case 'model':
      return (
        <>
          <circle cx="8" cy="8" r="3" />
          <circle cx="16" cy="8" r="3" />
          <circle cx="12" cy="16" r="3" />
          <path d="m10.5 9.5 1.5 3M13.5 9.5 12 13M9.5 8h5" />
        </>
      )
    case 'paperclip':
      return <path d="m8.5 12.5 5.8-5.8a3 3 0 0 1 4.2 4.2l-7.7 7.7a4.5 4.5 0 0 1-6.4-6.4l7.4-7.4" />
    case 'plan':
      return (
        <>
          <rect x="5" y="4" width="14" height="16" rx="2" />
          <path d="M8 8h8M8 12h5M8 16h3" />
        </>
      )
    case 'person':
      return (
        <>
          <circle cx="12" cy="8" r="3" />
          <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
        </>
      )
    case 'play':
      return (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="m10 8.5 5.5 3.5-5.5 3.5v-7Z" fill="currentColor" stroke="none" />
        </>
      )
    case 'refresh':
      return (
        <>
          <path d="M20 11a8 8 0 0 0-14.7-4L3 9" />
          <path d="M3 4v5h5" />
          <path d="M4 13a8 8 0 0 0 14.7 4L21 15" />
          <path d="M21 20v-5h-5" />
        </>
      )
    case 'search':
      return (
        <>
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="m15 15 5 5" />
        </>
      )
    case 'send':
      return (
        <>
          <path d="m21 3-7.5 18-3.5-7-7-3.5L21 3Z" />
          <path d="M10 14 21 3" />
        </>
      )
    case 'settings':
      return (
        <>
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0L6.2 6.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )
    case 'session':
      return (
        <>
          <path d="M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-4 2v-2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z" />
          <path d="M7 9h10M7 12.5h6" />
        </>
      )
    case 'sparkles':
      return (
        <>
          <path d="m12 3 1.2 4.8L18 9l-4.8 1.2L12 15l-1.2-4.8L6 9l4.8-1.2L12 3Z" />
          <path d="m19 14 .6 2.4L22 17l-2.4.6L19 20l-.6-2.4L16 17l2.4-.6L19 14Z" />
        </>
      )
    case 'status':
      return <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />
    case 'stop':
      return (
        <>
          <rect x="5" y="5" width="14" height="14" rx="2" />
        </>
      )
    case 'target':
      return (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="4.5" />
          <circle cx="12" cy="12" r="1" fill="currentColor" />
        </>
      )
    case 'terminal':
      return (
        <>
          <rect x="3.5" y="5" width="17" height="14" rx="2" />
          <path d="m7 10 2 2-2 2M12 14h4" />
        </>
      )
    case 'thumb-down':
      return (
        <>
          <path d="M17 14V4h2.5A1.5 1.5 0 0 1 21 5.5v7a1.5 1.5 0 0 1-1.5 1.5H17Z" />
          <path d="m17 14-3 6.5a2 2 0 0 1-3.8-1.5l.7-5H5a2 2 0 0 1-1.9-2.6l2.1-7A2 2 0 0 1 7.1 3H14a3 3 0 0 1 3 3v8Z" />
        </>
      )
    case 'thumb-up':
      return (
        <>
          <path d="M7 10v10H4.5A1.5 1.5 0 0 1 3 18.5v-7A1.5 1.5 0 0 1 4.5 10H7Z" />
          <path d="M7 10 10 3.5A2 2 0 0 1 13.8 5l-.7 5H19a2 2 0 0 1 1.9 2.6l-2.1 7A2 2 0 0 1 16.9 21H10a3 3 0 0 1-3-3v-8Z" />
        </>
      )
    case 'tool':
      return (
        <>
          <path d="m14.5 5.5 4-2 .5 4-2.2 1.4-4.8 4.8" />
          <path d="m11.8 13.2-3.7 3.7a2.1 2.1 0 1 1-3-3l3.7-3.7" />
          <path d="m12.2 6.2 5.6 5.6" />
        </>
      )
    case 'trash':
      return (
        <>
          <path d="M5 7h14" />
          <path d="M9 7V4.5h6V7M7 7l.8 13h8.4L17 7" />
          <path d="M10 10.5v6M14 10.5v6" />
        </>
      )
    case 'users':
      return (
        <>
          <circle cx="9" cy="9" r="2.5" />
          <circle cx="16.5" cy="10" r="2" />
          <path d="M4.5 19a4.5 4.5 0 0 1 9 0M14 18a3.5 3.5 0 0 1 6 1" />
        </>
      )
  }
}
