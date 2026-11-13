// Bản thay thế server/src/claudeEditorScan.ts trong VS Code extension: không quét thư mục của editor khác.
// Extension tìm Claude Code qua API vscode.extensions và truyền CLAUDE_BIN cho server (xem extension.ts).
export function fromVscodeExtensions(): string | undefined {
  return undefined
}
