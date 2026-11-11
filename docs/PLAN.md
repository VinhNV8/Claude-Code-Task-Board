# KẾ HOẠCH TRIỂN KHAI: Claude Task Board

| Mục | Giá trị |
|---|---|
| Phiên bản | 0.2 (Đã duyệt, đang triển khai) |
| Ngày | 2026-11-11 |
| Căn cứ | [SPEC.md](SPEC.md) v0.2, Mục 7 (Lộ trình) |
| Giả định | Áp dụng **đề xuất mặc định** ở SPEC Mục 10: nhiều project, Node/React, chạy local, tối đa 2 task song song, không dùng Telegram ở v1. Nếu bạn đổi câu trả lời nào, kế hoạch sẽ được cập nhật lại. |

## Tiến độ

| Giai đoạn | Trạng thái | Ghi chú |
|---|---|---|
| PT | ✅ Hoàn thành, đã duyệt | `npm run dev:mock` để xem lại |
| P0 | ✅ Hoàn thành | Spike S1–S8 đều đạt, xem [P0-SPIKE.md](P0-SPIKE.md). SQLite dùng `node:sqlite` thay `better-sqlite3` (không cần build native) |
| P1 | ✅ Hoàn thành, **chờ điểm duyệt #1** | Xem “Kết quả kiểm thử P1” bên dưới |
| P2 | ⏳ Chưa bắt đầu | |
| P3 | ⏳ Chưa bắt đầu | Rủi ro chính đã được gỡ ở spike S8 |

### Kết quả kiểm thử P1 (qua API, Claude chạy thật)
| Kịch bản | Kết quả |
|---|---|
| Unit test parser stream-json (5 test, dùng fixtures thật) | ✅ 5/5 |
| Validate: repo không phải git, task thiếu tiêu đề | ✅ Trả lỗi 400 kèm thông báo tiếng Việt |
| Giao task “tạo hello.txt” → queued → running → done | ✅ 9 giây, file được tạo đúng nội dung; log + WS đầy đủ |
| Dừng task đang chạy | ✅ Failed “Đã dừng bởi người dùng”, không còn tiến trình `claude.exe` mồ côi |
| Giới hạn song song theo project (=1), ưu tiên | ✅ Task thứ 2 chờ, chỉ chạy khi task 1 xong |
| Khởi động lại server khi task đang chạy (NFR-05) | ✅ Task → Failed kèm lý do, run được đóng, không có tiến trình mồ côi |
| Giao diện (bấm tay trên trình duyệt) | ⏳ Bạn kiểm tra ở điểm duyệt #1 |

---

## Tổng quan

| Giai đoạn | Mục tiêu | Thời lượng | Kết quả bàn giao | Đáp ứng |
|---|---|---|---|---|
| **PT** | **Prototype giao diện để duyệt UI/UX** | 1.5 ngày (+ vòng chỉnh sửa) | Prototype bấm được, dữ liệu giả, đủ mọi màn hình và trạng thái | SPEC Mục 6 · toàn bộ FR liên quan UI |
| **P0** | Kiểm tra kỹ thuật và dựng khung dự án | 0.5 ngày | Repo chạy được `npm run dev`, xác nhận các flag CLI | Nền tảng |
| **P1** | MVP: giao task, chạy, xem log | 1.5 ngày | Kanban + log realtime | FR-01..04, 10..12, 20..22, 60 · AC-01, 05, 06 |
| **P2** | Review flow | 2 ngày | Worktree, diff, Approve/Request changes/Reject | FR-05, 23, 30..33 · AC-02, 03, 04 |
| **P3** | Needs Input và thông báo | 1.5 ngày | Duyệt quyền trên web, thông báo trình duyệt | FR-40..42, 50, 61 |
| **P4** | Nâng cao (tùy chọn) | Tùy chọn | Template, tag, thống kê, test runner, Telegram | FR-06, 07, 34, 51 |

**Tổng cho PT + P0–P3: khoảng 7 ngày làm việc**, chưa tính thời gian bạn duyệt và các vòng chỉnh sửa prototype. Hết mỗi giai đoạn có một **điểm duyệt**: bạn chạy thử và xác nhận trước khi sang giai đoạn sau.

