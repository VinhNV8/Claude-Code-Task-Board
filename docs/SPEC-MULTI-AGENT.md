# SPEC bổ sung: Chạy task bằng nhiều agent (Claude Code, Cursor, Codex, Antigravity…)

| Mục | Giá trị |
|---|---|
| Mã yêu cầu | **FR-90..FR-99** (nhóm mới: 3.10 Chọn agent) |
| Ngày | 2026-11-18 |
| Trạng thái | 📝 **Đã chốt QA1–QA7 (2026-11-18). Spike M0: Codex ✅ (C1–C15), Antigravity ✅ (G1–G14)** ([P0-SPIKE.md](P0-SPIKE.md)). Cursor: chưa cài trên máy. Chưa viết code |
| Liên quan | [SPEC.md](SPEC.md) mục 2, 3.5, 3.8, 3.9; [P0-SPIKE.md](P0-SPIKE.md) |

---

## 0. Yêu cầu gốc (nguyên văn)

> Ngoài connect tới Claude Code, thì có thể connect tới các harness agent khác như Google Antigravity hoặc Cursor giống như cách connect tới Claude Code để triển khai task không?
>
> vậy hãy đề xuất thêm option để có thể connect tới Google Antigravity, Cursor, Codex.....ngoài Claude Code như hiện tại

---

## 1. Đánh giá

### 1.1 Có làm được không
**Làm được.** Task Board không điều khiển giao diện Claude Code. Nó spawn CLI ở chế độ headless (`claude -p … --output-format stream-json`), đọc từng dòng JSON, và dùng `--resume` để chạy tiếp ([runner.ts](../server/src/runner.ts), [stream.ts](../server/src/stream.ts)). Đến 11/2026, cả 3 agent được nhắc tới đều có CLI headless theo cùng mô hình:

| Agent | CLI | Chạy headless | Log có cấu trúc | Chạy tiếp phiên | Mức quyền |
|---|---|---|---|---|---|
| **Claude Code** (hiện tại) | `claude` | `-p`, prompt qua stdin | `--output-format stream-json` | `--resume <id>` | `--permission-mode`, `--allowedTools`, **`--permission-prompt-tool`** (hỏi người giữa lúc chạy) |
| **Cursor** | `cursor-agent` | `-p` | `--output-format stream-json` (NDJSON, kết thúc bằng event `result`) | `--resume <chatId>` | `--force` (tự cho phép lệnh); allow/deny trong `.cursor/cli.json` |
| **OpenAI Codex** | `codex exec` / **`codex app-server`** | `codex exec "<prompt>"` (hoặc `-` đọc stdin); `app-server` là JSON-RPC qua stdio | `--json` (event `thread.started`, `turn.completed`…); app-server gửi notification theo item | `codex exec resume <thread_id>`; app-server mở lại thread theo id | `--sandbox read-only / workspace-write / danger-full-access`. `exec` không có người duyệt giữa lúc chạy; **`app-server` có request duyệt lệnh/sửa file** (dùng cho `manual`/`auto`) |
| **Google Antigravity** | `agy` (Antigravity CLI, thay cho Gemini CLI) | `-p` | `--output-format json`, NDJSON stream có tool call | cần spike | `--mode default / accept-edits / plan`, allow rule trong settings; print mode **từ chối** tool cần duyệt nếu không có rule khớp |

> ⚠️ Cờ của các CLI này đổi nhanh, và tài liệu chính thức với tài liệu bên thứ ba đôi khi không khớp nhau (ví dụ định dạng output mặc định của Cursor). Bảng trên dùng để định hướng. Phải kiểm chứng bằng spike M0 trên máy Windows trước khi code.

Phiên bản IDE (Antigravity IDE, Cursor IDE) **không** điều khiển được theo cách này. Ta chỉ kết nối qua CLI của chúng. Mỗi CLI dùng phiên đăng nhập riêng (`cursor-agent login`, `codex login`, `agy`), nên vẫn thoả **ràng buộc C1**: Task Board không tự gọi API của nhà cung cấp nào.

### 1.2 Phần dùng lại được (không phụ thuộc agent)
Hàng đợi, độ ưu tiên, phụ thuộc giữa task, hai cách giao output (Ghi thẳng / Nhánh git riêng), diff và review theo file, Request changes, Reject, cron/lịch chạy, import task, template, tag, Telegram, thông báo và toàn bộ UI Kanban.

### 1.3 Phần đang gắn riêng với Claude
| Phần | Ở đâu | Agent khác |
|---|---|---|
| Tìm file chạy CLI | [claude.ts](../server/src/claude.ts), `claudeEditorScan.ts` | Mỗi agent có cách tìm riêng |
| Xác thực, lọc biến môi trường | `claudeAuth.ts`, `claudeEnv()`, `apiKeyBroker.ts` | Mỗi agent dùng biến riêng (`CURSOR_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`…) |
| Dựng tham số | `buildClaudeArgs()` trong runner | Cờ khác hẳn nhau |
| Parser log | `StreamParser` trong [stream.ts](../server/src/stream.ts) | Định dạng event khác nhau |
| **Hỏi quyền giữa lúc chạy** (Needs Input) | `permissionTool.ts` + MCP `--permission-prompt-tool` | **Không có tương đương trực tiếp** (xem R1) |
| Hỏi lại (`AskUserQuestion`) | FR-40 | Không có |
| Hook Notification | `hookSettings.ts` | Không có hoặc khác |
| Model (Haiku/Sonnet/Opus, tự nâng bậc) | `model.ts`, `modelPicker.ts` | Danh sách model riêng của từng agent |
| Chi phí USD, budget cứng (`--max-budget-usd`) | `budget.ts`, event `result` | Codex chỉ báo token; Cursor/agy chưa rõ |
| Nhận biết hết hạn mức | `claudeLimit.ts`, `rate_limit_event` | Phải nhận diện qua stderr/mã lỗi |
| Lời dặn `BLOCKED_BY` | `--append-system-prompt` | Ghép vào đầu prompt |

