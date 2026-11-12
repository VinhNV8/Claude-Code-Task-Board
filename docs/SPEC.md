# SPEC: Claude Task Board

| Mục | Giá trị |
|---|---|
| Phiên bản | 0.3 |
| Ngày | 2026-11-12 |
| Trạng thái | v0.2 ✅ đã duyệt. Phần mới của v0.3 (FR-43..46, FR-70..76, FR-80..83): ⏳ **chờ duyệt** |
| Thay đổi 0.2 | Cập nhật theo [P0-SPIKE.md](P0-SPIKE.md): dò file `claude.exe` của extension VSCode; mode `default` đổi thành `manual`; prompt truyền qua stdin; P3 dùng `--permission-prompt-tool` (đã kiểm chứng); SQLite dùng `node:sqlite` có sẵn trong Node 24 |
| Thay đổi 0.3 | Bổ sung yêu cầu từ [Ideas Improvement.md](Ideas%20Improvement.md): **3.8 Chọn model** (tự chọn theo độ khó, hiển thị model đang dùng), **3.9 Chi phí và budget theo project**, cải tiến **3.5 Needs Input** (preset, gợi ý rule, Telegram, rủi ro, lý do từ chối). Cập nhật 5.2, 5.3, 7, 8, 9, 10. Thiết kế chi tiết ở PLAN mục P5–P7 |
| Thư mục dự án | `d:\Projects\AI Project\AI-Interface` |

---

## 0. Yêu cầu gốc (nguyên văn)

> Tôi muốn tạo 1 giao diện để giao việc cho Claude code của tôi làm việc. Tôi có thể tracking được các task Claude đang làm, task nào cần tôi review,....
> Hãy đề xuất giúp tôi... Mục tiêu, tôi nghỉ cần mở giao diện để quản lý toàn bộ, không cần phải mở vscode để xem chi tiết trên đó.
> Chú ý: Không call Claude API nhé, chỉ sử dụng vscode hiện tại thôi.

> Viết chúng thành spec .md, để tôi duyệt - cần phải lưu toàn bộ req.

---

## 1. Mục tiêu

### 1.1 Mục tiêu chính
- **G1.** Giao việc (task) cho Claude Code qua một giao diện web.
- **G2.** Theo dõi trạng thái từng task: đang chờ, đang chạy, cần mình xử lý, chờ review, hoàn thành, lỗi.
- **G3.** Review kết quả (thay đổi code) và duyệt hoặc yêu cầu sửa ngay trên giao diện.
- **G4.** Quản lý toàn bộ công việc chỉ bằng giao diện, **không cần mở VSCode** để xem chi tiết.

### 1.2 Ràng buộc bắt buộc
- **C1. Không gọi Claude API trực tiếp** (không dùng API key, không dùng Anthropic SDK hay Messages API).
- **C2.** Chỉ dùng **Claude Code đã cài và đăng nhập sẵn** trên máy (cùng tài khoản đang dùng trong VSCode), gọi qua CLI `claude`.
- **C3.** Chạy local trên máy của chủ dự án (Windows 11).

### 1.3 Ngoài phạm vi (v1)
- Hỗ trợ nhiều người dùng, phân quyền theo user.
- Triển khai lên cloud hoặc server công khai.
- Thay thế VSCode trong việc viết code tay.

---

## 2. Nguyên lý hoạt động

Claude Code có **chế độ headless**: `claude -p "<prompt>"`. Lệnh này dùng phiên đăng nhập Claude Code hiện có (gói Pro/Max), nên **thỏa ràng buộc C1 và C2**.

```
┌──────────────┐   HTTP/WS   ┌──────────────────┐  spawn   ┌─────────────────────┐
│  Web UI      │ ◄─────────► │ Backend local    │ ───────► │ claude -p ...       │
│ (Kanban)     │             │ Node + SQLite    │ ◄─────── │ (mỗi task chạy trong│
└──────────────┘             └──────────────────┘  stream  │  1 git worktree)    │
                                     ▲                      └─────────────────────┘
                                     │  Hooks (Stop, Notification) gửi sự kiện về
```

