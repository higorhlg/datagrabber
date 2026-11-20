/** Platform differences shown in the UI: shortcut labels and the name of the password store. */
const isMac = /Mac|iPhone|iPad/i.test(navigator.userAgent);

export const platform = {
  isMac,
  shortcuts: {
    run: isMac ? '⌘↵' : 'Ctrl+Enter',
    runAll: isMac ? '⇧⌘↵' : 'Ctrl+Shift+Enter',
  },
  /** Where saved passwords live. */
  keychain: isMac ? 'macOS Keychain' : 'system keyring',
  /** What happens when another app's saved password is read. */
  accessPrompt: isMac ? 'macOS will ask you to allow access.' : 'your keyring may ask you to unlock it.',
};