> **Nguyên tắc:** giao diện phải được duyệt ở PT trước. P1–P3 chỉ nối backend thật vào giao diện đã duyệt, không thiết kế lại.

---

## PT: Prototype giao diện (1.5 ngày + vòng chỉnh sửa)

### Mục tiêu
- Cho bạn **bấm thử toàn bộ luồng sử dụng** trước khi viết backend.
- Chốt bố cục, thông tin hiển thị và thao tác trên từng màn hình.
- Phát hiện sớm yêu cầu bị thiếu hoặc thừa, rồi cập nhật SPEC.

### Cách làm
- Viết bằng **React + Vite + Tailwind**, đúng stack của sản phẩm thật, nên giao diện đã duyệt được **dùng lại nguyên vẹn** ở P1.
- **Không có backend, không chạy Claude.** Toàn bộ dữ liệu là dữ liệu giả (mock) nằm trong `web/src/mocks/`.
- **Giả lập realtime**: log tự chạy từng dòng, task tự chuyển trạng thái, để bạn cảm nhận được trải nghiệm thật.
- Có **bảng điều khiển demo** (nút ẩn ở góc màn hình) để chuyển nhanh giữa các kịch bản: dữ liệu trống, nhiều task, lỗi, conflict.
- Chạy bằng `npm run dev`, mở `http://localhost:3000`.

### Danh sách màn hình và trạng thái cần có

| # | Màn hình / thành phần | Trạng thái phải thể hiện | FR liên quan |
|---|---|---|---|
| PT-01 | Layout chung: sidebar, header, badge "Cần xử lý" | Có hoặc không có việc cần xử lý | FR-12 |
| PT-02 | **Kanban board** | 7 cột; dữ liệu trống; nhiều task; lọc theo project; thẻ đang chạy có hiệu ứng | FR-10, 11 |
| PT-03 | **Modal tạo task** | Form trống, lỗi validate, chọn template, "Lưu vào Backlog" / "Lưu & Chạy" | FR-01, 03, 06 |
| PT-04 | Sửa / xóa task | Chỉ cho phép ở Backlog/Queued; hộp xác nhận xóa | FR-02 |
| PT-05 | **Chi tiết task, tab Log** | Log chạy realtime (giả lập): tin nhắn Claude, tool call mở rộng/thu gọn, lỗi; nút Stop | FR-04, 20 |
| PT-06 | Tab Kết quả | Summary, cost, turns, thời gian | FR-21, 22 |
| PT-07 | **Tab Diff / Review** | Danh sách file, diff unified/side-by-side; 3 nút Approve & Merge / Request changes / Reject; ô nhập feedback; cảnh báo conflict; cảnh báo repo chính chưa sạch | FR-30..33 |
| PT-08 | Tab Lịch sử runs | Nhiều run (initial / resume / retry) kèm feedback | FR-23 |
| PT-09 | **Needs Input** | Thẻ yêu cầu quyền: tool + lệnh; Allow / Deny / Luôn cho phép; đếm ngược timeout | FR-40..42 |
| PT-10 | Task Failed | Lý do lỗi, nút Retry | FR-05 |
| PT-11 | Trang Projects | Danh sách; thêm/sửa; lỗi "không phải git repo" | FR-60 |
| PT-12 | Settings | Cấu hình project (allowed tools, permission mode, max parallel), thông báo | FR-61, 50 |
| PT-13 | Thông báo | Toast trong app + mô phỏng thông báo trình duyệt | FR-50 |
| PT-14 | Giao diện sáng/tối, độ rộng màn hình | Desktop (chính); tablet/điện thoại ở mức xem được | — |