### 1.4 Rủi ro chính
| # | Rủi ro | Hậu quả nếu bỏ qua |
|---|---|---|
| R1 | Agent khác **không có `--permission-prompt-tool`**; cơ chế thay thế (Codex app-server, ACP/hook của agy, hook của Cursor) khác nhau và có lỗi đã biết (hook Cursor bỏ qua `ask`, JSON lỗi thì cho chạy) | Mode `manual`/`auto` trông như có duyệt nhưng thực ra lệnh vẫn chạy. Xử lý ở mục 3.3: lệnh mồi kiểm tra cổng, hook đóng an toàn, năng lực theo phiên bản |
| R2 | Dùng `--force` / `--dangerously-skip-permissions` / `danger-full-access` cho tiện | Agent chạy lệnh tuỳ ý theo prompt (nhất là task import từ file người khác, xem SPEC-IMPORT R3) |
| R3 | Agent không báo chi phí USD | Budget cứng theo project (FR-80..83) không áp dụng được, chi phí trên board hiển thị sai (0 thay vì "không rõ") |
| R4 | Rò key chéo: tiến trình Cursor nhận `ANTHROPIC_API_KEY`, tiến trình Claude nhận `OPENAI_API_KEY`… | Tính tiền nhầm tài khoản, lộ key cho lệnh agent chạy |
| R5 | Hỗ trợ Windows của từng CLI chưa đều (một số CLI ra mắt trước trên macOS/Linux/WSL) | Spawn lỗi, sai đường dẫn, lỗi quote như P0-SPIKE S4 |
| R6 | Đổi agent giữa các lần chạy của cùng task | `--resume` dùng session id của agent khác, lỗi hoặc mất ngữ cảnh |
| R7 | Refactor runner làm hỏng luồng Claude đang ổn định | Hồi quy toàn bộ tính năng chính |

---

## 2. Các phương án

| | Phương án | Mô tả | Ưu | Nhược |
|---|---|---|---|---|
| **A** ✅ | **Adapter cho từng CLI headless** | Interface `AgentAdapter`; mỗi agent một adapter: tìm CLI, dựng tham số, parse log, phân loại lỗi, khai báo năng lực | Cùng mô hình đang chạy tốt với Claude; mỗi agent làm và test độc lập; dùng lại fixture test | Mỗi agent tự viết parser và ánh xạ quyền; định dạng thay đổi thì phải sửa adapter |
| B | **Giao thức chung ACP** (Agent Client Protocol, JSON-RPC qua stdio) | Task Board làm "client" ACP, nói chuyện với agent nào có ACP (gốc hoặc qua adapter) | Một giao thức cho nhiều agent; **có `request_permission`**, giải được R1 | Mức hỗ trợ ACP của từng agent chưa đều, phải spike; đổi kiến trúc runner nhiều hơn |
| C | **Chỉ chuyển giao (handoff)** | Không chạy agent; tạo file prompt/nhánh rồi mở IDE (Antigravity/Cursor) để người dùng chạy tay, quay lại bấm "Đã xong" để review | Rất ít code; dùng được cả agent không có CLI | Không tự động, không có log/hàng đợi; mất ý nghĩa của Task Board |

**Đề xuất: làm A**, thiết kế interface sao cho sau này thêm được một adapter ACP (B) cho những agent hỗ trợ tốt, để có hỏi quyền giữa lúc chạy. C để sau, chỉ làm nếu có agent không có CLI.

---

## 3. Thiết kế (phương án A)

### 3.1 Interface adapter
```ts
// server/src/agents/types.ts
export type AgentId = 'claude' | 'cursor' | 'codex' | 'antigravity'

export interface AgentCapabilities {
  interactivePermission: boolean // hỏi người giữa lúc chạy (Needs Input)
  askUser: boolean               // FR-40 hỏi lại
  resume: boolean
  costUsd: boolean               // báo chi phí USD
  hardBudget: boolean            // CLI tự dừng khi vượt budget
  tokenUsage: boolean
  permissionModes: PermissionMode[] // mode hỗ trợ được (sau khi ánh xạ, mục 3.3)
  models: { id: string; label: string }[] | 'free-text'
}

export interface AgentAdapter {
  id: AgentId
  label: string
  capabilities: AgentCapabilities
  findBin(refresh?: boolean): { path: string; source: string; version?: string } | null
  checkAuth(): Promise<{ ok: true } | { ok: false; reason: string; hint: string }>
  env(extra: Record<string, string>): NodeJS.ProcessEnv          // chỉ giữ biến của agent này (R4)
  buildInvocation(o: RunInput): { args: string[]; stdin?: string; tempFiles: string[] }
  createParser(cwd: string): { parseLine(line: string): Parsed }  // Parsed như stream.ts hiện tại
  classifyFailure(o: { exitCode: number; stderr: string; result?: ResultInfo }): RunFailInfo // hết hạn mức, chưa đăng nhập, lỗi hạ tầng…
  /** Có khi agent cần trao đổi hai chiều (Codex app-server, ACP): adapter tự điều khiển tiến trình,
   *  phát Parsed ra ngoài và gọi broker khi agent xin quyền. Không có thì runner dùng spawn + parseLine như hiện tại. */
  drive?(o: RunInput & { child: ChildProcess; emit(p: Parsed): void; requestPermission(r: PermissionRequest): Promise<PermissionDecision> }): Promise<void>
  /** Kiểm tra cổng duyệt quyền bằng lệnh mồi trước run manual/auto (mục 3.3). */
  verifyGate?(o: RunInput): Promise<{ ok: true } | { ok: false; reason: string }>
}
```
- Runner chỉ gọi interface; phần riêng của Claude chuyển nguyên vào `agents/claude.ts` (giai đoạn M1, **không đổi hành vi**, toàn bộ test hiện có phải xanh).
- `Parsed`/`LogEventInput` giữ nguyên, nên UI log, review và thống kê không phải sửa.
- Mỗi adapter có fixture NDJSON thật trong `server/fixtures/<agent>/` và test parser riêng, giống `stream.test.ts`.

### 3.2 Cấu hình chọn agent
Ba tầng giống chọn model (FR-71): **Task → Project → Hệ thống**, lấy giá trị đầu tiên khác rỗng. Mặc định của hệ thống: `claude`.

| Nơi | Thêm |
|---|---|
| Cài đặt hệ thống | Mục **Agents**: mỗi agent có Bật/Tắt, đường dẫn CLI (tự dò, cho sửa), trạng thái phát hiện (phiên bản, đã đăng nhập chưa), nút "Kiểm tra lại" |
| Project | Agent mặc định |
| Task / template / import | Cột/trường `agent` (tuỳ chọn). Import: thêm cột `agent` trong file mẫu |
| Extension VS Code | Cài đặt `agentTaskBoard.cursorPath`, `codexPath`, `antigravityPath` (giống `claudePath`) |

