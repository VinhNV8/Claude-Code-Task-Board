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
| S9 | `AskUserQuestion` qua permission prompt tool (FR-40, 2026-11-18, CLI 2.1.322, Haiku) | ✅ Đạt | Xem mục S9 bên dưới |

## S9: Claude hỏi lại người dùng giữa lúc chạy (FR-40)

Mục đích: xem ở chế độ `-p`, tool gốc `AskUserQuestion` có đi qua `--permission-prompt-tool` không, và trả đáp án về cho Claude bằng cách nào. Script: [ask-user-question.spike.mjs](../server/fixtures/ask-user-question.spike.mjs), output thật: [ask-user-question.jsonl](../server/fixtures/ask-user-question.jsonl).

| Kịch bản | Kết quả |
|---|---|
| Có `--permission-prompt-tool` | `AskUserQuestion` có trong `init.tools`. Claude gọi tool → MCP nhận `{tool_name: "AskUserQuestion", input: {questions: [{question, header, options[{label, description}], multiSelect}]}}` |
| Trả `{behavior: "allow", updatedInput: {...input, answers: {"<question>": "<label>"}}}` | ✅ Claude nhận "Your questions have been answered: …" và **chạy tiếp trong cùng tiến trình** |
| Đáp án tự do (không có trong `options`) | ✅ Claude nhận và dùng đúng nguyên văn |
| `allow` **không** có `answers` | ⚠️ Claude nhận "The user did not answer the questions." |
| `deny` kèm `message` | Claude đọc được `message` (tool_result `is_error`), có ghi vào `permission_denials`. Dùng được làm đường dự phòng, nhưng không chuẩn |
| Không có `--permission-prompt-tool` | `AskUserQuestion` **không có** trong danh sách tool, Claude không hỏi được |
| `--permission-mode` `acceptEdits` / `plan` | ✅ Vẫn đi qua prompt tool, đáp án đến được Claude |

Hệ quả cho board hiện tại: allowlist khớp hoặc mode Auto sẽ tự `allow` với `updatedInput = input`, nên Claude nhận "did not answer". Mode Manual hiện `AskUserQuestion` như một yêu cầu quyền thường; bấm Allow cũng không có đáp án. Cần: luôn đưa `AskUserQuestion` vào Needs Input (không tự duyệt), hiện câu hỏi + lựa chọn + ô "Khác", trả `answers` trong `updatedInput`. Hết timeout thì trả `allow` không có `answers` để Claude tự quyết.

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

---

# Spike M0 (Codex): `codex app-server` trên máy

Phục vụ [SPEC-MULTI-AGENT.md](SPEC-MULTI-AGENT.md), giai đoạn M0. Chạy ngày 2026-11-18 trên Windows 11, `codex-cli 0.169.0-alpha.11.1` (extension VS Code `openai.chatgpt-26.1111.21308-win32-x64`), tài khoản ChatGPT gói **free**. Script: `server/fixtures/codex/app-server.spike.mjs`; log (đã xoá đường dẫn máy, tên máy, id cài đặt): `server/fixtures/codex/*.jsonl`.

## Kết quả