### Các luồng sử dụng (user flow) để bạn duyệt
1. **Giao task mới**: tạo task, Lưu & Chạy, xem log chạy, task lên Review.
2. **Review đạt**: mở Review, xem diff, Approve & Merge, task về Done.
3. **Review chưa đạt**: Request changes, nhập feedback, task chạy lại, quay lại Review với diff mới.
4. **Claude xin quyền**: thông báo, mở Needs Input, Allow, task chạy tiếp.
5. **Task lỗi**: task về Failed, xem lý do, Retry.
6. **Thêm project mới**: Projects, thêm repo, cấu hình quyền.

### Quy trình duyệt
| Bước | Nội dung |
|---|---|
| 1 | Tôi bàn giao prototype, kèm hướng dẫn chạy và danh sách 6 luồng ở trên |
| 2 | Bạn bấm thử, ghi góp ý theo mã màn hình (ví dụ: "PT-07: muốn diff hiện ngay khi mở task") |
| 3 | Tôi chỉnh sửa. Dự kiến **tối đa 2 vòng**, mỗi vòng khoảng 0.5 ngày |
| 4 | Góp ý làm thay đổi yêu cầu thì cập nhật **SPEC.md** |
| 5 | Bạn ký duyệt giao diện, rồi chuyển sang P0 |