DB: thêm cột `agent` vào `projects`, `tasks`, `templates` (NULL = kế thừa) và `runs` (giá trị thực tế đã chạy). Session id lưu kèm agent: `runs.agent` + `session_id`.

### 3.3 Ánh xạ mức quyền (quan trọng nhất, R1/R2)
Chốt QA2 (2026-11-18): **mọi agent đều hỗ trợ đủ 4 mode**, gồm `manual` và `auto`. Hai mode này cần agent **dừng lại hỏi người duyệt giữa lúc chạy**. Mỗi agent làm việc đó bằng một cơ chế khác nhau, nhưng cùng gửi về một **cổng duyệt quyền chung** ở backend (mục 3.3a).

| Mode Task Board | Claude | Codex | Antigravity | Cursor |
|---|---|---|---|---|
| `plan` (chỉ đọc) | `--permission-mode plan` | sandbox `read-only` | `--mode plan` | chế độ plan/ask (spike) |
| `acceptEdits` | như hiện tại | sandbox `workspace-write` | `--mode accept-edits` + allow rule | allowlist ghi vào `cli.json` tạm |
| `manual` | permission prompt tool (có sẵn) | **`codex app-server`**: yêu cầu duyệt `requestApproval` qua JSON-RPC | **ACP** `session/request_permission` (ưu tiên) hoặc **hook** duyệt quyền | **hook** `beforeShellExecution` / `beforeMCPExecution` chờ người duyệt |
| `auto` | prompt tool + backend tự duyệt, trừ lệnh rủi ro (FR-45/47) | cùng cơ chế với `manual`, backend tự duyệt | cùng cơ chế với `manual` | cùng cơ chế với `manual` |

**Chi tiết theo agent** (kiểm chứng ở spike M0):

| Agent | Cơ chế hỏi người | Mức tin cậy | Giới hạn đã biết |
|---|---|---|---|
| **Codex** | ✅ **Đã kiểm chứng** (spike C5–C8). Chạy `codex app-server` (JSON-RPC qua stdio) thay vì `codex exec`. `approvalPolicy: "untrusted"` → app-server gửi `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`; lượt chạy **dừng chờ** đến khi backend trả `accept` / `decline`. Ánh xạ mode: `plan` = `read-only` + `never`; `acceptEdits` = `workspace-write` + `on-request`; `manual`/`auto` = `workspace-write` + `untrusted`. Có cả **hỏi lại người dùng** (`item/tool/requestUserInput`) | **Cao**: giao thức chính thức của extension VS Code Codex | Giao thức `[experimental]`, CLI bản alpha: ghim phiên bản tối thiểu. Lỗi chập chờn: `fileChange` treo sau `decline` trong cùng lượt → watchdog (P0-SPIKE CD3) |
| **Antigravity** | ✅ **Đã kiểm chứng** (spike G1–G14). `agy acp` là ACP server chính thức: server request `session/request_permission` (lệnh `kind: execute`, sửa file `kind: edit`), backend trả `allow_once` / `reject_once`. **Phải chạy `toolPermission: "strict"`** (mode `default` không hỏi trước khi sửa file trong workspace), cấu hình qua `--app-data-dir taskboard-agy` (thư mục cố định `~/.gemini/taskboard-agy/`, giữ cả lịch sử để resume). Broker quyết theo mode của Task Board, không dùng mode `auto` gốc của agy. Không cần hook | **Cao** | Bị từ chối thì lượt kết thúc ngay, không kèm được lý do → gửi lý do bằng `session/prompt` tiếp theo. Không có hỏi lại người dùng |
| **Cursor** | **Hook** `beforeShellExecution` / `beforeMCPExecution`: script hook gọi backend, **chờ** người duyệt rồi trả `allow` / `deny`. Không dùng `ask` (theo báo lỗi trên forum Cursor, `ask` bị bỏ qua ở nhiều phiên bản) | **Thấp nhất**: theo forum, chỉ `deny` hoạt động ổn định; hook trả JSON lỗi thì lệnh **được chạy**; hỗ trợ hook trong CLI chưa đồng đều | **Không chặn được việc sửa file trước khi sửa** (chỉ có hook sau khi sửa), nên ở `manual` của Cursor, sửa file luôn được cho phép, chỉ lệnh shell/MCP phải duyệt. UI ghi rõ điều này |

**Quy tắc an toàn** (thay cho quy tắc cũ):
- **Kiểm tra cổng trước khi chạy:** mỗi run `manual`/`auto` của agent khác Claude chạy một **lệnh mồi** trước (ví dụ yêu cầu chạy `echo taskboard-gate-check`). Backend phải nhận được yêu cầu duyệt và trả `deny`, và agent phải báo lệnh bị từ chối. Không đạt thì **dừng run** với lý do "Cơ chế duyệt quyền của <agent> <phiên bản> không hoạt động". Không bao giờ chạy tiếp khi không có cổng.
- **Hook đóng an toàn (fail-closed):** script hook bắt mọi lỗi (không gọi được backend, timeout, JSON sai) và trả `deny`. Không bao giờ để lỗi dẫn tới cho phép.
- **Cờ bỏ qua quyền:** vẫn cấm `--dangerously-skip-permissions`, `danger-full-access`, `--yolo`. **Ngoại lệ duy nhất:** Cursor ở `manual`/`auto` có thể cần `--force` để lệnh đã được hook duyệt chạy được (spike xác định). Chỉ dùng khi lệnh mồi đạt, và hook `deny` là lớp chặn.
- **Bảng năng lực theo phiên bản:** `capabilities.permissionModes` của adapter tính theo **phiên bản CLI đã cài**, không cố định. Phiên bản chưa kiểm chứng thì chỉ mở `plan` / `acceptEdits`, kèm cảnh báo.
- Task chọn mode mà agent (ở phiên bản hiện tại) không hỗ trợ: form báo lỗi ngay, không lặng lẽ hạ mode. Task import hoặc seed thì dòng đó lỗi ở bước xem trước.
- Thao tác bị từ chối trong lúc chạy: hiển thị ở trang Review như `permissionDenials` hiện tại, kèm gợi ý thêm rule vào allowlist rồi Chạy lại.