1. **Giao task**: backend chạy tiến trình
   `claude -p --output-format stream-json --verbose --session-id <uuid> [--permission-mode ...] [--allowedTools ...]` (prompt truyền qua **stdin**)
   với thư mục làm việc là worktree của task.
2. **Theo dõi**: backend đọc output stream-json từng dòng, lưu vào DB và đẩy lên UI qua WebSocket.
3. **Review**: backend lấy `git diff` của worktree và hiển thị trên UI.
4. **Yêu cầu sửa**: backend chạy `claude -p --resume <session_id> "<feedback>"` để tiếp tục đúng phiên cũ.
5. **Sự kiện**: hooks của Claude Code (`Stop`, `Notification`) gọi HTTP về backend để cập nhật trạng thái.

---

## 3. Yêu cầu chức năng (Functional Requirements)

### 3.1 Quản lý task
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-01 | Tạo task: tiêu đề, mô tả (prompt), project/repo, độ ưu tiên, mức quyền | Must |
| FR-02 | Sửa hoặc xóa task khi task còn ở Backlog hay Queued | Must |
| FR-03 | Đưa task vào hàng đợi (Queue) để tự động chạy | Must |
| FR-04 | Hủy (Stop) task đang chạy | Must |
| FR-05 | Chạy lại (Retry) task bị lỗi | Should |
| FR-06 | Template prompt dùng lại (ví dụ "Fix bug", "Viết test", "Refactor") | Could |
| FR-07 | Gắn tag và lọc/tìm kiếm task | Could |

### 3.2 Bảng Kanban và trạng thái
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-10 | Kanban với các cột: **Backlog → Queued → Running → Needs Input → Review → Done / Failed** | Must |
| FR-11 | Trạng thái cập nhật realtime, không cần reload trang | Must |
| FR-12 | Badge đếm số task ở **Needs Input** và **Review** (những task cần mình xử lý) | Must |

**Vòng đời trạng thái:**
```
Backlog ─► Queued ─► Running ─┬─► Review ─┬─► Done (Approve & Merge)
                              │           ├─► Running (Request changes → resume)
                              │           └─► Failed/Rejected (Reject)
                              ├─► Needs Input ─► Running (sau khi trả lời / cấp quyền)
                              └─► Failed ─► Queued (Retry)
```

### 3.3 Theo dõi chi tiết task
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-20 | Log realtime: tin nhắn của Claude, tool đang dùng (đọc/sửa file, chạy lệnh) | Must |
| FR-21 | Tóm tắt kết quả cuối cùng của Claude | Must |
| FR-22 | Thời gian chạy, số lượt (turns), chi phí ước tính lấy từ output `result` | Should |
| FR-23 | Lịch sử tất cả các lần chạy (runs) của một task | Should |

### 3.4 Review
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-30 | Xem danh sách file thay đổi và diff từng file (side-by-side hoặc unified) | Must |
| FR-31 | **Approve & Merge**: commit thay đổi trong worktree và merge vào nhánh chính | Must |
| FR-32 | **Request changes**: nhập feedback, task chạy tiếp bằng `--resume` | Must |
| FR-33 | **Reject**: hủy thay đổi, xóa worktree/nhánh | Must |
| FR-34 | Chạy lệnh kiểm tra (ví dụ `npm test`) và hiển thị kết quả trên trang review | Could |

