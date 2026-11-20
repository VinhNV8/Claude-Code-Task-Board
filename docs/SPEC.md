# SPEC: Claude Task Board

| Mục | Giá trị |
|---|---|
| Phiên bản | 0.6 |
| Ngày | 2026-11-19 |
| Trạng thái | ✅ Đã duyệt đến v0.5 (2026-11-18), gồm phần mới của v0.3/v0.3.1 (FR-08/09, FR-43..47, FR-70..76, FR-80..83) và v0.5 (FR-01a/01b) |
| Thay đổi 0.2 | Cập nhật theo [P0-SPIKE.md](P0-SPIKE.md): dò file `claude.exe` của extension VSCode; mode `default` đổi thành `manual`; prompt truyền qua stdin; P3 dùng `--permission-prompt-tool` (đã kiểm chứng); SQLite dùng `node:sqlite` có sẵn trong Node 24 |
| Thay đổi 0.3 | **FR-08/09 Phụ thuộc giữa task.** Bổ sung yêu cầu từ [Ideas Improvement.md](Ideas%20Improvement.md): **3.8 Chọn model** (tự chọn theo độ khó, hiển thị model đang dùng), **3.9 Chi phí và budget theo project**, cải tiến **3.5 Needs Input** (preset, gợi ý rule, Telegram, rủi ro, lý do từ chối). Cập nhật 5.2, 5.3, 7, 8, 9, 10. Thiết kế chi tiết ở PLAN mục P5–P7 |
| Thay đổi 0.3.1 | **FR-47 Mức quyền Auto** (2026-11-13): thêm mode `auto` cho project/task, tự duyệt thao tác qua kiểm tra an toàn, chỉ dừng chờ người với lệnh rủi ro cao. Cập nhật FR-61, 5.2, 6, 8 (AC-12), 9 |
| Thay đổi 0.4 | Chốt 2026-11-18: **FR-62 Cách giao output**, mặc định *Ghi thẳng vào thư mục project* (không cần git, mỗi lúc 1 task), tuỳ chọn *Nhánh git riêng* (worktree, chạy song song). **Review = chấp nhận output, merge là thao tác tuỳ chọn** (FR-31, FR-31a). **Reject không xoá output** (FR-33). **C1 làm rõ**: Task Board không tự gọi Anthropic API; chế độ API key tuỳ chọn chỉ truyền key cho CLI, đã bỏ nút gọi thử key. Cập nhật mục 2, 3.2, 3.4, 3.7, 4, 5, 8, 9. SQLite ghi đúng là `node:sqlite`. **FR-40/41 Claude hỏi lại giữa lúc chạy** qua tool `AskUserQuestion` (spike S9), AC-13. **FR-02** xoá được task Failed |
| Thay đổi 0.5 | Chốt 2026-11-18: **FR-01a/01b Import task hàng loạt** từ CSV, `.xlsx` hoặc dữ liệu dán từ bảng tính, kèm file mẫu. Thiết kế chi tiết và quy tắc I1–I7 ở [SPEC-IMPORT.md](SPEC-IMPORT.md). Cập nhật 3.1, 5.3, 8 (AC-14..21) |
| Thay đổi 0.5.1 | 2026-11-19: **FR-48 Đổi mức quyền project áp dụng cho task chưa chạy**: khi đổi mức quyền của project, hỏi người dùng có đổi theo cho các task Backlog, Queued, Failed hay không. **FR-49 Phạm vi ghi của task**: mẫu đường dẫn task được phép sửa, gắn vào prompt và cảnh báo ở Review khi sửa file ngoài phạm vi. Cập nhật FR-47, FR-61, 8 (AC-61..63), [SPEC-IMPORT.md](SPEC-IMPORT.md) |
| Thay đổi 0.6 | 2026-11-19: **Duyệt kế hoạch trước khi làm** (FR-100..106) và **Mở task trong Claude Code** (FR-110..116), chi tiết ở [SPEC-PLAN-HANDOFF.md](SPEC-PLAN-HANDOFF.md). Mức quyền `plan` của task/project chuyển thành thuộc tính riêng **Cách làm** (`planMode`: Làm luôn / Kế hoạch trước / Chỉ kế hoạch). Cập nhật FR-01, FR-47, FR-61 |
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
- **C1. Không gọi Claude API trực tiếp**: Task Board không dùng Anthropic SDK, không gọi Messages API hay bất kỳ endpoint nào của Anthropic. Mọi lời gọi model đều đi qua CLI `claude`.
  - *Làm rõ v0.4:* có **chế độ API key tuỳ chọn** (Cài đặt → Xác thực Claude, mặc định tắt). Ở chế độ này Task Board chỉ truyền key cho tiến trình CLI qua `ANTHROPIC_API_KEY`; bản thân Task Board không gọi API, kể cả để kiểm tra key (key sai báo lỗi ở lần chạy đầu tiên).
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
   với thư mục làm việc là thư mục project (mode *Ghi thẳng*, mặc định) hoặc worktree của task (mode *Nhánh git riêng*), xem FR-62.
