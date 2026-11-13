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
| P2 | ✅ Đã hiện thực, **chờ điểm duyệt #2** | Worktree, diff, Approve/Request changes/Reject, Retry có unit test (`git`, `capture`, `diff`, `review`, `retry`) |
| P3 | ✅ Hoàn thành, **chờ điểm duyệt #3** | Xem “Kết quả kiểm thử P3” bên dưới. Phần cần Claude thật: chạy tay theo hướng dẫn |
| P5 | 🟡 Đang làm, **P5-08 bị chặn** | P5-01, 03, 04, 07 đạt. P5-02, 05 chưa làm; P5-06 mới có hàm thuần, runner chưa gọi. Xem “Kết quả kiểm thử P5” |
| P6 | ⏳ Đã lập kế hoạch, task ở Backlog | Budget theo project (P6-01..02) |
| P7 | ⏳ Đã lập kế hoạch, task ở Backlog | Cải tiến duyệt quyền (P7-01..05) |
| C-02 | ✅ Hoàn thành (làm trực tiếp), chờ deploy UAT | Phụ thuộc giữa task, SPEC FR-08 bản 1. Xem mục C-02 |

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

### Kết quả kiểm thử P3 (2026-11-12)

**Tự động** (`server/src/p3.acceptance.test.ts`, chạy trong `npm test -w server`). Một “Claude giả” spawn **đúng tiến trình MCP server** theo cấu hình `--mcp-config` mà runner sinh ra (cwd = repo, thư mục có dấu cách), gọi tool `approve` qua stdio; backend là Fastify + routes thật.

| Kịch bản PLAN P3 | Kết quả |
|---|---|
| MCP server có tool `approve`, khớp `--permission-prompt-tool mcp__taskboard__approve` | ✅ |
| (1a) `npm install` ngoài whitelist → **Needs Input**, broadcast WS; Allow trên web → Claude nhận `allow`, task về Running; bấm lần 2 → 409 | ✅ |
| (1b) Deny → Claude nhận `deny` kèm lý do tiếng Việt, task về Running, Claude xin quyền tiếp vẫn được phục vụ | ✅ |
| (2) Lệnh trong whitelist (`npm test`, `git status`, `Read`) → allow ngay, không tạo yêu cầu, không qua Needs Input; lệnh ghép có phần ngoài whitelist vẫn phải hỏi | ✅ |
| (3) Đóng/mở lại tab: tải lại `/api/state` vẫn thấy yêu cầu `pending` + mốc `timeoutAt`, task ở Needs Input; duyệt từ tab mới vẫn đến được Claude | ✅ |
| (4) Quá `permissionTimeoutMin` → tự Deny, Claude nhận “Hết thời gian…”, task về Running | ✅ |
| Bổ trợ (đã có): server khởi động lại khi đang chờ, task Stop/tiến trình kết thúc khi đang chờ, “Luôn cho phép”, sai token, mất kết nối backend | ✅ (`permissions.test.ts`, `mcp/permission.test.ts`) |
| Tổng `npm test -w server` / `npm run typecheck` | ✅ 195/195 · ✅ không lỗi |