### 3.5 Needs Input (Claude cần mình)
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-40 | Khi Claude cần xin quyền dùng tool hoặc hỏi lại, task chuyển sang **Needs Input** | Must |
| FR-41 | Trả lời hoặc cấp quyền (Allow / Deny) ngay trên web | Should |
| FR-42 | Lưu quy tắc "luôn cho phép" theo từng project | Could |
| FR-43 | Bộ quy tắc mẫu (preset) cho allowlist: Node/npm, Python, git chỉ đọc, chỉ đọc file. Preset không chứa lệnh có tác dụng phụ (`npm install`, `git push`, `git commit`) | Should |
| FR-44 | Gợi ý thêm rule vào allowlist từ lịch sử: rule được cho phép ≥ 3 lần trong 30 ngày, chưa bị từ chối lần nào, không phải lệnh rủi ro; người dùng có thể Thêm hoặc Bỏ qua | Should |
| FR-45 | Phân loại rủi ro yêu cầu quyền (xoá đệ quy, `git push`, `reset --hard`, tải script về chạy, ghi file ngoài thư mục task…): hiển thị cảnh báo đỏ kèm lý do, **không** cho "Luôn cho phép", và allowlist không được tự duyệt các lệnh này | Should |
| FR-46 | Từ chối kèm lý do (lý do được gửi cho Claude để đổi cách làm); duyệt hàng loạt các yêu cầu giống hệt nhau ở Inbox; duyệt bằng nút trên Telegram (chỉ nhận từ đúng chat đã cấu hình) | Could |

### 3.6 Thông báo
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-50 | Thông báo trên trình duyệt (Web Notification) khi task chuyển sang Review, Needs Input hoặc Failed | Should |
| FR-51 | Thông báo qua Telegram (tùy chọn) | Could |

### 3.7 Quản lý project
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-60 | Khai báo một hoặc nhiều project (đường dẫn repo git, nhánh chính) | Must |
| FR-61 | Cấu hình mặc định theo từng project: mức quyền, allowedTools, số task chạy song song | Should |

### 3.8 Chọn model
Bối cảnh: người dùng thường không tự chọn model, nên mặc định là **Tự động**. Hệ thống chọn model, giải thích lý do, và người dùng chỉ đổi khi muốn.

| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-70 | Hiển thị model **thực tế** của mỗi lần chạy (lấy từ event `init` của CLI) trên thẻ task (realtime, ngay khi task bắt đầu chạy) và trong lịch sử run; kèm token và chi phí ước tính **theo từng model** (từ `modelUsage` của `result`) | Must |
| FR-71 | Cấu hình model ở 3 tầng: Task → Project → Hệ thống, lấy giá trị không rỗng đầu tiên. Giá trị: Tự động / Haiku / Sonnet / Opus. Mặc định của hệ thống: **Tự động** | Must |
| FR-72 | Chế độ Tự động chọn model bằng **quy tắc chấm điểm** (tag, mức quyền, từ khoá trong prompt, độ dài, số file nhắc tới), **không gọi thêm model** để phân loại. Lý do chọn được lưu và hiển thị | Must |
| FR-73 | Form tạo task hiển thị trước model sẽ dùng và lý do, cập nhật trong lúc gõ; đổi bằng một thao tác; template có thể chỉ định model | Should |
| FR-74 | Lần chạy tiếp nối (Request changes, Tiếp tục) **giữ nguyên model** của lần trước để tận dụng prompt cache, trừ trường hợp ở FR-75 | Must |
| FR-75 | Tự nâng một bậc (Haiku → Sonnet → Opus) khi Retry sau lần chạy lỗi hoặc khi Request changes lần thứ 2 trở đi. Không áp dụng với model chọn tay. Ngữ cảnh ≥ 80k token thì mở phiên mới kèm tóm tắt thay vì resume. Có công tắc tắt | Should |
| FR-76 | Tự hiệu chỉnh gợi ý theo lịch sử từng project (tỉ lệ được duyệt ngay theo tag × model, cần ≥ 10 mẫu, mỗi lần chỉ dịch 1 bậc); trang Thống kê có bảng tag × model | Could |

### 3.9 Chi phí và budget
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-80 | Budget tháng (USD, tuỳ chọn) cho từng project; tính chi tiêu tháng hiện tại (giờ địa phương) từ chi phí các run | Should |
| FR-81 | Cảnh báo khi đạt 80% và 100% budget, mỗi mức một lần mỗi tháng, qua thông báo web và Telegram (nếu bật) | Should |
| FR-82 | Chế độ "Tạm dừng khi vượt budget": không khởi chạy task mới của project (task đang chạy được chạy xong), tự chạy lại khi sang tháng; khi project đã ≥ 80% budget thì không tự nâng model quá Sonnet | Should |
| FR-83 | Trang Projects hiện thanh chi tiêu / budget; trang Thống kê hiện chi phí theo model và dự báo cuối tháng. Mọi số tiền ghi rõ là **ước tính theo giá niêm yết** (gói subscription không trừ tiền theo con số này) | Should |