| # | Hạng mục | Kết quả | Ghi chú |
|---|---|---|---|
| C1 | Tìm file chạy | ✅ | Không có trong PATH. Nằm ở `~/.vscode/extensions/openai.chatgpt-<ver>-win32-x64/bin/windows-x86_64/codex.exe` (dò giống D1 của Claude: biến `CODEX_BIN` → bản extension mới nhất → PATH) |
| C2 | Giao thức | ✅ | `codex app-server` (mặc định `stdio://`), JSON-RPC **mỗi dòng một JSON**, không cần trường `jsonrpc`. Trình tự: `initialize` → notification `initialized` → `thread/start` → `turn/start`. Schema TypeScript sinh bằng `codex app-server generate-ts --out <dir>` (784 file) |
| C3 | Đăng nhập | ✅ | Dùng phiên đăng nhập có sẵn (`~/.codex/auth.json`), không cần API key. Notification `account/updated` cho biết `authMode: "chatgpt"`, `planType` |
| C4 | Model | ✅ | `model/list` trả danh sách theo tài khoản (gói free: `gpt-6-luna` mặc định, `gpt-5.6-terra`, `gpt-5.6-luna`). Model trong `~/.codex/config.toml` có thể không hợp lệ với tài khoản → lượt chạy lỗi `codexErrorInfo: "modelNotFound"`. **Adapter phải truyền `model` lấy từ `model/list`**, không dựa vào config của người dùng |
| C5 | Duyệt lệnh shell | ✅ | `approvalPolicy: "untrusted"` → server request `item/commandExecution/requestApproval` kèm `command`, `cwd` (thư mục có dấu cách vẫn đúng). Thread chuyển `activeFlags: ["waitingOnApproval"]` và **chờ** đến khi có trả lời. `decline` → item `status: "declined"`, Codex biết lệnh không chạy. `accept` → lệnh chạy |
| C6 | Duyệt sửa file | ✅ (có lỗi chập chờn) | `item/fileChange/requestApproval`; item `fileChange` có sẵn `changes[].path/kind/diff` (dùng cho hiển thị Needs Input). `accept` → file được ghi. **Lỗi:** ở kịch bản A (vừa `decline` một lệnh, rồi `accept` sửa file trong cùng lượt), item `fileChange` không bao giờ `completed`, Codex chờ khoảng 90 giây rồi báo "stalled". Không tái hiện khi chạy riêng (kịch bản D). Fixture: `decline-then-filechange-stall.jsonl` |
| C7 | Lệnh mồi kiểm tra cổng | ✅ | `echo taskboard-gate-check` sinh yêu cầu duyệt sau khoảng 6 giây; `decline` hoạt động. Dùng được cho `verifyGate()` |
| C8 | Resume | ✅ | Tiến trình mới, `thread/resume { threadId }` → Codex nhớ đúng ngữ cảnh. Thread lưu ở `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| C9 | Sandbox Windows | ✅ | `sandbox: "workspace-write"` ghi được trong `cwd`, `networkAccess: false` mặc định |
| C10 | Token / chi phí | ⚠️ Chỉ có token | `thread/tokenUsage/updated`: `inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`, `modelContextWindow`. **Không có chi phí USD** |
| C11 | Hạn mức | ✅ | `account/rateLimits/updated` (và đọc chủ động bằng `account/rateLimits/read`): `usedPercent`, `windowDurationMins`, `resetsAt` (epoch giây), `rateLimitReachedType`. Lỗi lượt chạy có `codexErrorInfo` = `usageLimitExceeded` / `rateLimitExceeded` / `serverOverloaded`… → failover nhận diện chắc chắn, và **kiểm tra được hạn mức trước khi giao task** |
| C12 | Hướng dẫn hệ thống | ✅ | `thread/start.developerInstructions` → dùng cho lời dặn `BLOCKED_BY` (thay `--append-system-prompt`) |
| C13 | Dừng task | ✅ (chưa chạy thử) | Có `turn/interrupt`; dự phòng: kill cây tiến trình như Claude |
| C14 | Hỏi lại người dùng | ✅ (chưa chạy thử) | Có server request `item/tool/requestUserInput` (EXPERIMENTAL) với `questions[]` (`header`, `question`, lựa chọn, `isOther`), tương đương `AskUserQuestion` |
| C15 | Thời gian | ℹ️ | Lượt đơn giản 10–15 giây; khởi động app-server và MCP mặc định của Codex khoảng 1–2 giây |

## Khác biệt so với SPEC-MULTI-AGENT và cách điều chỉnh

| # | Khác biệt | Điều chỉnh |
|---|---|---|
| CD1 | Codex **có** hỏi lại người dùng (`requestUserInput`) | `CodexAdapter.capabilities.askUser = true`; ánh xạ câu hỏi vào luồng FR-40/41 hiện có |
| CD2 | Model của config người dùng có thể không hợp lệ | Gọi `model/list` lúc khởi động adapter, lưu cache; chỉ cho chọn model trong danh sách |
| CD3 | Lỗi treo `fileChange` sau `decline` (C6) | Watchdog: item `fileChange` đã `accept` mà quá 60 giây chưa `completed` → ghi log cảnh báo, gửi `turn/interrupt`, rồi chạy tiếp bằng `turn/start` "tiếp tục" trong cùng thread (tối đa 1 lần). Theo dõi lại khi Codex ra bản ổn định |
| CD4 | Không có chi phí USD | Đúng như dự kiến (mục 3.5): hiển thị token, chi phí "—" |
| CD5 | Ánh xạ mode | `plan` → `sandbox: read-only` + `approvalPolicy: never`; `acceptEdits` → `workspace-write` + `on-request`; `manual`/`auto` → `workspace-write` + `untrusted`, backend trả lời mọi yêu cầu duyệt |
| CD6 | Codex tự nạp MCP server mặc định (`codex_apps`, `node_repl`, `cua_repl`) | Cân nhắc tắt bằng `config` của `thread/start` để run gọn và an toàn hơn; kiểm tra ở M3 |

## Kết luận
Không còn trở ngại kỹ thuật cho `CodexAdapter` đủ 4 mode quyền. Rủi ro còn lại là giao thức đánh dấu `[experimental]` và bản CLI là alpha: ghim phiên bản tối thiểu, chạy lại script spike khi extension cập nhật.

---

# Spike M0 (Antigravity): `agy acp` trên máy

Phục vụ [SPEC-MULTI-AGENT.md](SPEC-MULTI-AGENT.md), giai đoạn M0. Chạy ngày 2026-11-18 trên Windows 11, Antigravity CLI `agy 1.5.10`, đăng nhập bằng tài khoản Google. Script: `server/fixtures/antigravity/acp.spike.mjs`; log (đã xoá đường dẫn máy): `server/fixtures/antigravity/*.jsonl`.

## Kết quả

| # | Hạng mục | Kết quả | Ghi chú |
|---|---|---|---|
| G1 | Tìm file chạy | ✅ | Không có trong PATH. Nằm ở `~/.gemini/bin/agy.exe` (kèm `agy.version.json`). Dò: biến `AGY_BIN` → `~/.gemini/bin/agy.exe` → PATH. Không dùng `Antigravity.exe` / `Antigravity IDE.exe` (bản desktop) |
| G2 | Giao thức | ✅ | `agy acp` là **ACP server chính thức** (`agentInfo.name: "Antigravity ACP Server"`). JSON-RPC 2.0, mỗi dòng một JSON. Trình tự: `initialize { protocolVersion: 1, clientCapabilities }` → `session/new { cwd, mcpServers: [] }` → `session/prompt`. Kết quả lượt: `{ stopReason, usage }` |
| G3 | Đăng nhập | ✅ | Dùng phiên Google có sẵn. `initialize` liệt kê `authMethods` (Google, Gemini Enterprise, Gemini API key, Agent Platform) |
| G4 | Mode và model | ✅ | `session/new` trả `modes` có sẵn `default`, `accept-edits`, `auto`, `plan` và `models` (Gemini 3.8 Flash high/medium/low, **Claude Sonnet 4.6, Claude Opus 4.6**, GPT-OSS 120B). Có `session/set_mode`, `session/set_model` (chưa chạy thử) |
| G5 | Duyệt lệnh shell | ✅ | Mode `default`: server request `session/request_permission` kèm `toolCall { title, kind: "execute", rawInput.CommandLine }`, `options: [allow:allow_once, deny:reject_once]`. Trả `{ outcome: { outcome: "selected", optionId } }`. `deny` → tool call `failed` |
| G6 | Duyệt sửa file | ⚠️ → ✅ | **Mode `default` không hỏi trước khi sửa file trong workspace** (khác tài liệu). Rule `permissions.ask: ["write_file(*)"]` **không có tác dụng** với file trong workspace. **`toolPermission: "strict"`** thì có: yêu cầu `kind: "edit"`, `rawInput { Path, Content }`; `deny` → file không được ghi |
| G7 | Cấu hình riêng cho run | ✅ (có điều kiện) | `agy acp` **không** nhận `--settings` (lỗi `flags provided but not defined`). Dùng **`--app-data-dir <tên>`**: đường dẫn phải **tương đối** (tính từ `~/.gemini`), trong đó đặt `settings.json`. Đăng nhập vẫn giữ nguyên. Thư mục này cũng chứa lịch sử hội thoại |
| G8 | Bị từ chối | ℹ️ | Sau `deny`, agy **kết thúc lượt ngay** (`stopReason: end_turn`), không nói gì, không làm các bước còn lại. Lựa chọn chỉ có allow/reject, **không kèm được lý do** |
| G9 | Resume | ✅ | Tiến trình mới, `session/load { sessionId, cwd, mcpServers }` (cùng `--app-data-dir`) → agy nhớ đúng ngữ cảnh, kể cả việc bị từ chối. `agentCapabilities` có `loadSession`, `sessionCapabilities.resume/list/close` |
| G10 | Token / chi phí | ⚠️ Chỉ có token | `session/prompt` trả `usage { inputTokens, outputTokens, cachedReadTokens, thoughtTokens, totalTokens }`; `usage_update { used, size }` (ngữ cảnh). Không có USD |
| G11 | Hướng dẫn hệ thống | ❓ chưa chạy thử | `agentCapabilities._meta.antigravity.systemPrompt.append: true`, dự kiến dùng cho lời dặn `BLOCKED_BY`; dự phòng: ghép vào đầu prompt |
| G12 | Hỏi lại người dùng | ❌ không thấy | ACP không có request hỏi lại kiểu `AskUserQuestion`; agy có slash command `/grill-me` nhưng không phải tool hỏi qua client |
| G13 | Hạn mức | ❓ chưa kiểm | Chưa gặp lỗi hết hạn mức; cần quan sát khi chạy thật để viết `classifyFailure()` |
| G14 | Thời gian | ℹ️ | Lượt đơn giản 6–14 giây, khởi động khoảng 1 giây |

## Khác biệt so với SPEC-MULTI-AGENT và cách điều chỉnh

| # | Khác biệt | Điều chỉnh |
|---|---|---|
| GD1 | Dùng được ACP, không cần hook | Bỏ phương án hook cho agy; `AntigravityAdapter` là client ACP (`drive()`) |
| GD2 | Chỉ `strict` mới hỏi trước khi sửa file | **Luôn chạy `toolPermission: "strict"`** và để PermissionBroker quyết theo mode của Task Board: `plan` từ chối mọi ghi/lệnh; `acceptEdits` tự cho phép đọc và sửa file trong thư mục task, lệnh đi qua allowlist/người duyệt; `manual` hỏi người với ghi và lệnh, tự cho phép đọc trong thư mục task; `auto` tự cho phép trừ lệnh rủi ro (FR-45). Không dùng mode `auto` gốc của agy |
| GD3 | Cấu hình qua `--app-data-dir` và thư mục đó giữ cả lịch sử hội thoại | Dùng **một thư mục cố định** `~/.gemini/taskboard-agy/` (không tạo mới mỗi run) để resume được; Task Board quản lý `settings.json` trong đó và không đụng `~/.gemini/antigravity-cli/` của người dùng |
| GD4 | Không gửi được lý do khi từ chối, lượt kết thúc ngay | FR-46 (từ chối kèm lý do): sau khi lượt kết thúc, adapter gửi tiếp `session/prompt` "Thao tác <x> bị từ chối: <lý do>. Hãy làm tiếp theo cách khác" trong cùng session |
| GD5 | Không có hỏi lại người dùng | `capabilities.askUser = false` |
| GD6 | agy có model Claude | Gợi ý cho failover: chuỗi `claude → antigravity (claude-sonnet-4-6)` giữ được "chất" Claude khi gói Claude hết lượt (dùng hạn mức của Google) |

## Kết luận
Không còn trở ngại kỹ thuật cho `AntigravityAdapter` đủ 4 mode quyền qua ACP, với điều kiện chạy `toolPermission: "strict"` trong thư mục dữ liệu riêng của Task Board.

---

# Spike P9 (2026-11-19, Claude Code CLI 2.1.327): plan mode headless và resume tương tác

Phục vụ [SPEC-PLAN-HANDOFF.md](SPEC-PLAN-HANDOFF.md).

| # | Kiểm tra | Kết quả | Ghi chú |
|---|---|---|---|
| S1 | `claude -p --permission-mode plan` kết thúc thế nào | ✅ | Không có tool `ExitPlanMode` (Claude tìm bằng ToolSearch, không thấy). Kế hoạch được ghi vào `~/.claude/plans/<slug>.md` (ngoài repo) và trả trong `result`, kèm vài câu "hãy thoát plan mode". Không có `permission_denials`. ⇒ Task Board gắn chỉ dẫn "câu trả lời cuối chính là kế hoạch", lấy `result` làm kế hoạch |
| S2 | Phiên của lượt `-p` có resume được không, và khi chữ hoa/thường của ổ đĩa khác nhau thì sao | ✅ | Phiên lưu ở `~/.claude/projects/<cwd mã hoá>/<id>.jsonl`, chung chỗ với phiên tương tác. `spawn(claude, ['-p','--resume',id], {cwd: 'c:\\...'})` vẫn tìm thấy phiên tạo từ `C:\\...` và nhớ đúng ngữ cảnh |
| S3 | Phiên tạo bằng API key có resume được bằng đăng nhập Pro/Max không | ⏳ | File phiên có dòng `session-owner` (`accountUuid`, `organizationUuid`), nên có thể bị từ chối. Chưa kiểm vì máy chưa cấu hình API key |