### 3.3a Cổng duyệt quyền chung (PermissionBroker)
Tách lõi của [permissionTool.ts](../server/src/permissionTool.ts) / `permissions.ts` thành một cổng không phụ thuộc agent. Mỗi adapter chỉ có nhiệm vụ chuyển yêu cầu của agent sang dạng chung và trả quyết định về.

```ts
interface PermissionRequest {
  taskId: number; runId: string; agent: AgentId
  kind: 'shell' | 'edit' | 'read' | 'mcp' | 'web' | 'other'
  command?: string; path?: string; tool?: string   // dữ liệu đã chuẩn hoá
  rule: string        // dạng chuẩn để so allowlist, ví dụ `Bash(npm test)`, `Edit(src/a.ts)`
  raw: unknown        // yêu cầu gốc của agent, lưu để hiển thị và gỡ lỗi
}
type PermissionDecision = { allow: true } | { allow: false; reason?: string }
```

Dùng lại nguyên vẹn cho mọi agent: tạo yêu cầu chờ và chuyển task sang **Needs Input**, Inbox, duyệt bằng Telegram, allowlist theo project (so bằng `rule` chuẩn), preset (FR-43), phân loại rủi ro (FR-45), mode Auto tự duyệt trừ lệnh rủi ro (FR-47), timeout `permissionTimeoutMin`, từ chối kèm lý do (FR-46).

| Adapter | Đường đi của yêu cầu |
|---|---|
| Claude | MCP `--permission-prompt-tool` → `/api/...` → broker (như hiện tại) |
| Codex | JSON-RPC request từ `app-server` → adapter (trong tiến trình server) → broker → response JSON-RPC |
| Antigravity | ACP `session/request_permission` → adapter (trong tiến trình server) → broker → response chọn `allow_once` / `reject_once` |
| Cursor | hook script → HTTP nội bộ → broker → stdout `{"permission":"allow"\|"deny"}` |

**Hỏi lại (FR-40)** có ở Claude (`AskUserQuestion`) và **Codex** (`item/tool/requestUserInput`, cùng dạng: tiêu đề, câu hỏi, lựa chọn, ô "Khác"). Adapter Codex chuyển câu hỏi vào luồng FR-40/41 hiện có. Antigravity và Cursor: spike sẽ kiểm tra.

### 3.4 Model
- Mỗi adapter khai báo danh sách model. Riêng chế độ **Tự động** (FR-72) và nâng bậc (FR-75) **chỉ áp dụng cho Claude** ở bản đầu. Với agent khác: chọn tay, hoặc để trống để dùng mặc định của CLI.
- Model thực tế lấy từ event khởi tạo nếu CLI có gửi; không có thì hiển thị "mặc định của <agent>".

### 3.5 Chi phí và budget (R3)
- Agent có `costUsd`: tính như hiện tại.
- Agent chỉ có token: lưu token, cột chi phí hiển thị **"—"** (không phải 0) và không cộng vào budget USD.
- Project có **budget cứng** (chế độ API key, FR-80..83): chỉ cho chạy bằng agent có `hardBudget`. Agent khác bị chặn, kèm lý do.

### 3.6 Chạy tiếp và đổi agent (R6)
- Request changes / Tiếp tục: dùng agent của run trước và resume bằng session id của agent đó.
- Người dùng đổi agent của task: run sau là **phiên mới kèm tóm tắt** (dùng lại cơ chế ngữ cảnh lớn của FR-75), không resume chéo.
- Agent không có `resume`: luôn mở phiên mới, prompt gồm prompt gốc, tóm tắt lần trước và feedback (như `resumePrompt` khi mất session).

### 3.6a Tự chuyển agent khi gặp sự cố (failover, FR-99)
**Cấu hình** (chốt QA6, 2026-11-18): hai tầng, Project ghi đè Hệ thống.
- **Hệ thống:** bật/tắt failover (mặc định **tắt**, vì đổi agent thì chất lượng, chi phí và nơi tính tiền đều thay đổi) và **một chuỗi dự phòng mặc định** có thứ tự, ví dụ `claude → codex`.
- **Project:** một ô chọn **[Dùng chuỗi của hệ thống (mặc định) | Tuỳ chỉnh | Tắt failover]**. Chỉ khi chọn *Tuỳ chỉnh* mới hiện danh sách để sắp xếp agent. Dùng để loại một agent khỏi project có dữ liệu nhạy cảm, hoặc tắt hẳn failover cho project đó.
- DB: `settings.failover = { enabled, chain: AgentId[] }`; `projects.failover_mode` (`inherit` | `custom` | `off`) và `projects.failover_chain` (JSON, chỉ dùng khi `custom`).

**Lỗi nào thì chuyển** (dựa trên phân loại lỗi đang có: `failKind`, `detectRateLimit`, và `classifyFailure()` của adapter):

| Tình huống | Bản đầu (M7) | Sau | Lý do |
|---|---|---|---|
| Hết hạn mức gói / rate limit (`rate_limit`) | ✅ **Chuyển** | ✅ | Lỗi gặp nhiều nhất, đã nhận diện chắc (`rate_limit_event`, `claudeLimit.ts`). Không chuyển thì chờ đến giờ reset như hiện tại |
| CLI không tìm thấy, chưa đăng nhập, phiên đăng nhập hết hạn | ⚠️ Chỉ báo, không chuyển | ✅ Cân nhắc | Cần chạy thực tế để chắc phân loại đúng trên từng CLI |
| Lỗi API của nhà cung cấp (5xx, quá tải) lặp lại sau khi đã retry | ⚠️ Chỉ báo, không chuyển | ✅ Cân nhắc | Khó tách khỏi lỗi do nội dung task; chuyển nhầm thì gây khó hiểu và tốn tiền |
| Agent chạy xong nhưng báo lỗi, test fail, làm sai | ❌ Không | ❌ | Lỗi do nội dung task: người dùng Retry hoặc Request changes, có thể tự chọn agent khác |
| Bị từ chối quyền, vượt budget, `BLOCKED_BY`, người dùng bấm Stop, timeout | ❌ Không | ❌ | Đổi agent không giải quyết được, hoặc người dùng đã chủ động dừng |