---

## 4. Yêu cầu phi chức năng (Non-Functional Requirements)

| ID | Yêu cầu |
|---|---|
| NFR-01 | **Không gọi Claude API**, chỉ chạy CLI `claude` đã đăng nhập sẵn |
| NFR-02 | Cách ly: mỗi task chạy trong **git worktree riêng** để các task song song không ghi đè nhau |
| NFR-03 | Giới hạn số task chạy song song (mặc định **2**, cấu hình được) để không vượt giới hạn sử dụng của gói |
| NFR-04 | Backend chỉ lắng nghe `127.0.0.1` (mặc định). Nếu mở ra mạng ngoài thì bắt buộc có token hoặc mật khẩu |
| NFR-05 | Dữ liệu lưu bền vững (SQLite). Khởi động lại backend không mất task/log; task đang Running khi bị tắt được đánh dấu Failed hoặc cho phép resume |
| NFR-06 | Log realtime có độ trễ dưới 1 giây |
| NFR-07 | Chạy được trên Windows 11 (đường dẫn có dấu cách, PowerShell/Git Bash) |
| NFR-08 | Khởi động bằng một lệnh: `npm start`, sau đó mở `http://localhost:3000` |

---

## 5. Kiến trúc và công nghệ

| Thành phần | Công nghệ |
|---|---|
| Backend | Node.js + Fastify, `child_process.spawn` để gọi `claude` |
| Realtime | WebSocket (`ws`) |
| Database | SQLite (`better-sqlite3`) |
| Frontend | React + Vite + TailwindCSS |
| Xem diff | `diff2html` hoặc `react-diff-view` |
| Git | CLI `git` (worktree, diff, commit, merge) |

### 5.1 Cấu trúc thư mục dự kiến
```
AI-Interface/
├── docs/SPEC.md
├── server/
│   ├── index.ts          # Fastify + WS
│   ├── runner.ts         # spawn claude, parse stream-json, queue
│   ├── git.ts            # worktree, diff, merge
│   ├── hooks.ts          # endpoint nhận sự kiện từ Claude Code hooks
│   └── db.ts             # SQLite schema + queries
├── web/                  # React app
└── package.json
```

### 5.2 Mô hình dữ liệu
```
projects(id, name, repo_path, main_branch, default_permission_mode, allowed_tools, max_parallel)
tasks(id, project_id, title, prompt, status, priority, permission_mode, branch, worktree_path,
      session_id, created_at, updated_at)
runs(id, task_id, session_id, kind[initial|resume|retry], started_at, ended_at, exit_code,
     num_turns, cost_usd, result_summary)
events(id, run_id, ts, type, payload_json)      -- log stream-json
reviews(id, task_id, action[approve|request_changes|reject], feedback, created_at)
```
Bổ sung ở v0.3:
```
projects   + default_model, monthly_budget_usd, budget_action[warn|pause]
tasks      + model                                   -- '' = kế thừa, 'auto' | haiku | sonnet | opus
runs       + model, requested_model, model_source[auto|manual|default|escalated], model_reason,
             model_usage (JSON theo model), context_tokens
templates  + model
permission_requests + deny_reason
settings   + defaultModel (mặc định 'auto'), autoEscalate (mặc định true)
```

