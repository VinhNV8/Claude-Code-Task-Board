# Báo cáo Spike P0.1: Claude Code CLI trên máy

| Mục | Giá trị |
|---|---|
| Ngày | 2026-11-11 |
| Phiên bản | Claude Code **2.1.322** |
| File chạy | `C:\Users\ADMIN\.vscode\extensions\anthropic.claude-code-2.1.322-win32-x64\resources\native-binary\claude.exe` (đi kèm extension VSCode, **không có trong PATH**) |
| Fixtures | [server/fixtures/](../server/fixtures/) |

## Kết quả

| # | Kiểm tra | Kết quả | Ghi chú |
|---|---|---|---|
| S1 | Các flag cần dùng | ✅ Đạt | `-p`, `--output-format stream-json`, `--verbose`, `--session-id`, `--resume`, `--permission-mode`, `--allowedTools`, `--settings`, `--mcp-config`, `--strict-mcp-config`, `--permission-prompts`, `--permission-prompt-tool` (cờ ẩn, vẫn hoạt động) |
| S2 | Headless không cần API key | ✅ Đạt | Đã unset `ANTHROPIC_API_KEY`; `system/init.apiKeySource = "none"`, tức dùng phiên đăng nhập của Claude Code |
| S3 | Gán session id và resume | ✅ Đạt | `--session-id <uuid>` rồi `--resume <uuid>`: phiên sau nhớ ngữ cảnh phiên trước |
| S4 | Spawn từ Node trên Windows | ✅ Đạt | `spawn(claude.exe, args, {cwd})`, **không cần `shell:true`**; cwd có dấu cách vẫn chạy; **prompt truyền qua stdin** để tránh lỗi quote |
| S5 | Dừng tiến trình | ✅ Đạt | `taskkill /PID <pid> /T /F`: tiến trình kết thúc ngay (exit 1) |
| S6 | Schema output | ✅ Đạt | Xem bên dưới |
| S7 | Từ chối quyền (`--permission-prompts none`) | ✅ Đạt | Lệnh cần quyền bị từ chối, liệt kê trong `result.permission_denials[]` |
| S8 | `--permission-prompt-tool` qua MCP | ✅ Đạt | MCP server stdio tự viết nhận `{tool_name, input, tool_use_id}`, trả `{"behavior":"allow","updatedInput":...}` thì lệnh chạy được. **Rủi ro chính của P3 đã được gỡ** |

## Schema stream-json (đã quan sát)

| `type` / `subtype` | Dùng để |
|---|---|
| `system/init` | `session_id`, `model`, `cwd`, `permissionMode`, `apiKeySource`, `claude_code_version` |
| `assistant` | `message.content[]` gồm `text`, `tool_use {id, name, input}`, `thinking` |
| `user` | `message.content[]` gồm `tool_result {tool_use_id, content, is_error}` |
| `system/thinking_tokens`, `rate_limit_event` | Bỏ qua (hoặc dùng `rate_limit_event` để phát hiện giới hạn sử dụng) |
| `result/success` hoặc `result/error_*` | `is_error`, `result`, `num_turns`, `duration_ms`, `total_cost_usd`, `permission_denials[]`, `session_id` |

## Khác biệt so với SPEC và cách điều chỉnh

| # | Khác biệt | Điều chỉnh |
|---|---|---|
| D1 | `claude` không có trong PATH | Backend tự dò theo thứ tự: biến `CLAUDE_BIN`, rồi bản extension VSCode **mới nhất** trong `~/.vscode/extensions/anthropic.claude-code-*`, rồi `claude` trong PATH |
| D2 | Các mode quyền hiện có: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` (không còn `default`) | Đổi mode `default` trong UI thành **`manual`**; vẫn không cho chọn `bypassPermissions` |
| D3 | Lệnh chỉ đọc (vd. `git status`) được tự cho phép dù không nằm trong whitelist | Chấp nhận; whitelist chỉ cần liệt kê lệnh có ghi |
| D4 | `total_cost_usd` là **chi phí quy đổi**; gói thuê bao không bị tính theo số này | UI ghi “Chi phí ước tính (quy đổi)” |
| D5 | Thư mục tạm (scratchpad, memory) của từng phiên được trả về trong `init` | Không ảnh hưởng |

## Kết luận
Không còn trở ngại kỹ thuật cho P1–P3. P3 dùng **phương án chính** (`--permission-prompt-tool` qua MCP server của backend); phương án dự phòng (`--permission-prompts none` + whitelist) cũng đã được kiểm chứng.