"Chỉ báo": task Failed hoặc chờ như hiện tại, lý do ghi rõ kèm gợi ý "Chạy lại bằng <agent dự phòng kế tiếp>" (một nút bấm).

**Chọn agent dự phòng:** lấy agent đầu tiên trong chuỗi thoả mọi điều kiện sau:
1. Đã bật, đã cài, đã đăng nhập, và không ở trạng thái "đang hết hạn mức".
2. Hỗ trợ **mode quyền** của task (mục 3.3). Task ở mode `manual`/`auto` mà chỉ có Claude hỗ trợ thì **không chuyển**, quay về chờ. Không bao giờ hạ mode quyền để chuyển được.
3. Project có budget cứng thì agent phải có `hardBudget` (mục 3.5).

Không có agent nào thoả thì dùng hành vi cũ (chờ reset / Failed) và ghi lý do vào log.

**Ngắt mạch theo agent:** khi một agent bị hết hạn mức, trạng thái "không dùng được đến <giờ reset>" áp dụng **cho mọi task** (mở rộng `claudeLimit.ts` thành bảng theo agent). Task kế tiếp trong hàng đợi đi thẳng sang agent dự phòng, không phải thất bại một lần rồi mới chuyển.

**Sau khi agent gốc có lượt lại** (chốt QA7, 2026-11-18): task lưu cả `agent` (agent gốc theo cấu hình 3 tầng) và `active_agent` (agent đang dùng sau failover).

| Thao tác | Agent dùng | Lý do |
|---|---|---|
| Request changes, Tiếp tục | **Giữ agent dự phòng** (`active_agent`) | Resume đúng phiên cũ, sửa đúng chỗ, ít tốn token |
| Retry (sau khi Failed) | **Quay về agent gốc** (xoá `active_agent`) | Retry vốn mở phiên mới trên code sạch, không có ngữ cảnh để giữ |
| Task mới | Agent gốc | Như bình thường |
| Người dùng đổi agent bằng tay | Agent được chọn | Phiên mới kèm tóm tắt (FR-97), xoá `active_agent` |

Trong mọi trường hợp, nếu agent cần dùng vẫn đang hết hạn mức thì áp dụng lại quy tắc failover ở trên.

**Xử lý thay đổi dở:** run bị ngắt giữa chừng có thể đã sửa file.
- Agent mới chạy **phiên mới** trong cùng thư mục/worktree. Prompt gồm prompt gốc và ghi chú: "Lần chạy trước bằng <agent> bị dừng do <lý do>. Các file đã sửa: … Hãy kiểm tra và làm tiếp, không làm lại từ đầu."
- Không tự xoá thay đổi dở: người dùng xem được trong Review như mọi run.

**Giới hạn:**
- Mỗi lần đưa vào hàng đợi chỉ chuyển tối đa **1 lần qua mỗi agent** trong chuỗi, không lặp vòng.
- Model không ánh xạ trực tiếp được. Dùng bậc tương đương (thấp/vừa/cao) khi adapter có khai báo, không có thì dùng mặc định của agent mới.

**Hiển thị:**
- Log ghi "Chuyển từ Claude sang Codex: Claude hết hạn mức đến 15:00".
- Thẻ task có badge "đã chuyển agent".
- Banner hết hạn mức ghi thêm "các task đang chạy bằng Codex".
- Telegram báo một lần cho mỗi đợt chuyển, không báo theo từng task.

### 3.7 Những gì giữ chung cho mọi agent
- Lời dặn `BLOCKED_BY` (FR-08): Claude dùng `--append-system-prompt`; agent khác ghép vào đầu prompt. Backend đọc `BLOCKED_BY` trong text output như hiện tại.
- Thư mục làm việc, worktree, snapshot diff, timeout, Stop (kill cây tiến trình), lưu log thô `<runId>.jsonl`: không đổi.
- Prompt luôn truyền qua **stdin** hoặc file tạm, không đặt trong tham số dòng lệnh (bài học P0-SPIKE S4). Agent nào không nhận stdin thì spike tìm cách thay thế.

### 3.8 Bảo mật (R4)
- `env()` của mỗi adapter bắt đầu từ `process.env`, **xoá key của mọi agent khác** và chỉ đặt key của chính nó (mở rộng nguyên tắc của `claudeEnv()`).
- Key của agent khác (nếu người dùng chọn chế độ API key) lưu bằng `secretBox.ts` như key Claude, không ghi vào log.
- Cấu hình quyền tạm (Cursor `cli.json`, settings của agy) ghi trong thư mục run, xoá sau khi chạy; không sửa file cấu hình của người dùng trong repo.

### 3.9 Giao diện
- Thẻ task và lịch sử run: badge agent (Claude / Cursor / Codex / Antigravity) cạnh badge model.
- Form tạo task: dropdown Agent. Mode và model lọc theo `capabilities`, kèm dòng chú thích lý do (ví dụ "Cursor chưa hỗ trợ duyệt từng thao tác").
- Thống kê: thêm chiều lọc theo agent (tỉ lệ duyệt ngay, thời gian, token).
- Agent chưa cài hoặc chưa đăng nhập: vẫn hiện trong dropdown nhưng bị khoá, kèm hướng dẫn cài/đăng nhập.

---

## 4. Yêu cầu chức năng (đề xuất, nhóm 3.10)

| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-90 | Chạy task bằng một trong các agent: Claude Code (mặc định), Cursor CLI, Codex CLI, Antigravity CLI. Kiến trúc adapter, thêm agent mới không phải sửa runner | Must |
| FR-91 | Chọn agent ở 3 tầng Task → Project → Hệ thống; template và import có trường `agent` | Must |
| FR-92 | Trang cài đặt Agents: dò CLI, phiên bản, trạng thái đăng nhập, bật/tắt, sửa đường dẫn | Must |
| FR-93 | Đủ 4 mức quyền (`plan`, `acceptEdits`, `manual`, `auto`) cho mọi agent theo mục 3.3; yêu cầu duyệt của mọi agent đi qua cổng chung (mục 3.3a) nên dùng chung Needs Input, Inbox, Telegram, allowlist, phân loại rủi ro. Kiểm tra cổng bằng lệnh mồi, hook đóng an toàn, năng lực theo phiên bản CLI; chặn mode không hỗ trợ; cấm cờ bỏ qua quyền (trừ ngoại lệ Cursor có điều kiện) | Must |
| FR-94 | Log realtime, tóm tắt kết quả, file thay đổi, review, Request changes chạy được với mọi agent | Must |
| FR-95 | Hiển thị agent và model thực tế của từng run; token/chi phí nếu agent có báo, "—" nếu không | Should |
| FR-96 | Budget cứng chỉ cho phép agent có giới hạn chi phí; nhận diện hết hạn mức hoặc chưa đăng nhập của từng agent và báo lý do dễ hiểu | Should |
| FR-97 | Đổi agent giữa chừng: phiên mới kèm tóm tắt, không resume chéo | Should |
| FR-98 | ~~Hỏi quyền giữa lúc chạy cho agent khác~~ **Đã gộp vào FR-93** (chốt QA2). Còn lại: hỏi lại kiểu `AskUserQuestion` cho agent khác nếu sau này có tool tương đương | Could |
| FR-99 | **Tự chuyển agent khi gặp sự cố** (mục 3.6a): chuỗi dự phòng ở hệ thống, project ghi đè hoặc tắt; mặc định tắt. Bản đầu chỉ chuyển khi **hết hạn mức** (lỗi đăng nhập/hạ tầng chỉ báo kèm nút "Chạy lại bằng agent khác"). Tôn trọng mode quyền và budget; ngắt mạch theo agent đến giờ reset. Request changes / Tiếp tục giữ agent dự phòng, Retry quay về agent gốc | Should |

---

## 5. Câu hỏi cần chốt

| # | Câu hỏi | Đề xuất mặc định |
|---|---|---|
| QA1 | Thứ tự làm agent? | ✅ **Đã chốt 2026-11-18: Codex → Antigravity → Cursor.** Codex là dự phòng chính của failover (`claude → codex`) và có cơ chế duyệt quyền tin cậy nhất; mức quyền của agy gần Claude nhất; Cursor sau cùng vì hỗ trợ Windows và hook duyệt quyền chưa ổn định |
| QA2 | Agent khác có hỗ trợ `manual` và `auto` không? | ✅ **Đã chốt 2026-11-18: có, đủ 4 mode cho mọi agent** (mục 3.3, 3.3a). Cursor ở `manual` chỉ duyệt được lệnh shell/MCP, không duyệt được sửa file |
| QA3 | Có hỗ trợ chế độ API key cho agent khác, hay chỉ dùng phiên đăng nhập CLI? | ✅ **Đã chốt 2026-11-18: chỉ dùng phiên đăng nhập** của từng CLI (C1/C2). Project có budget cứng chỉ chạy bằng Claude |
| QA4 | Telegram, thống kê, gợi ý rule có cần tách theo agent? | ✅ **Đã chốt 2026-11-18:** Telegram dùng chung, tin nhắn ghi tên agent, failover báo một lần mỗi đợt; thống kê thêm bộ lọc agent; gợi ý rule (FR-44) chỉ áp dụng cho Claude. Allowlist vẫn dùng cho mọi agent qua `rule` chuẩn của cổng duyệt quyền |
| QA5 | Có cho một task tự chuyển sang agent khác khi agent hiện tại gặp sự cố? | ✅ **Đã chốt 2026-11-18:** có, theo mục 3.6a (FR-99), mặc định tắt. Bản đầu chỉ chuyển khi **hết hạn mức**. Làm sau khi có ít nhất 2 adapter (M7) |
| QA6 | Chuỗi dự phòng đặt ở hệ thống hay từng project? | ✅ **Đã chốt 2026-11-18:** cả hai. Hệ thống có chuỗi mặc định; project chọn *Dùng chuỗi hệ thống / Tuỳ chỉnh / Tắt* |
| QA7 | Khi agent gốc có lượt lại, task đã chuyển sang agent dự phòng có quay về không? | ✅ **Đã chốt 2026-11-18:** Request changes / Tiếp tục giữ agent dự phòng; **Retry quay về agent gốc**; task mới dùng agent gốc |

---

## 6. Kế hoạch triển khai