### 5.3 API (REST + WS)
| Method | Path | Mô tả |
|---|---|---|
| GET/POST | `/api/projects` | Danh sách / tạo project |
| GET/POST | `/api/tasks` | Danh sách / tạo task |
| PATCH/DELETE | `/api/tasks/:id` | Sửa / xóa task |
| POST | `/api/tasks/:id/queue` | Đưa vào hàng đợi |
| POST | `/api/tasks/:id/stop` | Dừng task |
| POST | `/api/tasks/:id/retry` | Chạy lại |
| GET | `/api/tasks/:id/diff` | Lấy diff |
| POST | `/api/tasks/:id/review` | `{action, feedback}` |
| POST | `/api/tasks/:id/input` | Trả lời hoặc cấp quyền |
| POST | `/hooks/:event` | Nhận sự kiện từ hooks của Claude Code |
| WS | `/ws` | Đẩy sự kiện realtime (task status, log) |
| POST | `/api/model-suggest` | v0.3: model sẽ dùng và lý do (không gọi Claude, < 20ms) |
| GET | `/api/permission-presets` | v0.3: danh sách preset allowlist |
| GET | `/api/projects/:id/rule-suggestions` | v0.3: rule gợi ý từ lịch sử (+ `POST .../dismiss`) |
| POST | `/api/permissions/batch` | v0.3: duyệt hàng loạt `{ids, decision, reason?}` |

### 5.4 Hooks của Claude Code
Cấu hình trong `.claude/settings.json` của worktree hoặc project:
- `Stop`: gọi `POST /hooks/stop`, task chuyển sang **Review** (nếu có thay đổi) hoặc **Done**.
- `Notification`: gọi `POST /hooks/notification`, task chuyển sang **Needs Input**.
- Duyệt quyền trên web (FR-41): dùng `--permission-prompt-tool` trỏ tới một MCP server nhỏ do backend cung cấp.

---

## 6. Giao diện (UI)

1. **Dashboard / Kanban**: các cột trạng thái, badge "Cần xử lý", bộ lọc theo project.
2. **Form tạo task**: modal gồm tiêu đề, prompt (textarea lớn), project, template, mức quyền, ưu tiên.
3. **Chi tiết task**: tab *Log* (realtime), tab *Diff*, tab *Lịch sử runs*, cùng các nút hành động.
4. **Trang Review**: diff và 3 nút **Approve & Merge / Request changes / Reject**.
5. **Settings**: quản lý project, giới hạn song song, thông báo.

---

## 7. Lộ trình triển khai

| Giai đoạn | Nội dung | Ước lượng |
|---|---|---|
| **PT – Prototype** | Giao diện bấm được với dữ liệu giả, đủ mọi màn hình và luồng; **duyệt UI trước khi phát triển** | 1.5 ngày + vòng chỉnh sửa |
| **P1 – MVP** | Tạo task, queue, chạy `claude -p`, log realtime, Done/Failed, SQLite | 1–2 ngày |
| **P2 – Review** | Worktree theo task, xem diff, Approve/Merge, Request changes (`--resume`), Reject | 1–2 ngày |
| **P3 – Needs Input** | Hooks, duyệt quyền trên web, thông báo trình duyệt | 1–2 ngày |
| **P4 – Nâng cao** | Nhiều project, template, thống kê, Telegram, lên lịch | Tùy chọn |
| **P5 – Chọn model** | FR-70..76 | ~4 ngày |
| **P6 – Budget** | FR-80..83 | ~1,5 ngày |
| **P7 – Duyệt quyền nâng cao** | FR-43..46 | ~2,5 ngày |

---

## 8. Tiêu chí nghiệm thu (Acceptance Criteria)

- **AC-01**: Tạo task trên web, task tự chạy và log hiện realtime **mà không mở VSCode**.
- **AC-02**: Khi Claude xong việc, task tự chuyển sang **Review** và diff hiển thị đúng.
- **AC-03**: Approve thì code được merge vào nhánh chính. Request changes thì Claude tiếp tục đúng phiên cũ với feedback.
- **AC-04**: Chạy song song 2 task trên cùng repo mà không xung đột file.
- **AC-05**: Không có bất kỳ lời gọi trực tiếp nào tới Claude API, không cần `ANTHROPIC_API_KEY`.
- **AC-06**: Khởi động lại backend không mất dữ liệu task.
- **AC-07** (v0.3): Tạo task mà không chọn model: "Sửa typo README" chạy Haiku, task thêm tính năng thông thường chạy Sonnet, "Refactor kiến trúc…" chạy Opus. Thẻ task hiện model và lý do chọn.
- **AC-08** (v0.3): Request changes giữ nguyên model. Retry sau lỗi tự nâng một bậc, trừ khi model được chọn tay.
- **AC-09** (v0.3): Project đặt budget ở chế độ "Tạm dừng": khi vượt budget thì task mới không chạy và có lý do hiển thị, cảnh báo 80%/100% chỉ gửi một lần trong tháng.
- **AC-10** (v0.3): Lệnh rủi ro cao luôn phải duyệt tay (kể cả khi khớp allowlist) và không có nút "Luôn cho phép".