2. **Theo dõi**: backend đọc output stream-json từng dòng, lưu vào DB và đẩy lên UI qua WebSocket.
3. **Review**: mọi task chạy xong đều vào Review. UI hiển thị output của Claude và thay đổi file (diff so với snapshot trước khi chạy, hoặc `git diff` của nhánh task) để người dùng duyệt. Approve là chấp nhận output; merge nhánh (mode Nhánh git riêng) là thao tác riêng, tuỳ chọn.
4. **Yêu cầu sửa**: backend chạy `claude -p --resume <session_id> "<feedback>"` để tiếp tục đúng phiên cũ.
5. **Sự kiện**: hooks của Claude Code (`Stop`, `Notification`) gọi HTTP về backend để cập nhật trạng thái.

---

## 3. Yêu cầu chức năng (Functional Requirements)

### 3.1 Quản lý task
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-01 | Tạo task: tiêu đề, mô tả (prompt), project/repo, độ ưu tiên, mức quyền, cách làm (Làm luôn / Kế hoạch trước / Chỉ kế hoạch, xem [SPEC-PLAN-HANDOFF.md](SPEC-PLAN-HANDOFF.md) FR-100) | Must |
| FR-01a | **Import task hàng loạt** (v0.5) từ CSV, `.xlsx` hoặc dữ liệu dán từ bảng tính. Xem trước từng dòng kèm lỗi, chống trùng tiêu đề, phụ thuộc giữa các dòng qua cột Mã. Mặc định tạo ở Backlog; tạo tất cả hoặc không. Quy tắc I1–I7 ở [SPEC-IMPORT.md](SPEC-IMPORT.md) | Should |
| FR-01b | Tải file mẫu cho import: mặc định **Excel `.xlsx`** (sheet Tasks + sheet Hướng dẫn), tuỳ chọn CSV (UTF-8 BOM) | Should |
| FR-02 | **Sửa** task khi còn ở Backlog hay Queued. **Xoá** task ở Backlog, Queued hoặc **Failed** (gồm task bị dừng/Reject, dọn kèm worktree nếu có). Không xoá task đang chạy, Needs Input, Review hay Done để không mất output và lịch sử (chốt 2026-11-18) | Must |
| FR-03 | Đưa task vào hàng đợi (Queue) để tự động chạy | Must |
| FR-04 | Hủy (Stop) task đang chạy | Must |
| FR-05 | Chạy lại (Retry) task bị lỗi | Should |
| FR-06 | Template prompt dùng lại (ví dụ "Fix bug", "Viết test", "Refactor") | Could |
| FR-07 | Gắn tag và lọc/tìm kiếm task | Could |
| FR-08 | **Phụ thuộc giữa task (bản 1)**: task khai báo "Chờ task" (một hoặc nhiều task cùng project). Chỉ chạy khi mọi task được chờ đã **Done** (đã merge); task không chờ ai chạy song song như thường. Hàng đợi hiển thị task đang chờ **sau** task nó chờ. Nguồn phụ thuộc: ① backlog.json (seed), ② người dùng chọn, ③ gợi ý khi prompt nhắc `#id` hoặc mã task (người dùng xác nhận), ④ **Claude báo `BLOCKED_BY`** khi đang chạy → tự thêm phụ thuộc, bỏ thay đổi dở, đưa task về Queued để chạy lại từ đầu sau task được chờ. Chặn phụ thuộc vòng tròn; "Chạy ngay" khi còn chờ phải xác nhận | Must |
| FR-09 | Phụ thuộc (bản 2): gợi ý phụ thuộc khi Approve bị conflict với task vừa merge; cảnh báo khi task sắp chạy nhắc tới file mà task khác đang sửa | Could |