| Giai đoạn | Việc | Kết quả |
|---|---|---|
| **M0 Spike** (mỗi agent, theo thứ tự Codex → Antigravity → Cursor) | Cài trên Windows; kiểm tra headless, prompt qua stdin, cwd có dấu cách, NDJSON, resume, các cờ quyền, model, token/cost, mã lỗi khi chưa đăng nhập hoặc hết hạn mức, kill cây tiến trình. **Riêng duyệt quyền:** Codex: app-server, schema `generate-json-schema`, request duyệt lệnh và sửa file, resume thread. agy: có ACP server chính thức không, tên event hook duyệt quyền. Cursor: hook có chạy trong CLI không, `allow`/`deny` có được tôn trọng, có cần `--force` không | Bổ sung bảng S-items vào [P0-SPIKE.md](P0-SPIKE.md), fixture `server/fixtures/<agent>/*`, và bảng "phiên bản đã kiểm chứng" cho từng mode |
| **M1 Refactor** ✅ 2026-11-18 | `server/src/agents/` (`types.ts`, `claude.ts`, `index.ts`): runner chạy qua `AgentAdapter` (`prepare`, `createParser`, `detectRateLimit`, `onSuccess`/`onRateLimit`, `failureHint`, `isMissingSession`); thông báo lỗi theo `adapter.name`. `permissionBroker.ts`: `toClaudeTool` (đổi yêu cầu agent sang Bash/Edit/Write/Read/WebFetch/mcp__), `modeDecision` (đọc trong thư mục task, plan, acceptEdits), `awaitPermission` (chờ trong tiến trình, đóng an toàn). Claude vẫn đi MCP như cũ. Test: 548 test cũ giữ nguyên + 14 mới (`permissionBroker*.test.ts`, `agents/runnerAdapter.test.ts`). Còn lại cho M3: log "Claude xin quyền…" trong `permissions.ts` cần ghi đúng tên agent | Không đổi hành vi; toàn bộ test hiện có xanh (R7) |
| **M2 Dữ liệu + UI** ✅ 2026-11-18 (một phần) | Đã làm: cột `tasks.agent`, `projects.default_agent`, `runs.agent`, `Settings.defaultAgent` (mặc định `claude`); `web/src/lib/agent.ts` (`resolveAgent` 3 tầng, dùng chung web/server); API `GET /api/agents` (+ trong `/api/state`), kiểm tra agent + mức quyền khi tạo/sửa task, lưu project, lưu cài đặt, và lại lúc chạy (`agentProblem`); run ghi agent thực tế. UI: `AgentSelect` (agent chưa hỗ trợ / không hỗ trợ mức quyền bị khoá kèm lý do, chưa cài thì cảnh báo) ở form Task, Project, Cài đặt (kèm bảng "Các agent trên máy" + Kiểm tra lại); `AgentBadge` ở đầu trang task (ẩn khi là Claude), mục Prompt, lịch sử run. Test: `agents/agentSelect.test.ts` (7). **Bổ sung 2026-11-19:** template có trường `agent` (cột `templates.agent`, chọn ở form template, dùng template thì điền agent khi task chưa chọn); import có cột `agent` (nhận id hoặc tên hiển thị như "Claude Code", "agy"; có trong file mẫu .xlsx/.csv), agent lạ hoặc agent × mức quyền không chạy được báo lỗi theo dòng ở bước xem trước (AC-33). **Chưa làm:** lọc model theo agent | FR-91, 92, 95 |
| **M3 Codex** ✅ 2026-11-18 | Đã làm: runner có chế độ driver hai chiều (`createDriver`, `DriverContext`: `send`/`emit`/`requestPermission`/`askUser`/`done`), lưu id phiên do agent sinh (`runs.setSessionId`), không resume chéo khi đổi agent (FR-97), agent khác Claude dùng model mặc định của agent (không chạy bộ chọn/nâng bậc Haiku→Opus). `agents/codex.ts` (dò CLI: `CODEX_BIN` → extension `openai.chatgpt` mới nhất của VS Code/Cursor/Windsurf → PATH; bỏ mọi API key khỏi môi trường) + `agents/codexDriver.ts`: `untrusted` cho mọi mode (plan thêm sandbox `read-only`), broker quyết theo mode; bóc vỏ `powershell -Command '…'` / `bash -lc '…'` để allowlist và phân loại rủi ro thấy lệnh thật; hỏi lại người dùng qua luồng `AskUserQuestion`; `usageLimitExceeded`/`rateLimitExceeded` → chờ giờ reset như Claude; mất thread khi resume → chạy lại phiên mới; log "Codex xin quyền…". Test: `agents/codex.test.ts` (9) với app-server giả `fixtures/codex/fake-app-server.mjs`. **Smoke test thật** (codex-cli 0.169.0-alpha, mode manual): 2 yêu cầu duyệt đúng lệnh, task sang Review, file được tạo, lưu thread id + model. **Bổ sung 2026-11-19:** watchdog CD3 (sửa file đã duyệt quá 60 giây chưa xong → `turn/interrupt` rồi `turn/start` chạy tiếp trong cùng thread, tối đa 1 lần/run; test kịch bản `stall`); lịch sử run hiện "— · N token ngữ cảnh" khi agent không báo USD. **Chưa làm:** gửi lý do từ chối cho Codex (giao thức chỉ có accept/decline). **Đề xuất điều chỉnh:** lệnh mồi kiểm tra cổng (`verifyGate`, AC-33b) chỉ bắt buộc với agent duyệt quyền qua **hook** (Cursor, M6). Codex app-server và Antigravity ACP duyệt quyền bằng giao thức gốc của CLI, đã kiểm chứng ở spike và smoke test, và mọi lỗi phía Task Board đều dẫn tới từ chối; chạy lệnh mồi mỗi run sẽ tốn thêm một lượt model và khoảng 10 giây. Ghi chú: Codex hay tạo/sửa file bằng lệnh shell (`Set-Content`) thay vì `apply_patch`, nên ở `acceptEdits` các lệnh đó vẫn cần duyệt hoặc allowlist | FR-90, 93, 94 với Codex |
| **M4 Failover** ✅ 2026-11-19 | Đã làm: `Settings.failover {enabled, chain}` (mặc định tắt, `claude → codex`), `projects.failover_mode` (`inherit`/`custom`/`off`) + `failover_chain`, `tasks.active_agent`. Hàm thuần trong `web/src/lib/agent.ts`: `failoverChain` (QA6), `pickFallback` (đã cài + còn lượt + hỗ trợ mức quyền + budget cứng), `agentForRun` (QA7: resume/continue giữ agent dự phòng, initial/retry về agent gốc). `agents/limits.ts`: hạn mức theo agent (Claude dùng `claudeLimit`, Codex ghi khi gặp `usageLimitExceeded`). Runner: hết hạn mức → `failover()` đưa task về Queued với `activeAgent` mới, chạy ngay (run `continue`/`resume` trên phiên mới, cùng thư mục); ngắt mạch lúc `startRun` (agent đang hết lượt → đi thẳng agent dự phòng); không có agent phù hợp → chờ giờ reset như cũ. Đổi agent bằng tay xoá `activeAgent`. UI: công tắc + `ChainEditor` ở Cài đặt, "Khi agent hết hạn mức" ở Project, badge `↪ Codex` (màu hổ phách) khi task đang dùng agent dự phòng, "Hết hạn mức đến …" trong bảng agent. Test: `agents/failover.test.ts` (7, gồm AC-37/38/41, QA7, API). **Bổ sung 2026-11-19:** sự kiện `agent_failover` trên bus; Telegram báo một lần mỗi đợt (cùng cặp agent nguồn → đích, đến giờ agent nguồn có lượt lại, không biết giờ thì 1 giờ); tin "cần bạn" ghi đúng tên agent; banner hết lượt Claude thêm dòng "N task đang chạy bằng Codex". **Chưa làm:** banner cho agent khác Claude hết lượt (hiện chỉ có badge và bảng agent ở Cài đặt), ghi danh sách file đã sửa dở vào prompt của agent dự phòng (hiện dùng lời nhắc tiếp tục chung), lỗi đăng nhập / hạ tầng vẫn chỉ báo (đúng phạm vi bản đầu) | FR-99 |
| **M5 Antigravity** ✅ 2026-11-19 | Đã làm: `agents/antigravity.ts` (dò CLI: `AGY_BIN` → `~/.gemini/bin/agy` → PATH; `ensureAgySettings` ghi `~/.gemini/taskboard-agy/settings.json` = `toolPermission: strict`, giữ khoá khác, không đụng `~/.gemini/antigravity-cli/`; chạy `agy acp --app-data-dir taskboard-agy`; bỏ mọi API key; `RESOURCE_EXHAUSTED`/quota → chờ giờ reset + ngắt mạch) + `agents/antigravityDriver.ts` (client ACP: `initialize` → `session/new`/`session/load` → `session/set_model` nếu model có trong danh sách → `session/prompt`; `session/request_permission` đi qua PermissionBroker, ánh xạ `toolCall.kind` execute/edit/read/fetch; bị từ chối thì gửi lý do ở lượt nối tiếp, tối đa 2 lần; gom `agent_message_chunk`, cảnh báo `⚠ API error` của agy hiện là thông báo hệ thống; lời dặn `BLOCKED_BY` ghép vào đầu prompt). Test: `agents/antigravity.test.ts` (7) với ACP giả `fixtures/antigravity/fake-acp.mjs`. **Smoke test thật** (agy 1.5.11, mode manual): xin duyệt lệnh và **sửa file** (strict có hiệu lực), task sang Review, lưu session id + model. **Chưa làm:** `session/set_mode` (Task Board quyết theo mode qua broker, chưa dùng mode `plan` gốc của agy), `_meta.systemPrompt` cho BLOCKED_BY, hỏi lại người dùng (ACP không có) | FR-90, 93, 94 với agy |
| **M6 Cursor** | `CursorAdapter`, duyệt quyền qua hook đóng an toàn | FR-90, 93, 94 với Cursor |

