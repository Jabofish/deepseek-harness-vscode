// Functional boundaries complement native browser input and layout checks.
// Keep this selection explicit: a source-shape assertion is not a UI scenario.
export const uiBehaviorSuites = {
  'drafts, delivery and cancellation': [
    'apps/webview/src/App.connected.spec.tsx',
    'apps/webview/src/features/composer/Composer.spec.tsx',
    'apps/webview/src/app/store-new-session-draft.spec.ts',
    'apps/webview/src/app/protocol-client.spec.ts',
    'apps/webview/src/app/store-reconnect-epoch.spec.ts',
    'apps/webview/src/features/commands/CommandPalette.spec.tsx',
    'apps/webview/src/app/store-command-dispatch.spec.ts',
  ],
  'queue editing and admission': [
    'apps/webview/src/features/input/QueuePanel.spec.tsx',
    'apps/webview/src/app/store/pending-prompts.spec.ts',
  ],
  'sessions and ownership': [
    'apps/webview/src/features/sessions/SessionDrawer.spec.tsx',
    'apps/webview/src/features/sessions/useSessionContentSearch.spec.ts',
    'apps/webview/src/app/store-session-navigation.spec.ts',
    'apps/webview/src/app/store-session-switch-integrity.spec.ts',
    'apps/webview/src/app/store-surface.spec.ts',
  ],
  'attachments and editor context': [
    'apps/webview/src/features/chat/MessageImages.spec.tsx',
    'apps/webview/src/features/attachments/AttachmentLightbox.spec.tsx',
    'apps/webview/src/features/composer/EditorContextChips.spec.tsx',
    'apps/webview/src/app/store-editor-context-send.spec.ts',
    'apps/extension/src/composition/attachment-request-handler.spec.ts',
  ],
  'models, permissions and settings': [
    'apps/webview/src/features/models/ModelPicker.spec.tsx',
    'apps/webview/src/features/composer/SessionControls.spec.tsx',
    'apps/webview/src/features/settings/SettingsDrawer.spec.tsx',
    'apps/webview/src/app/useDshSettings.spec.tsx',
  ],
  'approvals and questions': [
    'apps/webview/src/features/interactions/ApprovalCard.spec.tsx',
    'apps/webview/src/features/interactions/UserQuestionCard.spec.tsx',
    'apps/webview/src/app/question-lifecycle.spec.tsx',
  ],
  'reading, complete content and copy': [
    'apps/webview/src/features/chat/Timeline.spec.tsx',
    'apps/webview/src/features/chat/Timeline.content-integrity.spec.tsx',
    'apps/webview/src/features/chat/MarkdownContent.spec.tsx',
    'apps/webview/src/features/chat/ToolCodePreview.spec.tsx',
    'apps/webview/src/features/chat/ToolTerminalPreview.spec.tsx',
    'apps/webview/src/features/chat/ToolDiffPreview.spec.tsx',
    'apps/webview/src/components/common/useScrollFollow.behavior.spec.tsx',
  ],
  'keyboard, motion and focus': [
    'apps/webview/src/components/common/useDismissibleLayer.spec.tsx',
    'apps/webview/src/components/common/SelectMenu.spec.tsx',
    'apps/webview/src/components/common/useScrollFollow.spec.tsx',
    'apps/webview/src/app/accessibility-signals.spec.tsx',
    'apps/webview/src/app/ActivityPresentationControl.spec.tsx',
    'apps/webview/src/features/chat/quiet-activity.spec.tsx',
    'apps/webview/src/features/chat/ReasoningDisclosure.spec.tsx',
  ],
  'native panel handoff and cleanup': [
    'apps/extension/src/view/editor-chat-surface-manager.spec.ts',
    'apps/extension/src/view/session-drop-editor.spec.ts',
    'apps/extension/src/view/message-router-surface.spec.ts',
  ],
}
