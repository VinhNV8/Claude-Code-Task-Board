# SPEC: Claude Task Board

| Mục | Giá trị |
|---|---|
| Phiên bản | 0.2 |
| Ngày | 2026-11-11 |
| Trạng thái | ✅ Đã duyệt (áp dụng đề xuất mặc định Mục 10); prototype giao diện đã duyệt |
| Thay đổi 0.2 | Cập nhật theo [P0-SPIKE.md](P0-SPIKE.md): dò file `claude.exe` của extension VSCode; mode `default` đổi thành `manual`; prompt truyền qua stdin; P3 dùng `--permission-prompt-tool` (đã kiểm chứng); SQLite dùng `node:sqlite` có sẵn trong Node 24 |
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

---

## 8. Tiêu chí nghiệm thu (Acceptance Criteria)

- **AC-01**: Tạo task trên web, task tự chạy và log hiện realtime **mà không mở VSCode**.
- **AC-02**: Khi Claude xong việc, task tự chuyển sang **Review** và diff hiển thị đúng.
- **AC-03**: Approve thì code được merge vào nhánh chính. Request changes thì Claude tiếp tục đúng phiên cũ với feedback.
- **AC-04**: Chạy song song 2 task trên cùng repo mà không xung đột file.
- **AC-05**: Không có bất kỳ lời gọi trực tiếp nào tới Claude API, không cần `ANTHROPIC_API_KEY`.
- **AC-06**: Khởi động lại backend không mất dữ liệu task.

---

## 9. Rủi ro và lưu ý

| Rủi ro | Giảm thiểu |
|---|---|
| Vượt giới hạn sử dụng của gói Claude khi chạy nhiều task | Giới hạn song song, hiển thị thông báo lỗi rate limit, tự retry sau |
| Claude chạy lệnh nguy hiểm khi tự động | `--allowedTools` whitelist, mặc định `acceptEdits`, không bật bypass permissions |
| Merge conflict khi nhiều task sửa cùng file | Phát hiện conflict khi merge, chuyển task về Review kèm cảnh báo |
| Định dạng output CLI thay đổi theo phiên bản | Gom phần parse vào một module, ghi lại phiên bản `claude` đã test |
| Worktree tích tụ chiếm dung lượng | Tự dọn worktree khi task Done/Rejected |

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

---

## 11. Phê duyệt

- [ ] Chủ dự án đã đọc và đồng ý phạm vi
- [ ] Đã trả lời các câu hỏi ở Mục 10
- [ ] Đồng ý bắt đầu Giai đoạn P1