**Chạy tay với Claude thật** (điểm duyệt #3):
1. `npm run dev`, mở `http://localhost:3000`. Project nháp ở Settings/Projects: mức quyền `manual`, allowedTools chỉ gồm `Read`, `Bash(git status:*)`. Settings → bật thông báo trình duyệt, bấm cho phép.
2. **Ngoài whitelist:** task “Chạy `npm init -y` rồi `npm install left-pad`”, Lưu & Chạy. Kỳ vọng: thẻ sang **Needs Input**, badge “Cần xử lý” tăng, tiêu đề tab có số, có thông báo trình duyệt (khi tab đang ẩn). Bấm **Allow** → log có “Đã cho phép: Bash(npm install…)”, task chạy tiếp, lên Review.
3. **Deny:** lặp lại bước 2 với task mới, bấm **Deny** → Claude nhận từ chối, log có “Đã từ chối…”, Claude tự giải thích/đổi cách và kết thúc (Review hoặc Done).
4. **Trong whitelist:** task “Chạy `git status` và tóm tắt” → chạy thẳng, log có “Tự động cho phép Bash(git status)”, không qua Needs Input.
5. **Đóng/mở lại tab:** khi task đang Needs Input, đóng tab rồi mở lại `http://localhost:3000` → thẻ yêu cầu vẫn còn, đếm ngược đúng; bấm Allow vẫn có hiệu lực.
6. **Timeout:** Settings → thời gian chờ duyệt = 1 phút; giao task ngoài whitelist và không bấm gì. Sau 1 phút yêu cầu tự đóng “Hết thời gian”, task chạy tiếp/kết thúc.
7. **Luôn cho phép:** bấm “Luôn cho phép” → quy tắc (ví dụ `Bash(npm install:*)`) xuất hiện trong allowedTools của project; lần sau không hỏi lại.

### Đối chiếu FR Must/Should (DoD P3)

| FR | Ưu tiên | Trạng thái | Căn cứ |
|---|---|---|---|
| FR-01 Tạo task (tiêu đề, prompt, project, ưu tiên, mức quyền) | Must | ✅ | `POST /api/tasks`, modal tạo task |
| FR-02 Sửa/xóa khi Backlog/Queued | Must | ✅ (lệch nhẹ) | `PATCH` chặn ngoài Backlog/Queued (409). `DELETE` rộng hơn PLAN 1.3: xóa được mọi task không đang chạy (để dọn Done/Failed). Cần bạn xác nhận giữ hay siết lại |
| FR-03 Đưa vào hàng đợi | Must | ✅ | `/queue`, runner theo ưu tiên + `max_parallel` |
| FR-04 Stop | Must | ✅ | `/stop`, `taskkill /T /F` (kiểm thử P1) |
| FR-05 Retry | Should | ✅ | `/retry`, `retry.test.ts` |
| FR-10 Kanban 7 cột | Must | ✅ | `Board.tsx` |
| FR-11 Realtime | Must | ✅ | WS `/ws`, mọi thay đổi broadcast qua bus |
| FR-12 Badge Needs Input + Review | Must | ✅ | `attentionCounts` (Layout), title tab |
| FR-20 Log realtime | Must | ✅ | `stream.ts` + WS `event` |
| FR-21 Tóm tắt kết quả | Must | ✅ | `runs.result_summary`, tab Kết quả |
| FR-22 Thời gian, turns, chi phí | Should | ✅ | từ `result` của stream-json |
| FR-23 Lịch sử runs | Should | ✅ | tab Lịch sử, `/api/runs/:id/events` |
| FR-30 Danh sách file + diff | Must | ✅ | `/api/tasks/:id/diff`, `diff.test.ts` |
| FR-31 Approve & Merge | Must | ✅ | `review.ts` (chặn repo bẩn/sai nhánh, conflict giữ Review) |
| FR-32 Request changes (`--resume`) | Must | ✅ | `review.ts`, run `kind=resume` |
| FR-33 Reject | Must | ✅ | xóa worktree + nhánh |
| FR-40 Needs Input khi xin quyền / hỏi lại | Must | ✅ (một phần “hỏi lại”) | Xin quyền: MCP prompt tool (kiểm thử trên). “Hỏi lại”: ở chế độ `-p` Claude không chờ trả lời được; câu hỏi nằm trong kết quả, bạn trả lời bằng Request changes. Hook `Notification` chỉ gửi thông báo |
| FR-41 Allow/Deny trên web | Should | ✅ | `POST /api/permissions/:id`, kiểm thử (1)(3) |
| FR-50 Web Notification (Review, Needs Input, Failed) | Should | ✅ (cần xác nhận tay) | `lib/notify.ts`, `notifyOn` trong Settings; chỉ kiểm được trên trình duyệt |
| FR-60 Nhiều project | Must | ✅ | `/api/projects`, validate git repo |
| FR-61 Cấu hình theo project | Should | ✅ | mức quyền, allowedTools, max parallel trên trang Projects |

**Chưa đạt:** không có FR Must/Should nào chưa đạt. Ba điểm cần bạn xác nhận khi duyệt: FR-02 (phạm vi xóa), FR-40 phần “hỏi lại” (giới hạn của chế độ headless, xử lý qua Request changes) và FR-50 (thông báo trình duyệt chỉ kiểm được bằng tay). Các FR Could (06, 07, 34, 42, 51) đã làm ở P4.

### Kết quả kiểm thử P5 (2026-11-12, P5-08)

**Kết luận: P5 chưa đủ điều kiện nghiệm thu.** P5-08 phụ thuộc P5-01..07, nhưng khi kiểm tra code thì P5-02, P5-05, P5-07 chưa làm và P5-06 mới có phần hàm thuần. Task P5-08 không sửa logic, nên chỉ kiểm thử phần đã có và ghi lại phần còn thiếu (xem “Vấn đề còn lại”).

**Tự động** (`server/src/p5.acceptance.test.ts`, chạy trong `npm test -w server`). Dùng routes + runner thật, DB trong bộ nhớ, repo git tạm có dấu cách. “Claude giả” là `node.exe` đặt qua `CLAUDE_BIN`: nhận đúng mảng tham số runner sinh ra rồi thoát mã 9, nên mỗi run là một run lỗi thật đi qua `finish()`.

| Kịch bản | Kết quả |
|---|---|
| Settings mặc định `auto` (D2) | ✅ |
| Task “Sửa typo trong README” → `--model haiku`; “Thêm nút Export CSV…” (tag feature) → `sonnet`; “Refactor runner.ts… race condition” (tag refactor) → `opus` + `--fallback-model sonnet`. Cả 3 run có `model_source = auto`, có lý do, log có “Tự chọn model: … — …”; `/api/model-suggest` trả cùng model | ✅ |
| Request changes lần 1 → run `resume` giữ `--resume <phiên cũ>` và `--model sonnet`, kể cả khi đã đổi mặc định project sang Opus (D3) | ✅ |
| Run lỗi → Retry nâng haiku → sonnet (D6 A) | ❌ (test để `todo`): run retry vẫn `haiku` |
| Request changes lần 2 → nâng sonnet → opus (D6 B) | ❌ (test để `todo`): run resume vẫn `sonnet` |
| Fixture thật `server/fixtures/model-haiku.jsonl` (`claude -p … --model haiku`, CLI 2.1.322) trong `stream.test.ts`: model `claude-haiku-5-5`, `modelUsage` chỉ có Haiku, `costUsd` khớp `total_cost_usd`, `contextTokens` = 41.747 | ✅ |
| Tổng `npm test -w server` / `npm run typecheck` | ✅ 300 đạt, 0 lỗi, 2 todo · ✅ không lỗi |

Khi P5-06 được nối vào runner, bỏ `todo` ở test (3)(4) để chúng thành bắt buộc.

**Đo chi phí khi đổi model lúc resume** (Claude thật, CLI 2.1.322, repo nháp trong thư mục tạm, prompt một từ). Số liệu lấy từ `usage` của request assistant. Chi phí là giá niêm yết (`costBasis: "list"`).

| Lần chạy | Model | `cache_creation_input_tokens` | `cache_read_input_tokens` | Chi phí của lần chạy |
|---|---|---|---|---|
| Phiên đầu | Haiku | 14.470 | 27.275 | $0,00330 |
| `--resume`, **cùng model** (Haiku) | Haiku | **331** | 41.772 | $0,00049 |
| `--resume --fork-session`, cùng model | Haiku | 11.488 | 30.575 | $0,00261 |
| `--resume --fork-session`, **đổi sang Sonnet** | Sonnet | **15.029** | 27.275 | $0,06292 |

- Đổi model khi resume: request đầu phải ghi lại cache cho phần hội thoại (15.029 so với 331 token khi resume cùng model, khoảng 45 lần). Kết quả này khớp với phân tích ở mục “Chi phí khi đổi model”.
- Khác với ước tính: khoảng 27k token đầu (system prompt chung của Claude Code) vẫn được **đọc từ cache** sau khi đổi model, vì cache của model mới đã có sẵn từ các phiên khác. Vậy phần phải ghi lại chỉ là phần riêng của phiên, không phải toàn bộ ngữ cảnh. Với ngữ cảnh lớn (≥ 80k, D6), phần riêng chiếm gần hết nên ước tính trong PLAN vẫn đúng hướng.
- Cache ghi ở đây là loại 1 giờ (`ephemeral_1h_input_tokens`).
- Phần chênh $0,0026 → $0,063 chủ yếu do giá Sonnet cao hơn Haiku. Phần do mất cache là chênh lệch về token ghi cache ở trên.

**Chưa kiểm tay trên giao diện:** badge model, lý do và bảng `modelUsage` trên web chưa có (P5-02, P5-05), nên chưa kiểm được. Cũng chưa chạy 3 task mẫu bằng Claude thật qua app. Phần chọn model đã được test tự động ở trên, và CLI nhận `--model haiku` đúng như fixture cho thấy.

**Vấn đề còn lại**
1. **P5-06 chưa nối vào runner.** `escalation.ts` (`decideEscalation`, `escalationPrompt`, `manualEscalationHint`) có test, nhưng `runner.startRun` không gọi. Ngoài ra chưa có cột `runs.fail_kind`, chưa có setting `autoEscalate` và công tắc trong Settings.tsx. Hậu quả: Retry/Request changes không bao giờ nâng model.
2. ~~**P5-07 chưa làm**~~ → đã làm (2026-11-12): `modelHistory.ts` (`computeModelStats`, `adjustSuggestion`, test ở `modelHistory.test.ts`), runner và `/api/model-suggest` áp Lớp 2 khi `auto` (cache 5 phút ở `modelHistoryService.ts`, xoá khi có review mới), `/api/stats` có `byTagModel`, Stats.tsx có bảng "Hiệu quả theo loại task × model".
3. **P5-02 chưa làm phần web:** TaskCard không có badge model; TaskDetail không có dòng Model và bảng `modelUsage`; `computeStats` không có `byModel`. Mới có `modelLabel`/`modelTier` trong `web/src/lib/format.ts`.
4. **P5-05 chưa làm:** TaskFormModal vẫn là select của P5-03 và không gọi `/api/model-suggest`. Template chưa có `model`. TaskCard chưa có biểu tượng nguồn. `mock.ts` chưa mock gợi ý.
5. **Lỗi mới (không nhỏ, chưa sửa): chi phí của run resume/continue bị cộng dồn.** Với `--resume`, CLI trả `total_cost_usd` và `modelUsage` **cộng dồn cả phiên**, không phải của riêng lần chạy. Đo được: phiên đầu $0,00330, sau đó resume Haiku báo `total_cost_usd` = $0,00639, trong khi chi phí thật của lần resume là $0,00049. Resume đổi sang Sonnet thì `modelUsage` vẫn chứa dòng Haiku của lần trước. Runner lưu thẳng các giá trị này vào `runs.cost_usd` / `runs.model_usage`, nên Stats (và `byModel` của P5-02, budget của P6) sẽ **tính trùng** chi phí của mọi task có Request changes / Tiếp tục. Cách sửa gợi ý: với run resume/continue trên cùng session, trừ giá trị cộng dồn của run trước cùng `session_id`, theo từng model. Cần quyết định trước khi làm P5-02 Stats và P6.
6. D1–D8 không cần đổi.

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

## P5: Tự chọn model và hiển thị model đang dùng (khoảng 4 ngày)

Nguồn: [Ideas Improvement.md](Ideas%20Improvement.md), ý 1 và 4. Task chi tiết: P5-01..P5-08 trong [backlog.json](backlog.json).

### Bối cảnh
- Hiện tại runner **không truyền `--model`**, nên mọi task chạy bằng model mặc định của CLI (thường là Opus). Event `system/init` có trường `model`, nhưng code chỉ in ra log dạng text, không lưu lại.
- Event `result` có `modelUsage`: token và `costUSD` tách theo từng model (kể cả Haiku mà Claude Code tự gọi nền). Code chưa lưu trường này.
- Người dùng thường **không tự chọn model**, nên mặc định phải là **Tự động**: hệ thống chọn, ghi lý do, và người dùng chỉ đổi khi muốn.

### Quyết định đã chốt (task không được tự đổi)
| # | Quyết định |
|---|---|
| D1 | Dùng alias `haiku` / `sonnet` / `opus` truyền vào `--model`. Không lưu ID đầy đủ làm cấu hình. ID thực tế lấy từ event `init` và lưu vào `runs.model`. Ngoài alias, chỉ chấp nhận ID khớp `^claude-[a-z0-9-]+$` (ID tự nhập thì không tự nâng model). |
| D2 | Cấu hình 3 tầng, chọn giá trị **không rỗng đầu tiên**: Task (`tasks.model`) → Project (`projects.default_model`) → Settings (`defaultModel`). Giá trị `'auto'` nghĩa là gọi bộ chọn model. Cả 3 tầng đều rỗng thì không truyền `--model`. Mặc định Settings là `'auto'`. |
| D3 | Model được chọn **lúc run bắt đầu**, không phải lúc tạo task. Run `resume` / `continue` **dùng lại model của run trước** để giữ prompt cache, trừ khi đang nâng model (D6). |
| D4 | Lớp 1 là chấm điểm theo quy tắc: hàm thuần, không gọi model, giải thích được. Bảng điểm cụ thể ở task P5-04. Ngưỡng: ≤ −2 → haiku, ≥ 3 → opus, còn lại → sonnet. |
| D5 | Lớp 2 là tự học từ lịch sử: chỉ điều chỉnh khi có ≥ 10 mẫu, và mỗi lần chỉ dịch **một bậc**. |
| D6 | Lớp 3 là tự nâng model khi thất bại: Retry sau run lỗi, hoặc Request changes lần thứ 2 trở đi, thì lên một bậc (haiku → sonnet → opus). Không nâng nếu model do người dùng chọn tay. Resume có ngữ cảnh ≥ 80k token thì mở **phiên mới kèm tóm tắt** thay vì `--resume`, vì cache gắn với từng model. |
| D7 | **Không** dùng LLM để phân loại prompt (Lớp 4) ở giai đoạn này. |
| D8 | Mỗi run lưu `model`, `model_source` (`auto` / `manual` / `default` / `escalated`), `model_reason`, và `model_usage` (JSON). |

### Chi phí khi đổi model (để kiểm chứng ở P5-08)
- Lớp 1, Lớp 2, gợi ý trực tiếp khi gõ, và hiển thị model đều không tốn thêm token.
- Prompt cache gắn với từng model. Đổi model khi resume thì request đầu tiên phải ghi lại cache (giá ×2 input) thay vì đọc cache (giá ×0,1). Ví dụ 100k token chuyển từ Sonnet lên Opus tốn khoảng $0,80 thay vì khoảng $0,02. D6 giảm khoản này bằng cách mở phiên mới khi ngữ cảnh lớn.
- Chi phí chính là khi **đoán sai**: lần chạy rẻ bị hỏng thì tiền của lần đó mất. Lớp 2 giảm khoản này theo thời gian.
- Với gói subscription, `total_cost_usd` là chi phí quy đổi theo giá niêm yết (`costBasis: "list"`), không phải tiền thật bị trừ.

### Task
| Mã | Nội dung | Phụ thuộc |
|---|---|---|
| P5-01 | Lưu model thực tế và `model_usage` của từng run | — |
| P5-02 | Web: hiển thị model (TaskCard, TaskDetail, Stats theo model) | P5-01 |
| P5-03 | Cấu hình model 3 tầng và truyền `--model` | P5-01 |
| P5-04 | `modelPicker.ts`: Lớp 1, `'auto'`, API `/api/model-suggest` | P5-03 |
| P5-05 | Web: chế độ "🤖 Tự động", gợi ý trực tiếp khi gõ, model trong template | P5-02, P5-04 |
| P5-06 | Lớp 3: tự nâng model khi thất bại | P5-04 |
| P5-07 | Lớp 2: tự học từ lịch sử, bảng tag × model ở trang Stats | P5-06 |
| P5-08 | Kiểm thử P5 (Claude thật), cập nhật PLAN | P5-01..07 |

## P6: Budget theo project (khoảng 1,5 ngày)

Nguồn: Ideas Improvement, ý 3. Hiện có `runs.cost_usd`, và [stats.ts](../server/src/stats.ts) đã cộng chi phí theo project, nhưng chưa có hạn mức.

| # | Quyết định |
|---|---|
| B1 | Mỗi project có `monthly_budget_usd` (để trống là không giới hạn) và `budget_action` (`warn` hoặc `pause`, mặc định `warn`). Tháng tính theo giờ địa phương của server. |
| B2 | Đạt 80% thì cảnh báo; đạt 100% thì cảnh báo lần nữa. Mỗi mức chỉ báo **một lần mỗi tháng**, qua toast web và Telegram (nếu đang bật). |
| B3 | `pause` và đã ≥ 100%: `pump()` không chạy task **mới** của project đó (task vẫn ở Queued, ghi rõ lý do). Task đang chạy thì để chạy xong. Sang tháng mới thì tự chạy lại. |
| B4 | Khi project đã ≥ 80% budget, Lớp 3 (P5-06) không nâng model quá `sonnet`. |
| B5 | Mọi số tiền hiển thị kèm chữ "ước tính", vì đây là giá niêm yết. |

| Mã | Nội dung | Phụ thuộc |
|---|---|---|
| P6-01 | Backend: budget, cảnh báo, tạm dừng hàng đợi | — (nối với P5-06 nếu đã có) |
| P6-02 | Web: thanh budget, form project, dự báo cuối tháng | P6-01 |

## P7: Cải tiến duyệt quyền (khoảng 2,5 ngày)

Nguồn: Ideas Improvement, ý 2. Cơ chế duyệt **đã chạy** từ P3 (MCP `--permission-prompt-tool`, Needs Input, allowlist, "Luôn cho phép", timeout). P7 nhằm giảm số lần phải duyệt và giúp duyệt nhanh hơn.

| Mã | Nội dung | Phụ thuộc |
|---|---|---|
| P7-01 | Preset allowlist (Node, Python, git chỉ đọc, chỉ đọc file) | — |
| P7-02 | Gợi ý rule từ lịch sử duyệt | — |
| P7-03 | Duyệt quyền qua Telegram (nút inline, long polling) | — |
| P7-04 | Phân loại rủi ro: lệnh nguy hiểm tô đỏ, không cho "Luôn cho phép" | — |
| P7-05 | Từ chối kèm lý do, duyệt hàng loạt ở Inbox | P7-04 |

## C-02: Phụ thuộc giữa task (SPEC FR-08, bản 1)

Vấn đề: hàng đợi chỉ sắp theo ưu tiên và thời gian tạo, nên task chạy trước khi task nó cần đã xong (ví dụ P6-02 chạy trước P6-01, P5-08 chạy khi P5-06 mới làm được một nửa). Task này được **làm trực tiếp, không giao cho board**, vì chính nó là điều kiện để hàng đợi chạy đúng.

| # | Quyết định |
|---|---|
| R1 | Bảng `task_deps(task_id, depends_on_id)`, chỉ cho phụ thuộc trong cùng project. Task trả ra API có thêm `dependsOn: number[]`. |
| R2 | Phụ thuộc được thoả khi task được chờ ở trạng thái **Done** (đã merge). Review là chưa đủ: code còn trên nhánh riêng, worktree tạo từ main không thấy. |
| R3 | `pump()` bỏ qua task còn phụ thuộc chưa thoả. Task không chờ ai chạy song song theo `maxParallel`. Approve (Done) thì gọi `pump()`. |
| R4 | Cột Queued sắp task đang chờ **sau** task nó chờ (sắp topo, cùng mức thì theo ưu tiên → thời gian tạo). Thẻ task có nhãn "⛓ Chờ #id"; task được chờ đang Failed thì nhãn đỏ. Một task được chờ bị Failed/Reject thì hiện toast. |
| R5 | Nguồn ① seed-backlog.mjs đổi `dependsOn` (mã task) thành id; ② ô "Chờ task" trong form; ③ `POST /api/tasks/dep-suggest`: tìm `#id` và mã `[A-Z]+\d*-\d+[a-z]?` khớp `[MÃ]` ở đầu tiêu đề → gợi ý, người dùng bấm thêm. |
| R6 | ④ Mỗi run gửi quy ước qua `--append-system-prompt`: nếu không làm được vì thiếu phần việc của task khác thì dừng, kết thúc bằng dòng `BLOCKED_BY: <#id hoặc mã>; <lý do>`. Run thành công có dòng này: tìm task tương ứng (cùng project, chưa Done, không tạo vòng tròn) → thêm phụ thuộc, đưa worktree về main (giống Retry), task về **Queued**, ghi log. Không tìm được task hợp lệ hoặc task đó đã Done → task **Failed** kèm lý do (tránh lặp vô hạn). |
| R7 | Lưu phụ thuộc thì kiểm tra vòng tròn (lỗi 400). Xoá task thì liên kết tự mất (CASCADE). Sửa phụ thuộc được khi task ở Backlog/Queued (như FR-02). |
| R8 | "Chạy ngay" khi còn chờ: API trả 409 `{ code: 'DEPS_PENDING' }`, web hỏi xác nhận. Đồng ý thì gọi lại với `ignoreDeps: true`: **gỡ toàn bộ phụ thuộc** của task rồi chạy. Nếu chỉ bỏ qua một lần mà task lại vào hàng đợi vì hết slot, nó sẽ lại bị giữ. |

### Kết quả (2026-11-13)
- Code:
  - [web/src/lib/deps.ts](../web/src/lib/deps.ts): hàm thuần dùng chung.
  - [server/src/taskDeps.ts](../server/src/taskDeps.ts): kiểm tra hợp lệ, gợi ý, `decideBlocked`.
  - Bảng `task_deps`.
  - `pump()` bỏ qua task còn chờ; `handleBlocked` trong runner.ts.
  - API `dependsOn`, `/api/tasks/dep-suggest`, `ignoreDeps`; Approve thì gọi `pump()`.
  - seed-backlog.mjs đặt phụ thuộc theo mã task.
  - Giao diện: ô "Chờ task" và gợi ý trong form, nhãn ⛓ trên thẻ, khối phụ thuộc ở trang chi tiết, cột Queued sắp theo phụ thuộc, hộp xác nhận Chạy ngay, toast khi task được chờ bị lỗi.
- Test: `deps.test.ts` và `taskDeps.test.ts` có 18 test mới. Toàn bộ `npm test -w server` đạt **400/400**; `npm run typecheck` và `npm run build` đạt.
- Kiểm chứng với CLI thật (Haiku): `--append-system-prompt` có tiếng Việt chạy được trên Windows. Với tình huống P5-08 chờ P5-06, Claude dừng và trả `BLOCKED_BY: P5-06; …`, parser đọc đúng.
- Chưa làm (bản 2, FR-09): gợi ý khi Approve bị conflict, cảnh báo trùng file.
- Lưu ý: UAT đang chạy `e00807f` (đã có worktree, chưa có phụ thuộc). Cần commit C-02 rồi `npm run uat:deploy` thì tính năng này mới có hiệu lực trên UAT.

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
| Chung | Vượt giới hạn sử dụng của gói | `max_parallel=2`, nhận diện lỗi rate limit (429, `rate_limit_event` rejected, thông điệp usage limit), tự đưa task lại vào Queued với `not_before` (giờ reset + 1 phút, mặc định chờ 15 phút), tối đa 3 lần rồi mới Failed (C-01, `server/src/rateLimit.ts`) |

---

## Phê duyệt kế hoạch

- [ ] Đồng ý các giả định (SPEC Mục 10, dùng mặc định)
- [ ] Đồng ý thứ tự và phạm vi PT, P0–P3
- [ ] Chọn hạng mục P4 muốn làm: ____
- [ ] Cho phép bắt đầu **PT (Prototype)**