### 3.2 Bảng Kanban và trạng thái
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-10 | Kanban với các cột: **Backlog → Queued → Running → Needs Input → Review → Done / Failed** | Must |
| FR-11 | Trạng thái cập nhật realtime, không cần reload trang | Must |
| FR-12 | Badge đếm số task ở **Needs Input** và **Review** (những task cần mình xử lý) | Must |

**Vòng đời trạng thái:**
```
Backlog ─► Queued ─► Running ─┬─► Review ─┬─► Done (Approve = chấp nhận output; Merge tuỳ chọn ở mode Nhánh git riêng)
                              │           ├─► Running (Request changes → resume)
                              │           └─► Failed/Rejected (Reject, output được giữ lại)
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
| FR-29 | Mọi task chạy xong đều chuyển **Review**, kể cả khi không sửa code (task phân tích, trả lời, báo cáo…). Trang Review hiển thị **output của Claude** để duyệt | Must |
| FR-30 | Xem danh sách file thay đổi và diff từng file (side-by-side hoặc unified) | Must |
| FR-31 | **Approve = chấp nhận output** (v0.4): task chuyển **Done**, không động vào git của người dùng. Mode *Ghi thẳng*: file đã nằm sẵn trong thư mục project, chỉ đánh dấu Done. Mode *Nhánh git riêng*: dọn worktree nhưng **giữ nhánh** `claude/task-<id>` ở local (nếu có commit chưa vào nhánh chính) để người dùng tự merge hoặc tạo PR | Must |
| FR-31a | **Merge (tuỳ chọn, mode Nhánh git riêng)**: merge nhánh task vào nhánh chính (`--no-ff`), task chuyển Done, xoá worktree và nhánh. Điều kiện merge: repo chính đang ở nhánh chính, không có file đã stage, và **không có file chưa commit trùng với file task sửa** (file chưa commit không liên quan được giữ nguyên, không chặn). Thanh Review hiển thị sẵn trạng thái này kèm danh sách file, tự kiểm tra lại khi quay lại tab. Conflict thì `merge --abort`, task giữ Review kèm cảnh báo | Should |
| FR-32 | **Request changes**: nhập feedback, task chạy tiếp bằng `--resume` | Must |
| FR-33 | **Reject** (v0.4): ghi review (kèm lý do nếu có), task chuyển **Failed**. **Không xoá output**: mode Ghi thẳng giữ file trong thư mục project, mode Nhánh git riêng giữ worktree và nhánh để người dùng xem lại, Tiếp tục hoặc Chạy lại | Must |
| FR-34 | Chạy lệnh kiểm tra (ví dụ `npm test`) và hiển thị kết quả trên trang review | Could |
| FR-35 | Review theo từng file: đánh dấu **Đã xem** từng file (tự bỏ đánh dấu khi file đổi sau lần chạy mới), hiển thị tiến độ x/y và số nhận xét mỗi file. **Nhận xét theo dòng** (hover số dòng, bấm +) hoặc cho cả file; nhận xét lưu nháp trên trình duyệt và được gửi kèm "Request changes" dưới dạng `file:dòng` + nội dung dòng để Claude sửa đúng chỗ. Có nhận xét thì feedback chung không bắt buộc; Approve khi còn nhận xét chưa gửi phải xác nhận | Should |
| FR-36 | File Markdown trong trang review: chế độ **Preview** (mặc định, render Markdown), **Diff** (nhận xét theo dòng) và **Edit** (sửa trực tiếp, lưu vào worktree và commit trên nhánh task, diff tính lại). Chỉ sửa được khi task ở Review, chỉ file `.md/.markdown/.mdx`, không ra ngoài worktree | Should |

### 3.5 Needs Input (Claude cần mình)
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-40 | Khi Claude cần xin quyền dùng tool hoặc **hỏi lại**, task chuyển sang **Needs Input**. Hỏi lại (v0.4): Claude dùng tool gốc `AskUserQuestion` (câu hỏi có tiêu đề, lựa chọn kèm mô tả, chọn một hoặc nhiều); câu hỏi đi qua permission prompt tool và **luôn chờ người trả lời**, kể cả ở mode Auto hay khi allowlist khớp. Claude nhận đáp án và **chạy tiếp trong cùng tiến trình**, không phải kết thúc rồi resume. Bỏ qua hoặc hết thời gian chờ thì Claude được báo tự chọn phương án an toàn và ghi rõ giả định. Câu hỏi không có "Luôn cho phép", không duyệt hàng loạt, không sinh gợi ý rule | Must |
| FR-41 | Trả lời hoặc cấp quyền (Allow / Deny) ngay trên web. Câu hỏi: chọn đáp án (radio/checkbox) hoặc nhập ô "Khác", nút **Gửi câu trả lời** / **Bỏ qua** (kèm ghi chú tuỳ chọn). Telegram: câu hỏi một đáp án có nút cho từng lựa chọn; câu hỏi khác chỉ có nút Bỏ qua và link trả lời trên web | Should |
| FR-42 | Lưu quy tắc "luôn cho phép" theo từng project | Could |
| FR-43 | Bộ quy tắc mẫu (preset) cho allowlist: Node/npm, Python, git chỉ đọc, chỉ đọc file. Preset không chứa lệnh có tác dụng phụ (`npm install`, `git push`, `git commit`) | Should |
| FR-44 | Gợi ý thêm rule vào allowlist từ lịch sử: rule được cho phép ≥ 3 lần trong 30 ngày, chưa bị từ chối lần nào, không phải lệnh rủi ro; người dùng có thể Thêm hoặc Bỏ qua | Should |
| FR-45 | Phân loại rủi ro yêu cầu quyền (xoá đệ quy, `git push`, `reset --hard`, tải script về chạy, ghi file ngoài thư mục task…): hiển thị cảnh báo đỏ kèm lý do, **không** cho "Luôn cho phép", và allowlist không được tự duyệt các lệnh này | Should |
| FR-47 | **Mức quyền Auto** (v0.3.1): ngoài `manual` / `acceptEdits`, project và task có thêm mode `auto` (từ v0.6, `plan` không còn là mức quyền mà là cách làm "Chỉ kế hoạch", xem SPEC-PLAN-HANDOFF A5). Ở mode Auto, mọi yêu cầu quyền (sửa file, chạy lệnh, kể cả lệnh ngoài allowlist) được **tự động cho phép, không cần người duyệt**: không tạo yêu cầu chờ, task không chuyển Needs Input, log ghi "Tự động cho phép … (mode Auto)". **Ngoại lệ:** lệnh rủi ro cao theo FR-45 vẫn dừng chờ duyệt tay. CLI chạy `--permission-mode acceptEdits`; các thao tác khác đi qua permission prompt tool và backend tự duyệt. Ở phương án dự phòng (tắt prompt tool), Auto hoạt động như `acceptEdits` + whitelist. Mode được chép từ project sang task **lúc tạo task**; đổi mode project chỉ ảnh hưởng task đã có khi người dùng chọn áp dụng (FR-48). Không dùng `bypassPermissions` (mục 9) | Should |
| FR-46 | Từ chối kèm lý do (lý do được gửi cho Claude để đổi cách làm); duyệt hàng loạt các yêu cầu giống hệt nhau ở Inbox; duyệt bằng nút trên Telegram (chỉ nhận từ đúng chat đã cấu hình) | Could |
| FR-48 | **Đổi mức quyền project áp dụng cho task chưa chạy** (v0.5.1). Khi lưu project đã có với mức quyền khác trước, hiện hộp xác nhận liệt kê các task của project ở **Backlog, Queued, Failed** đang có mức quyền khác mức mới, kèm số lượng theo trạng thái. Ba lựa chọn: **Huỷ** (quay lại form, chưa lưu gì), **Chỉ đổi project** (task giữ mức cũ, task tạo sau dùng mức mới), **Đổi project + N task**. Bỏ qua và ghi rõ trong hộp thoại: (a) task ở mode **Plan** khi mức mới không phải Plan, vì task chỉ phân tích không được tự nới thành task sửa code; (b) task chọn agent riêng mà agent đó không chạy được ở mức mới (FR-91). Mức mới là Auto thì hiện cảnh báo. Không có task nào liên quan thì lưu luôn, không hỏi. Server tính lại danh sách lúc lưu, trong cùng transaction với việc lưu project: task chuyển sang Running trong lúc hộp thoại mở thì giữ mức cũ. Task Running, Needs Input, Review, Done không bao giờ bị đổi. Task vẫn chọn được mức quyền riêng trong form task | Should |
| FR-49 | **Phạm vi ghi của task** (v0.5.1, tuỳ chọn). Task khai báo danh sách mẫu đường dẫn tương đối với thư mục làm việc, ví dụ `docs/**`, `*.md` (mẫu không có `/` so với tên file ở mọi cấp, `*` một cấp, `**` nhiều cấp). Nhập ở form task hoặc cột `write_scope` khi import; tối đa 20 mẫu, không nhận đường dẫn tuyệt đối hay `..`. Khi chạy, hệ thống **gắn ràng buộc vào cuối prompt**: chỉ được ghi file trong phạm vi, được đọc mọi file, cần sửa chỗ khác thì ghi vào mục "Đề xuất ngoài phạm vi" thay vì tự sửa. Tab Review **cảnh báo** và liệt kê các file trong diff nằm ngoài phạm vi (file đổi tên xét cả tên cũ). Đây là lớp mềm: chưa chặn cứng việc ghi file (để backlog, cần permission prompt tool theo từng agent). Trống: không giới hạn | Should |

### 3.6 Thông báo
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-50 | Thông báo trên trình duyệt (Web Notification) khi task chuyển sang Review, Needs Input hoặc Failed | Should |
| FR-51 | Thông báo qua Telegram (tùy chọn) | Could |

### 3.7 Quản lý project
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-60 | Khai báo một hoặc nhiều project (thư mục project; nhánh chính khi dùng mode Nhánh git riêng). Git chỉ bắt buộc ở mode Nhánh git riêng | Must |
| FR-61 | Cấu hình mặc định theo từng project: cách làm của task mới (FR-100), mức quyền (Manual / Edit automatically / Auto, xem FR-47; đổi mức quyền thì hỏi có áp dụng cho task chưa chạy, xem FR-48), allowedTools, số task chạy song song | Should |
| FR-62 | **Cách giao output** theo project (v0.4): ① **Ghi thẳng vào thư mục project** (mặc định cho project mới): Claude làm trực tiếp trong thư mục, không cần git, **mỗi lúc chỉ chạy 1 task** của project để các task không ghi đè nhau; diff tính theo snapshot trước/sau lần chạy. ② **Nhánh git riêng cho từng task**: worktree + nhánh `claude/task-<id>`, chạy song song theo `max_parallel`. Project đã có trước v0.4 giữ mode cũ | Must |

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
| NFR-01 | **Không gọi Claude API**, chỉ chạy CLI `claude` (đăng nhập sẵn, hoặc API key tuỳ chọn truyền cho CLI, xem C1) |
| NFR-02 | Không ghi đè giữa các task: mode Ghi thẳng chạy tuần tự (1 task mỗi lúc trên một project); mode Nhánh git riêng cách ly mỗi task trong **git worktree riêng** để chạy song song (v0.4, FR-62) |
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
| Database | SQLite (`node:sqlite` có sẵn trong Node 24) |
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
         -- permission_mode ∈ manual | acceptEdits | auto | plan (v0.3.1: thêm auto, FR-47)
tasks(id, project_id, title, prompt, status, priority, permission_mode, branch, worktree_path,
      session_id, created_at, updated_at)
runs(id, task_id, session_id, kind[initial|resume|retry], started_at, ended_at, exit_code,
     num_turns, cost_usd, result_summary)
events(id, run_id, ts, type, payload_json)      -- log stream-json
reviews(id, task_id, action[approve|request_changes|reject], feedback, comments JSON, created_at)
```
Bổ sung ở v0.3:
```
projects   + default_model, monthly_budget_usd, budget_action[warn|pause]
           + delivery_mode[direct|worktree]           -- v0.4, FR-62; project mới mặc định 'direct'
tasks      + model                                   -- '' = kế thừa, 'auto' | haiku | sonnet | opus
runs       + model, requested_model, model_source[auto|manual|default|escalated], model_reason,
             model_usage (JSON theo model), context_tokens
templates  + model
permission_requests + deny_reason, answers_json                  -- v0.4: đáp án AskUserQuestion (FR-40)
task_deps(task_id, depends_on_id)                   -- FR-08, cả hai cột ON DELETE CASCADE
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
| POST | `/api/tasks/:id/review` | `{action, feedback, comments?}`. `action`: `approve`, `merge` (v0.4, FR-31a), `request_changes`, `reject`. comments: `[{path, line?, side?, snippet?, text}]` |
| GET | `/api/tasks/:id/merge-check` | Kiểm tra trước khi merge: nhánh hiện tại, file chưa commit, file trùng với task, file đã stage |
| GET | `/api/tasks/:id/file?path=` | Nội dung file trong worktree (Preview Markdown) |
| PUT | `/api/tasks/:id/file` | `{path, content}`: lưu file Markdown và commit trên nhánh task |
| POST | `/api/tasks/:id/input` | Trả lời hoặc cấp quyền |
| POST | `/hooks/:event` | Nhận sự kiện từ hooks của Claude Code |
| WS | `/ws` | Đẩy sự kiện realtime (task status, log) |
| POST | `/api/tasks/import` | v0.5 (FR-01a): `{projectId, rows, onDuplicate, run, confirmAuto?, dryRun}`. `dryRun` chỉ kiểm tra, trả kết quả từng dòng; tạo thật thì tất cả hoặc không |
| POST | `/api/tasks/dep-suggest` | FR-08: gợi ý phụ thuộc từ `#id` / mã task trong tiêu đề, prompt |
| POST | `/api/model-suggest` | v0.3: model sẽ dùng và lý do (không gọi Claude, < 20ms) |
| GET | `/api/permission-presets` | v0.3: danh sách preset allowlist |
| GET | `/api/projects/:id/rule-suggestions` | v0.3: rule gợi ý từ lịch sử (+ `POST .../dismiss`) |
| POST | `/api/permissions/batch` | v0.3: duyệt hàng loạt `{ids, decision, reason?}` (bỏ qua câu hỏi) |
| POST | `/api/permissions/:id/answer` | v0.4 (FR-40): trả lời câu hỏi `{answers: {"<nguyên văn câu hỏi>": "<câu trả lời>"}}` |

### 5.4 Hooks của Claude Code
Cấu hình trong `.claude/settings.json` của worktree hoặc project:
- `Stop`: gọi `POST /hooks/stop`, task chuyển sang **Review** (có hoặc không có thay đổi code).
- `Notification`: gọi `POST /hooks/notification`, task chuyển sang **Needs Input**.
- Duyệt quyền trên web (FR-41): dùng `--permission-prompt-tool` trỏ tới một MCP server nhỏ do backend cung cấp.

---

## 6. Giao diện (UI)

1. **Dashboard / Kanban**: các cột trạng thái, badge "Cần xử lý", bộ lọc theo project.
2. **Form tạo task**: modal gồm tiêu đề, prompt (textarea lớn), project, template, mức quyền, ưu tiên. Mức quyền hiển thị tên dễ đọc (Manual / Edit automatically / Plan / Auto) kèm mô tả.
3. **Chi tiết task**: tab *Log* (realtime), tab *Diff*, tab *Lịch sử runs*, cùng các nút hành động.
4. **Trang Review**: diff và 3 nút **Approve & Merge / Request changes / Reject**.
5. **Settings**: quản lý project, giới hạn song song, thông báo. Mức quyền mặc định của project chọn bằng nhóm thẻ (giống bộ chọn mode của Claude Code), mỗi thẻ có tên và mô tả ngắn (FR-47).

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
- **AC-02**: Khi Claude xong việc, task tự chuyển sang **Review**, output và diff (nếu có) hiển thị đúng. Task không sửa code vẫn vào Review. Approve chuyển Done mà không merge (v0.4: ở cả hai mode).
- **AC-03**: Mode Nhánh git riêng: bấm **Merge** thì code được merge vào nhánh chính; Approve thì nhánh được giữ để tự merge. Mode Ghi thẳng: thay đổi đã nằm trong thư mục project. Request changes thì Claude tiếp tục đúng phiên cũ với feedback.
- **AC-04**: Mode Nhánh git riêng: chạy song song 2 task trên cùng repo mà không xung đột file. Mode Ghi thẳng: task thứ 2 của cùng project chờ task thứ nhất xong mới chạy.
- **AC-05**: Task Board không có bất kỳ lời gọi trực tiếp nào tới Claude API. Ở chế độ mặc định (đăng nhập Claude Code) không cần `ANTHROPIC_API_KEY`.
- **AC-06**: Khởi động lại backend không mất dữ liệu task.
- **AC-07** (v0.3): Tạo task mà không chọn model: "Sửa typo README" chạy Haiku, task thêm tính năng thông thường chạy Sonnet, "Refactor kiến trúc…" chạy Opus. Thẻ task hiện model và lý do chọn.
- **AC-08** (v0.3): Request changes giữ nguyên model. Retry sau lỗi tự nâng một bậc, trừ khi model được chọn tay.
- **AC-09** (v0.3): Project đặt budget ở chế độ "Tạm dừng": khi vượt budget thì task mới không chạy và có lý do hiển thị, cảnh báo 80%/100% chỉ gửi một lần trong tháng.
- **AC-11** (v0.3): B chờ A: B không chạy khi A chưa Done (kể cả còn slot), A Done thì B tự chạy; C độc lập chạy song song với A. Claude báo `BLOCKED_BY: #A` trong lúc chạy B thì B tự về Queued, chờ A.
- **AC-10** (v0.3): Lệnh rủi ro cao luôn phải duyệt tay (kể cả khi khớp allowlist) và không có nút "Luôn cho phép".
- **AC-12** (v0.3.1): Task ở mode Auto chạy `npm install x` (ngoài allowlist) thì được cho phép ngay, không tạo yêu cầu quyền và task không vào Needs Input; cùng task chạy `git push` thì vẫn dừng ở Needs Input chờ duyệt tay. Task ở mode Manual với cùng lệnh `npm install x` thì phải chờ duyệt.
- **AC-14..21** (v0.5): import task, xem [SPEC-IMPORT.md](SPEC-IMPORT.md) mục 4.
- **AC-61** (v0.5.1): Project đang Edit automatically có task A (Backlog), B (Failed), C (Queued, mode Plan), D (Running). Đổi project sang Auto và chọn **Đổi project + 2 task**: A và B thành Auto, C giữ Plan, D giữ Edit automatically; hộp thoại ghi rõ C bị bỏ qua. Chọn **Chỉ đổi project** thì A, B giữ nguyên, task tạo sau là Auto.
- **AC-62** (v0.5.1): Đổi mức quyền project khi không có task Backlog/Queued/Failed nào có mức khác thì lưu ngay, không hiện hộp xác nhận; lưu bị lỗi kiểm tra thì cả project lẫn task đều không đổi.
- **AC-63** (v0.5.1): Task có phạm vi ghi `docs/**`: prompt gửi cho agent có đoạn ràng buộc phạm vi; nếu diff có `src/app.ts` thì tab Review hiện cảnh báo liệt kê `src/app.ts`; diff chỉ có file trong `docs/` thì không cảnh báo. Phạm vi `../x` hoặc `/etc` bị từ chối khi lưu task và báo lỗi ở dòng khi import.
- **AC-13** (v0.4): Task (kể cả mode Auto) mà Claude gọi `AskUserQuestion` thì chuyển Needs Input, thẻ hiện câu hỏi và lựa chọn; trả lời trên web thì Claude dùng đúng đáp án và chạy tiếp **trong cùng lần chạy** (không có run resume). Bỏ qua hoặc hết thời gian thì Claude tự quyết và nêu giả định trong kết quả.

---

## 9. Rủi ro và lưu ý

| Rủi ro | Giảm thiểu |
|---|---|
| Vượt giới hạn sử dụng của gói Claude khi chạy nhiều task | Giới hạn song song, hiển thị thông báo lỗi rate limit, tự retry sau |
| Claude chạy lệnh nguy hiểm khi tự động | `--allowedTools` whitelist, mặc định `acceptEdits`, không bật bypass permissions |
| Mode Auto tự duyệt thao tác ngoài ý muốn (cài package, xoá file trong worktree) | Auto không phải mặc định, người dùng phải tự chọn; lệnh rủi ro cao (FR-45) vẫn duyệt tay; mọi thao tác tự duyệt đều ghi log; thay đổi nằm trong worktree riêng và vẫn qua Review trước khi merge |
| Mode Ghi thẳng (mặc định) không có cách ly: Claude sửa thẳng file của người dùng, Reject không hoàn tác | Mỗi project chỉ chạy 1 task mỗi lúc; diff theo snapshot trước/sau để thấy rõ thay đổi; nên dùng git hoặc sao lưu thư mục; cần cách ly hoặc chạy song song thì chọn mode Nhánh git riêng |
| Merge conflict khi nhiều task sửa cùng file | Phát hiện conflict khi merge, chuyển task về Review kèm cảnh báo |
| Định dạng output CLI thay đổi theo phiên bản | Gom phần parse vào một module, ghi lại phiên bản `claude` đã test |
| Worktree tích tụ chiếm dung lượng | Approve và Merge tự dọn worktree; Reject giữ worktree để xem lại (v0.4) |
| Tự chọn model sai (model rẻ làm hỏng, tốn thêm một lần chạy) | Ngưỡng chọn Haiku chặt; tự nâng model khi lỗi (FR-75); hiệu chỉnh theo lịch sử (FR-76); người dùng luôn chọn tay được |
| Đổi model giữa phiên làm mất prompt cache (cache gắn với từng model) | Resume giữ model (FR-74); khi nâng model mà ngữ cảnh ≥ 80k token thì mở phiên mới kèm tóm tắt |
| Chi phí hiển thị khác số tiền thực trả (gói subscription) | Ghi rõ "ước tính theo giá niêm yết"; giới hạn thật vẫn là hạn mức gói (đã xử lý rate limit) |
| Duyệt quyền qua Telegram bị người lạ bấm | Chỉ nhận callback từ đúng chat ID đã cấu hình; lệnh rủi ro không có "Luôn cho phép" |

---

## 10. Câu hỏi cần chủ dự án chốt

✅ **Đã chốt 2026-11-18:** chủ dự án đồng ý toàn bộ đề xuất mặc định (Q1–Q9).

| # | Câu hỏi | Đề xuất mặc định | Chốt |
|---|---|---|---|
| Q1 | Quản lý **một repo** hay **nhiều project**? | Nhiều project (đã thiết kế sẵn) | ✅ Mặc định |
| Q2 | Mức tự động: Claude tự sửa file và chạy lệnh trong whitelist, hay mọi thao tác đều phải duyệt? | Tự sửa file + whitelist lệnh, các lệnh khác phải duyệt | ✅ Mặc định |
| Q3 | Có cần truy cập từ **điện thoại / máy khác**? | Chỉ local ở v1, sau có thể dùng Tailscale | ✅ Mặc định. Truy cập từ xa (P4-07, token bắt buộc) đã có sẵn nhưng chỉ bật khi tự cấu hình |
| Q4 | Stack **Node/React** hay **Python (FastAPI)**? | Node/React | ✅ Mặc định |
| Q5 | Số task chạy song song tối đa? | 2 | ✅ Mặc định |
| Q6 | Có cần thông báo Telegram? | Không ở v1 | ✅ Mặc định. Telegram (P4-05, P7-03) đã có sẵn nhưng tắt, chỉ chạy khi tự cấu hình |
| Q7 (v0.3) | Model mặc định của hệ thống khi người dùng không chọn? | **Tự động** (FR-72) | ✅ Mặc định |
| Q8 (v0.3) | Khi vượt budget mặc định làm gì? | **Chỉ cảnh báo**; "Tạm dừng" bật theo từng project | ✅ Mặc định |
| Q9 (v0.3) | Có dùng LLM (Haiku) để phân loại độ khó task không? | **Không** ở giai đoạn này: tốn thêm khoảng 0,5–1 cent mỗi task qua CLI, lợi ích chưa rõ so với quy tắc + tự nâng model | ✅ Mặc định |

---

## 11. Phê duyệt

- [x] Chủ dự án đã đọc và đồng ý phạm vi (2026-11-18, gồm cả phần mới của v0.3/v0.3.1)
- [x] Đã trả lời các câu hỏi ở Mục 10 (2026-11-18: đồng ý toàn bộ mặc định)
- [x] Đồng ý bắt đầu Giai đoạn P1 (2026-11-18, xác nhận sau: P1 đã triển khai)