**DoD PT (điểm duyệt #0):** đủ 14 hạng mục PT-01..PT-14; 6 luồng bấm được từ đầu đến cuối; bạn xác nhận giao diện; SPEC được cập nhật theo góp ý.

---

## P0: Kiểm tra kỹ thuật và dựng khung (0.5 ngày)

### P0.1 Spike: xác nhận hành vi của Claude Code CLI trên máy
Mục đích là kiểm chứng các giả định trong SPEC trước khi viết code thật.

| # | Kiểm tra | Lệnh / cách làm | Kỳ vọng |
|---|---|---|---|
| S1 | Phiên bản và các flag | `claude --version`, `claude --help` | Có `-p`, `--output-format stream-json`, `--verbose`, `--resume`, `--session-id`, `--permission-mode`, `--allowedTools`, `--settings`, `--mcp-config`, `--permission-prompt-tool` |
| S2 | Chạy headless không cần API key | `claude -p "say hi" --output-format stream-json --verbose` trong một shell **không có** `ANTHROPIC_API_KEY` | Có các dòng JSON: `system/init`, `assistant`, `result` |
| S3 | Gán session id trước | `--session-id <uuid>`, sau đó `--resume <uuid>` | Phiên sau nhớ ngữ cảnh phiên trước |
| S4 | Gọi từ Node trên Windows | `spawn('claude', args, {shell:true})` hoặc resolve `claude.cmd` | Đọc được stdout theo từng dòng, path có dấu cách vẫn chạy đúng |
| S5 | Dừng tiến trình | `taskkill /PID <pid> /T /F` | Tiến trình con của Claude cũng bị dừng |
| S6 | Ghi nhận schema của `result` | Lưu mẫu output vào `server/fixtures/` | Có `session_id`, `is_error`, `num_turns`, `total_cost_usd`, `result` |

➡️ Nếu S1–S6 có điểm khác giả định, cập nhật SPEC trước khi đi tiếp.

### P0.2 Dựng khung dự án
```
AI-Interface/
├── package.json            # npm workspaces: server, web; scripts dev/start
├── tsconfig.base.json
├── server/                 # Fastify + TypeScript (chạy bằng tsx)
│   ├── src/index.ts
│   └── fixtures/           # mẫu stream-json từ spike
├── web/                    # Vite + React + TS + Tailwind
└── data/                   # taskboard.db, worktrees/ (gitignore)
```
- `npm run dev`: dùng `concurrently` chạy server (port 3001) và Vite (port 3000, proxy `/api` và `/ws` sang server).
- `npm start`: build web, server phục vụ static, chỉ một port 3000.
- `git init` cho chính dự án AI-Interface, kèm `.gitignore` (`node_modules`, `data/`).

**DoD P0:** `npm run dev` mở được trang trống, `GET /api/health` trả `ok`, có báo cáo kết quả spike.

---

## P1: MVP (1.5 ngày)

### Backend
| # | Hạng mục | File | Chi tiết |
|---|---|---|---|
| 1.1 | DB schema + migration | `server/src/db.ts` | Bảng `projects`, `tasks`, `runs`, `events` theo SPEC 5.2. Bật WAL mode |
| 1.2 | API Projects | `server/src/routes/projects.ts` | CRUD. Validate `repo_path` tồn tại và là git repo (`git rev-parse`) |
| 1.3 | API Tasks | `server/src/routes/tasks.ts` | CRUD, `queue`, `stop`. Chỉ sửa/xóa được khi task ở Backlog hoặc Queued |
| 1.4 | Runner + hàng đợi | `server/src/runner.ts` | Vòng lặp lấy task Queued theo ưu tiên rồi `created_at`; giới hạn `max_parallel` (toàn cục = 2); spawn `claude -p <prompt> --output-format stream-json --verbose --session-id <uuid> --permission-mode acceptEdits` với `cwd = repo_path` (P1 chưa có worktree) |
| 1.5 | Parser stream-json | `server/src/stream.ts` | Tách theo dòng, `JSON.parse`, ghi vào `events`, phát qua WS. Gặp `result` thì cập nhật `runs` (cost, turns, summary) |
| 1.6 | Kết thúc run | `runner.ts` | exit 0 và `is_error=false` thì **Done**; ngược lại **Failed** (lưu stderr) |
| 1.7 | WebSocket hub | `server/src/ws.ts` | Kênh `task:update` và `run:event`. Client subscribe theo taskId |
| 1.8 | Phục hồi khi khởi động | `server/src/index.ts` | Task đang Running (do lần trước bị tắt) chuyển sang **Failed** với lý do "server restarted" (NFR-05) |
| 1.9 | Bảo mật cơ bản | `index.ts` | Chỉ bind `127.0.0.1` (NFR-04) |

### Frontend
| # | Hạng mục | Chi tiết |
|---|---|---|
| 1.10 | Layout + router | Sidebar (Board, Projects, Settings), header có badge "Cần xử lý" |
| 1.11 | Trang Projects | Thêm/sửa project: tên, đường dẫn repo, nhánh chính |
| 1.12 | Kanban board | 7 cột theo SPEC 3.2; thẻ task hiển thị tiêu đề, project, thời gian chạy; lọc theo project; cập nhật qua WS |
| 1.13 | Modal tạo task | Tiêu đề, prompt, project, ưu tiên; hai nút "Lưu vào Backlog" và "Lưu & Chạy" |
| 1.14 | Chi tiết task, tab Log | Hiển thị event dạng timeline: tin nhắn Claude (markdown), tool call (tên tool + input rút gọn, có thể mở rộng), tool result; tự cuộn; nút Stop |
| 1.15 | Tab Kết quả | Summary, cost, turns, thời gian |

### Kiểm thử
- Unit: parser stream-json chạy với fixtures từ spike.
- Thủ công: tạo task "Tạo file hello.txt có nội dung Hello", xem log realtime, task về Done, file được tạo.
- Thủ công: Stop giữa chừng thì task về Failed; tắt server khi đang chạy, bật lại thì task về Failed.

**DoD P1 (điểm duyệt #1):** đạt AC-01, AC-05, AC-06. Bạn tự giao 2–3 task thật mà không mở VSCode.

> ⚠️ Lưu ý P1: chưa có worktree, nên Claude sửa trực tiếp trên repo. Khuyến nghị chỉ thử trên repo nháp ở giai đoạn này.

---

## P2: Review flow (2 ngày)

### Backend
| # | Hạng mục | File | Chi tiết |
|---|---|---|---|
| 2.1 | Quản lý worktree | `server/src/git.ts` | Trước khi chạy: `git worktree add -b claude/task-<id> data/worktrees/<project>/<id> <main_branch>`. Runner dùng `cwd = worktree_path` |
| 2.2 | Kết thúc run, chụp thay đổi | `runner.ts` | Sau khi exit: `git add -A && git commit -m "task #<id>: <title> (run n)"` trong worktree. Có thay đổi thì **Review**, không có thì **Done** |
| 2.3 | API Diff | `GET /api/tasks/:id/diff` | `git diff <main>...claude/task-<id>`, trả danh sách file + patch (unified) |
| 2.4 | Approve & Merge | `POST /review {action:approve}` | Kiểm tra repo chính: đang ở `main_branch` và sạch (`git status --porcelain`). Sau đó `git merge --no-ff claude/task-<id>`. Thành công thì **Done**, xóa worktree + nhánh. Conflict thì `git merge --abort`, task giữ ở **Review** kèm cảnh báo |
| 2.5 | Request changes | `{action:request_changes, feedback}` | Tạo run mới `kind=resume`: `claude -p "<feedback>" --resume <session_id>` trong cùng worktree, task về **Running** |
| 2.6 | Reject | `{action:reject}` | Xóa worktree (`git worktree remove --force`) + `git branch -D`, task chuyển **Failed** (reason: rejected) |
| 2.7 | Retry | `POST /retry` | Task Failed thì reset worktree về `main`, quay lại **Queued**, run mới `kind=retry` |
| 2.8 | Bảng reviews | `db.ts` | Lưu lịch sử action + feedback |

### Frontend
| # | Hạng mục | Chi tiết |
|---|---|---|
| 2.9 | Tab Diff | Danh sách file bên trái, diff (`diff2html`) bên phải, chuyển unified/side-by-side |
| 2.10 | Thanh hành động Review | 3 nút **Approve & Merge / Request changes / Reject**. Request changes mở ô nhập feedback. Reject có hộp xác nhận |
| 2.11 | Tab Lịch sử | Danh sách runs (initial/resume/retry) kèm feedback tương ứng; xem lại log của từng run |
| 2.12 | Badge cột Review | Đếm task chờ review, đánh dấu nổi bật |

### Kiểm thử
- 2 task song song cùng repo, sửa 2 file khác nhau: cả hai lên Review với diff độc lập, merge lần lượt thành công (AC-04).
- 2 task cùng sửa một dòng: task merge sau báo conflict và vẫn ở Review.
- Request changes: Claude nhớ ngữ cảnh, commit mới xuất hiện trong diff (AC-03).
- Repo chính đang có thay đổi chưa commit: Approve bị chặn và có thông báo rõ ràng.

**DoD P2 (điểm duyệt #2):** đạt AC-02, AC-03, AC-04.

---

## P3: Needs Input và thông báo (1.5 ngày)

### Thiết kế
Ở chế độ `-p`, Claude không thể hỏi quyền tương tác. Giải pháp là dùng `--permission-prompt-tool` trỏ tới một **MCP server do backend cung cấp**. Tool này **chặn chờ** đến khi bạn bấm Allow hoặc Deny trên web.

```
Claude ──(cần quyền Bash "npm install")──► MCP tool taskboard.approve
        ──► Backend: task chuyển Needs Input, đẩy WS + thông báo
Bạn bấm Allow trên web ──► Backend trả {behavior:"allow"} ──► Claude chạy tiếp
```

### Backend
| # | Hạng mục | File | Chi tiết |
|---|---|---|---|
| 3.1 | MCP permission server | `server/src/mcp/permission.ts` | Server stdio nhỏ (`@modelcontextprotocol/sdk`), tool `approve(tool_name, input)`, gọi HTTP long-poll về backend để lấy quyết định |
| 3.2 | Truyền cấu hình khi spawn | `runner.ts` | `--mcp-config <file tạm>` + `--permission-prompt-tool mcp__taskboard__approve`; env `TASKBOARD_TASK_ID` |
| 3.3 | Pending requests | `db.ts` + `routes/input.ts` | Bảng `permission_requests(id, task_id, tool, input_json, status, decided_at)`; `POST /api/tasks/:id/input {requestId, decision}` |
| 3.4 | Quy tắc tự cho phép | `projects.allowed_tools` | Khớp whitelist thì tự trả allow, không làm phiền (FR-42, FR-61). Tùy chọn "Luôn cho phép" sẽ thêm quy tắc vào project |
| 3.5 | Timeout | Cấu hình được | Chờ quá N phút (mặc định 30) thì tự Deny, task tiếp tục hoặc kết thúc |
| 3.6 | Hooks (bổ sung) | `--settings <file tạm>` | Hook `Notification` gửi về `/hooks/notification` để ghi log và thông báo |

### Frontend
| # | Hạng mục | Chi tiết |
|---|---|---|
| 3.7 | Thẻ Needs Input | Hiện tool + input (ví dụ lệnh bash cần chạy). Các nút **Allow / Deny / Luôn cho phép** |
| 3.8 | Settings project | Sửa `allowed_tools`, `permission_mode`, `max_parallel` |
| 3.9 | Web Notification | Xin quyền một lần; báo khi task chuyển Review, Needs Input hoặc Failed; title tab nhấp nháy số việc cần xử lý |

### Kiểm thử
- Task yêu cầu `npm install` (không nằm trong whitelist) thì chuyển Needs Input; Allow thì chạy tiếp; Deny thì Claude nhận từ chối và xử lý tiếp.
- Lệnh trong whitelist chạy ngay, không hỏi.
- Đóng tab trình duyệt rồi mở lại vẫn thấy yêu cầu đang chờ.

**DoD P3 (điểm duyệt #3):** toàn bộ FR "Must" và "Should" trong SPEC đã đạt.

> 🔎 Rủi ro P3: cơ chế `--permission-prompt-tool` cần kiểm chứng kỹ ở spike S1. Phương án dự phòng: chạy `acceptEdits` + whitelist chặt; lệnh ngoài whitelist bị từ chối, Claude ghi lý do vào kết quả, task lên Review để bạn quyết định chạy lại với quyền rộng hơn.

---

## P4: Nâng cao (tùy chọn, làm theo thứ tự ưu tiên của bạn)

| # | Hạng mục | FR | Ước lượng |
|---|---|---|---|
| 4.1 | Template prompt | FR-06 | 0.5 ngày |
| 4.2 | Tag, tìm kiếm, lọc nâng cao | FR-07 | 0.5 ngày |
| 4.3 | Chạy test trên trang Review | FR-34 | 0.5 ngày |
| 4.4 | Thống kê (số task, chi phí, thời gian theo ngày/project) | — | 1 ngày |
| 4.5 | Thông báo Telegram | FR-51 | 0.5 ngày |
| 4.6 | Lên lịch task (cron) | — | 1 ngày |
| 4.7 | Truy cập từ xa (Tailscale + token đăng nhập) | NFR-04 | 0.5 ngày |

---

## Quy trình làm việc

- **Nhánh git**: mỗi giai đoạn một nhánh `phase/p1-mvp`, ...; merge sau khi bạn duyệt.
- **Điểm duyệt**: hết mỗi giai đoạn tôi gửi danh sách việc đã làm, cách chạy thử và kết quả test; bạn xác nhận rồi mới sang giai đoạn tiếp.
- **Thay đổi yêu cầu**: cập nhật SPEC.md trước, sau đó mới sửa code.

## Rủi ro theo giai đoạn

| Giai đoạn | Rủi ro | Xử lý |
|---|---|---|
| P0 | Flag CLI khác giả định | Spike trước, cập nhật SPEC |
| P1 | Spawn `claude` trên Windows lỗi path/quote | Truyền prompt qua stdin thay vì argument nếu cần |
| P2 | Merge khi repo chính đang bẩn hoặc sai nhánh | Kiểm tra trước khi merge, chặn và báo rõ |
| P3 | Permission prompt tool không ổn định | Phương án dự phòng whitelist (xem trên) |
| Chung | Vượt giới hạn sử dụng của gói | `max_parallel=2`, nhận diện lỗi rate limit, tự đưa task lại vào Queued sau một khoảng chờ |

---

## Phê duyệt kế hoạch

- [ ] Đồng ý các giả định (SPEC Mục 10, dùng mặc định)
- [ ] Đồng ý thứ tự và phạm vi PT, P0–P3
- [ ] Chọn hạng mục P4 muốn làm: ____
- [ ] Cho phép bắt đầu **PT (Prototype)**