---

## 9. Rủi ro và lưu ý

| Rủi ro | Giảm thiểu |
|---|---|
| Vượt giới hạn sử dụng của gói Claude khi chạy nhiều task | Giới hạn song song, hiển thị thông báo lỗi rate limit, tự retry sau |
| Claude chạy lệnh nguy hiểm khi tự động | `--allowedTools` whitelist, mặc định `acceptEdits`, không bật bypass permissions |
| Merge conflict khi nhiều task sửa cùng file | Phát hiện conflict khi merge, chuyển task về Review kèm cảnh báo |
| Định dạng output CLI thay đổi theo phiên bản | Gom phần parse vào một module, ghi lại phiên bản `claude` đã test |
| Worktree tích tụ chiếm dung lượng | Tự dọn worktree khi task Done/Rejected |
| Tự chọn model sai (model rẻ làm hỏng, tốn thêm một lần chạy) | Ngưỡng chọn Haiku chặt; tự nâng model khi lỗi (FR-75); hiệu chỉnh theo lịch sử (FR-76); người dùng luôn chọn tay được |
| Đổi model giữa phiên làm mất prompt cache (cache gắn với từng model) | Resume giữ model (FR-74); khi nâng model mà ngữ cảnh ≥ 80k token thì mở phiên mới kèm tóm tắt |
| Chi phí hiển thị khác số tiền thực trả (gói subscription) | Ghi rõ "ước tính theo giá niêm yết"; giới hạn thật vẫn là hạn mức gói (đã xử lý rate limit) |
| Duyệt quyền qua Telegram bị người lạ bấm | Chỉ nhận callback từ đúng chat ID đã cấu hình; lệnh rủi ro không có "Luôn cho phép" |

---

## 10. Câu hỏi cần chủ dự án chốt

| # | Câu hỏi | Đề xuất mặc định |
|---|---|---|
| Q1 | Quản lý **một repo** hay **nhiều project**? | Nhiều project (đã thiết kế sẵn) |
| Q2 | Mức tự động: Claude tự sửa file và chạy lệnh trong whitelist, hay mọi thao tác đều phải duyệt? | Tự sửa file + whitelist lệnh, các lệnh khác phải duyệt |
| Q3 | Có cần truy cập từ **điện thoại / máy khác**? | Chỉ local ở v1, sau có thể dùng Tailscale |
| Q4 | Stack **Node/React** hay **Python (FastAPI)**? | Node/React |
| Q5 | Số task chạy song song tối đa? | 2 |
| Q6 | Có cần thông báo Telegram? | Không ở v1 |
| Q7 (v0.3) | Model mặc định của hệ thống khi người dùng không chọn? | **Tự động** (FR-72) |
| Q8 (v0.3) | Khi vượt budget mặc định làm gì? | **Chỉ cảnh báo**; "Tạm dừng" bật theo từng project |
| Q9 (v0.3) | Có dùng LLM (Haiku) để phân loại độ khó task không? | **Không** ở giai đoạn này: tốn thêm khoảng 0,5–1 cent mỗi task qua CLI, lợi ích chưa rõ so với quy tắc + tự nâng model |

---

## 11. Phê duyệt

- [ ] Chủ dự án đã đọc và đồng ý phạm vi
- [ ] Đã trả lời các câu hỏi ở Mục 10
- [ ] Đồng ý bắt đầu Giai đoạn P1