Mỗi adapter làm xong thì ghép vào bản phát hành ngay, không chờ đủ cả ba.

---

## 7. Tiêu chí nghiệm thu (đề xuất)

| AC | Nội dung |
|---|---|
| AC-30 | Không cấu hình gì: mọi task chạy bằng Claude, hành vi giống hệt bản trước (toàn bộ test cũ xanh) |
| AC-31 | Project đặt agent Cursor: task mới chạy bằng `cursor-agent`, log realtime hiện tin nhắn và tool, xong chuyển Review với đúng danh sách file thay đổi |
| AC-32 | Request changes trên task Cursor resume đúng chat id; đổi sang Codex thì mở phiên mới kèm tóm tắt |
| AC-33 | Chọn mode mà agent ở phiên bản đã cài chưa được kiểm chứng: form báo lỗi, import báo lỗi dòng; không có lệnh nào chạy với `--dangerously-skip-permissions` / `danger-full-access` / `--yolo` |
| AC-33a | Task Codex mode `manual` yêu cầu chạy `npm install`: task chuyển Needs Input, duyệt được trên web và Telegram; Deny kèm lý do thì Codex nhận lý do và đổi cách làm. Mode `auto`: lệnh thường tự duyệt, `git push` vẫn dừng chờ |
| AC-33b | Cổng duyệt quyền hỏng (giả lập: hook không gọi được backend, hoặc lệnh mồi không sinh yêu cầu duyệt): run dừng trước khi làm việc thật, task Failed với lý do rõ; hook lỗi luôn trả `deny` |
| AC-33c | Allowlist project có `Bash(npm test)`: yêu cầu chạy `npm test` từ Codex, agy và Cursor đều được tự duyệt như với Claude |
| AC-34 | Tiến trình Cursor/Codex/agy không có `ANTHROPIC_API_KEY`; tiến trình Claude không có key của agent khác |
| AC-35 | Agent chưa cài hoặc chưa đăng nhập: task Failed với lý do và hướng dẫn cụ thể, không treo |
| AC-36 | Agent không báo chi phí: cột chi phí hiển thị "—", budget tháng không bị cộng sai |
| AC-37 | Bật failover `claude → codex`, Claude hết hạn mức: task đang chạy chuyển sang Codex với ghi chú thay đổi dở; các task Queued sau đó chạy thẳng bằng Codex đến giờ reset; task mới sau giờ reset chạy lại bằng Claude |
| AC-38 | Task mode `auto` khi Claude hết hạn mức: **không** chuyển agent, task chờ reset như cũ, log ghi lý do |
| AC-39 | Task thất bại do nội dung (Claude báo lỗi, test fail): không chuyển agent |
| AC-40 | Task #5 đã chuyển sang Codex, sau giờ reset bấm Request changes: Codex resume đúng phiên cũ. Cùng task bị Failed rồi bấm Retry: chạy phiên mới bằng Claude |
| AC-41 | Hệ thống bật failover `claude → codex`, project X đặt *Tắt failover*: task của X khi Claude hết hạn mức thì chờ reset; project đặt *Tuỳ chỉnh* `claude → cursor` thì không bao giờ chạy bằng Codex |
| AC-42 | Claude báo chưa đăng nhập (bản đầu): không tự chuyển; task Failed với lý do và nút "Chạy lại bằng Codex" |

---

## Nguồn tham khảo (kiểm tra ngày 2026-11-18)
- Antigravity CLI headless: <https://antigravity.google/docs/cli/headless>; chọn bề mặt Antigravity (CLI/IDE/SDK): <https://cloud.google.com/blog/topics/developers-practitioners/choosing-your-surface-antigravity-20-antigravity-cli-antigravity-ide-or-antigravity-sdk>; cheat sheet: <https://computingforgeeks.com/antigravity-cli-cheat-sheet/>
- Cursor CLI: <https://cursor.com/docs/cli/reference/parameters>, <https://cursor.com/docs/cli/reference/output-format>
- Codex non-interactive: <https://developers.openai.com/codex/noninteractive>; Codex app-server và luồng duyệt quyền: <https://openai.com/index/unlocking-the-codex-harness>, <https://github.com/openai/codex/pull/7105/files>
- Hook của Antigravity: <https://antigravity.google/docs/hooks.md>, quyền: <https://antigravity.google/docs/cli/permissions>
- Báo lỗi hook Cursor (`ask` bị bỏ qua, JSON lỗi thì cho chạy): <https://forum.cursor.com/t/hooks-ask-permission-broken-in-2-4-21/150020>, <https://forum.cursor.com/t/beforeshellexecution-hook-malformed-json-response-silently-allows-command-instead-of-blocking/152669>, <https://forum.cursor.com/t/cursor-cli-hooks/148511>
- Gemini CLI headless (tiền thân của agy): <https://geminicli.com/docs/cli/headless/>
