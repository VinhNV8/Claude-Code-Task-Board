# SPEC bổ sung: Duyệt kế hoạch trước khi làm, và Mở task trong Claude Code

| Mục | Giá trị |
|---|---|
| Mã yêu cầu | **FR-100..FR-106** (Duyệt kế hoạch) · **FR-110..FR-116** (Mở trong Claude Code) · AC-43..AC-60 |
| Giai đoạn đề xuất | **P9** |
| Ngày | 2026-11-19 |
| Trạng thái | ✅ **Đã triển khai bản 1** (2026-11-19, nhánh `feature/multi-agent`). Spike S1, S2 xong (mục 6). Phần chưa làm và chỗ khác thiết kế ban đầu: mục 10 |
| Nguồn | Thảo luận product ngày 19-11: điểm yếu trải nghiệm #1 (mất vòng phản hồi nhanh) và #5 (không hợp với khám phá/debug) |
| Liên quan | [SPEC.md](SPEC.md) FR-29..33, FR-40, FR-47, FR-61, FR-62, FR-74; [SPEC-MULTI-AGENT.md](SPEC-MULTI-AGENT.md) FR-97 (không resume chéo agent); [SPEC-IMPORT.md](SPEC-IMPORT.md) |
| Sau khi duyệt | Gộp vào [SPEC.md](SPEC.md), lập task P9-xx trong [PLAN.md](PLAN.md) và [backlog.json](backlog.json) |

---

## 0. Bối cảnh

Task Board chạy cùng Claude Code mà người dùng vẫn dùng trong VS Code. Chỗ khác nhau nằm ở cách làm việc: **chat** là có người ngồi theo dõi và sửa hướng ngay, còn **task** là giao việc xong để agent tự làm, người dùng chỉ duyệt kết quả.

Cách làm theo task có hai điểm yếu khiến người dùng ngại chuyển sang:

| # | Điểm yếu | Hậu quả |
|---|---|---|
| W1 | **Mất vòng phản hồi nhanh.** Người dùng chỉ biết task đi sai hướng khi task đã chạy xong | Tốn trọn chi phí một lần chạy rồi mới sửa được. Người dùng mất niềm tin nên quay lại chat |
| W5 | **Không hợp với khám phá và debug.** Task làm sai, hoặc việc cần hỏi đáp nhiều lượt, thì chỉ còn cách *Request changes* rồi chờ hết lượt chạy kế tiếp | Người dùng phải tự mở Claude Code và kể lại từ đầu, mất ngữ cảnh mà task đã thu thập |

Spec này giải quyết hai điểm yếu trên bằng hai tính năng:
- **Phần A. Duyệt kế hoạch trước khi làm (giải quyết W1):** task lập kế hoạch trước, người dùng duyệt xong agent mới sửa code. Sai hướng được phát hiện khi chi phí còn nhỏ.
- **Phần B. Mở task trong Claude Code (giải quyết W5):** người dùng chuyển task đang dở sang một phiên Claude Code tương tác, giữ nguyên ngữ cảnh, làm xong thì đưa task về board.

Mục tiêu định vị: Task Board là **bàn điều phối đi cùng Claude Code**, không cạnh tranh với Claude Code. Phần B là cầu nối theo chiều *task sang chat*. Chiều ngược lại, *chat sang task* (đề xuất 5b), để spec sau.

---

## Phần A. Duyệt kế hoạch trước khi làm

### A1. Hành vi mong muốn

```
Tạo task (bật "Lập kế hoạch trước")
   │
   ▼
[Running · Kế hoạch]  agent chạy ở mode Plan: chỉ đọc code, phân tích, viết kế hoạch
   │  xong
   ▼
[Review · Duyệt kế hoạch]  người dùng đọc kế hoạch
   ├─ Duyệt (có thể sửa kế hoạch trước) ──► [Queued · Thực hiện] ──► [Running · Thực hiện] ──► [Review] như hiện tại
   ├─ Góp ý ───────────────────────────────► [Queued · Kế hoạch]  lập lại kế hoạch theo góp ý (resume)
   └─ Từ chối ─────────────────────────────► [Failed]
```

### A2. Quyết định thiết kế

| # | Quyết định | Lý do |
|---|---|---|
| D1 | **Hai lượt chạy riêng** (lượt Kế hoạch và lượt Thực hiện), nối với nhau bằng `--resume`. Không giữ tiến trình chờ người duyệt | Người dùng có thể mất nhiều giờ mới duyệt. Giữ tiến trình sẽ chiếm slot chạy song song và dễ chạm hạn chờ duyệt quyền (`permissionTimeoutMin`). Cả 3 agent đều đã hỗ trợ mode `plan` và chạy tiếp phiên, nên cách này dùng được cho mọi agent |
| D2 | **Chờ duyệt kế hoạch nằm ở cột Review**, có nhãn "Duyệt kế hoạch". Không thêm trạng thái mới | Review đã có đủ ba thao tác *Approve / Request changes / Reject*, đúng ba lựa chọn cần ở đây. Badge "cần tôi xử lý" (FR-12) tự đếm luôn. Needs Input thì không hợp vì trạng thái đó hiểu là tiến trình vẫn đang chạy |
| D3 | **Duyệt xong, task vào Queued**, không chạy ngay | Vẫn tuân theo slot, phụ thuộc giữa task, budget và lịch như mọi task |
| D4 | **Lượt Thực hiện chạy với mức quyền của task** | Chủ dự án đã chọn **giữ ô chọn mức quyền ở form task** (19-11). Mức quyền của task đồng bộ với project qua hộp xác nhận FR-48 khi đổi mức quyền project. Lượt Kế hoạch luôn chạy mode `plan` bất kể mức quyền (FR-101) |
| D5 | **Kế hoạch đã duyệt được lưu vào task** (`approvedPlan`) | Khi không resume được (đổi agent theo FR-97, mất phiên, nâng model sang phiên mới), lượt Thực hiện mở phiên mới với *prompt gốc + kế hoạch đã duyệt*. Kế hoạch không bị mất |
| D6 | **Thay giá trị `plan` trong mức quyền của task bằng thuộc tính `planMode`** | `plan` là ý định của task, không phải mức tin cậy. Gộp chung thì gây ra vấn đề khi đổi hàng loạt mức quyền theo project (xem thảo luận 19-11) |

### A3. Thuộc tính `planMode` của task

| Giá trị | Nhãn trên UI | Hành vi |
|---|---|---|
| `none` | Làm luôn | Như hiện tại |
| `first` | Lập kế hoạch trước | Theo luồng ở mục A1 |
| `only` | Chỉ lập kế hoạch | Chạy lượt Kế hoạch. Ở Review, *Approve* chuyển task sang **Done**, không có lượt Thực hiện. Thay cho mức quyền `plan` của task hiện nay |

**Mặc định:** project có cài đặt "Mặc định khi tạo task" (`defaultPlanMode`, mặc định `none`). Form tạo task, template, import và lịch chạy đều lấy giá trị này nếu không ghi rõ.

### A4. Yêu cầu chức năng

| Mã | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-100 | Task có thuộc tính `planMode` ∈ `none / first / only`. Đặt được ở form tạo task, template, cột `plan_mode` của file import (nhận cả *làm luôn / kế hoạch trước / chỉ kế hoạch*) và lịch chạy. Mặc định lấy từ `defaultPlanMode` của project | Must |
| FR-101 | **Lượt Kế hoạch** chạy với mode `plan` bất kể mức quyền của project. Hệ thống gắn thêm chỉ dẫn yêu cầu agent trả về kế hoạch theo khung: *Hiểu yêu cầu · Các file sẽ sửa hoặc tạo · Các bước · Rủi ro và giả định · Câu hỏi còn mở*. Agent vẫn hỏi lại được bằng `AskUserQuestion` (FR-40) | Must |
| FR-102 | Lượt Kế hoạch xong thì task chuyển **Review** với nhãn **"Duyệt kế hoạch"** trên thẻ, trang Review và thông báo (web, Telegram). Trang Review hiển thị kế hoạch dạng Markdown, kèm chi phí và thời gian của lượt Kế hoạch | Must |
| FR-103 | Ba thao tác ở Review:<br>• **Duyệt và thực hiện** (`first`): người dùng có thể **sửa trực tiếp kế hoạch** trước khi duyệt. Hệ thống lưu `approvedPlan` và chuyển task sang Queued. Lượt Thực hiện chạy `--resume` với mức quyền của task (D4), prompt là *"Kế hoạch đã được duyệt (bản cuối bên dưới). Thực hiện đúng kế hoạch…"*.<br>• **Góp ý lại**: lập lại kế hoạch bằng `--resume` kèm góp ý, vẫn ở mode `plan`.<br>• **Từ chối**: task chuyển Failed như FR-33.<br>Với `only`, nút *Approve* đổi thành **"Chấp nhận kết quả"** và task chuyển Done | Must |
| FR-104 | Lượt Thực hiện không resume được (FR-97 đổi agent, mất phiên, nâng model sang phiên mới) thì mở phiên mới với prompt *gốc + kế hoạch đã duyệt*. Log ghi rõ lý do | Must |
| FR-105 | Lịch sử run ghi rõ **giai đoạn** của mỗi lượt (Kế hoạch / Thực hiện). Thống kê tách chi phí của lượt Kế hoạch | Should |
| FR-106 | **Duyệt kế hoạch qua Telegram**: gửi tóm tắt kế hoạch (cắt ở 3.500 ký tự, kèm link xem đầy đủ), có nút *Duyệt / Mở trên web*. Góp ý thì phải làm trên web | Could |

### A5. Chuyển đổi từ mức quyền `plan` hiện có

| Dữ liệu hiện có | Sau khi chuyển |
|---|---|
| Task có `permission_mode = 'plan'` | `planMode = 'only'`, mức quyền lấy theo project. Task đã chạy (không ở Backlog/Queued) được đặt `planPhase = 'plan'` để vẫn duyệt được bằng "Chấp nhận kết quả" |
| Project có `permission_mode = 'plan'` | `defaultPlanMode = 'only'`, mức quyền chuyển về `manual` (mức chặt nhất), log ghi lại thay đổi |
| File import có cột `permission_mode = plan` | Hiểu là `plan_mode = only`, hiện một dòng cảnh báo ở bước xem trước |
| Mức quyền `plan` trong API | Vẫn nhận ở bản này và tự chuyển như trên. Bỏ hẳn ở bản sau. Form task / project không còn cho chọn `plan` |

> Liên quan FR-48 (đã làm): nhóm "bỏ qua task ở mode Plan" của hộp xác nhận đổi mức quyền chỉ còn tác dụng với dữ liệu chưa chuyển. Sau A5 không còn task nào có mức quyền `plan`.

### A6. Tiêu chí chấp nhận

| Mã | Tiêu chí |
|---|---|
| AC-43 | Task `first` ở project mức Auto: lượt Kế hoạch **không sửa được file nào**, mọi lần sửa hoặc chạy lệnh đều bị từ chối, có log. Task chuyển Review với nhãn "Duyệt kế hoạch" |
| AC-44 | Duyệt kế hoạch thì task sang Queued. Khi chạy, lượt Thực hiện resume đúng phiên của lượt Kế hoạch và chạy ở mức quyền **hiện tại** của task |
| AC-45 | Người dùng sửa kế hoạch rồi duyệt: agent nhận đúng bản đã sửa, và bản này lưu ở `approvedPlan` |
| AC-46 | Góp ý lại: lượt mới vẫn ở mode `plan`, resume phiên cũ, kế hoạch mới thay kế hoạch cũ trên trang Review. Lịch sử run giữ cả hai |
| AC-47 | Lượt Thực hiện bị failover sang agent khác: phiên mới có prompt gốc và kế hoạch đã duyệt |
| AC-48 | Task `only`: *Chấp nhận kết quả* chuyển task sang Done. Không có lượt Thực hiện, không có diff |
| AC-49 | Dữ liệu cũ có mode `plan` được chuyển đúng theo bảng A5. Không task nào bị nới quyền sau khi chuyển |
| AC-50 | Đang chờ duyệt kế hoạch thì task **không chiếm slot**: task khác của project vẫn chạy được |

---

## Phần B. Mở task trong Claude Code

### B1. Hành vi mong muốn

Ở trang task, người dùng bấm **"Mở trong Claude Code"**. VS Code mở một terminal ngay tại thư mục làm việc của task và chạy lệnh chạy tiếp phiên của agent, ví dụ `claude --resume <sessionId>`. Người dùng chat tiếp với đầy đủ ngữ cảnh mà task đã có: đã đọc file nào, đã sửa gì, vì sao.

Trong lúc người dùng làm tay, board **khoá task** để không có tiến trình nào chạy song song trên cùng phiên đó. Xong việc, người dùng đóng terminal hoặc bấm **"Đưa về Review"**. Hệ thống tính lại diff và task quay lại Review như bình thường.

### B2. Quyết định thiết kế

| # | Quyết định | Lý do |
|---|---|---|
| D7 | **Bản 1 dùng terminal của VS Code**, chưa mở vào panel của extension Claude Code | Terminal dùng được với mọi agent có lệnh chạy tiếp phiên. Việc mở thẳng panel Claude Code còn phụ thuộc extension đó có cho bên ngoài gọi vào không (spike S4) |
| D8 | **Khoá task trong lúc làm tay** (`handoff`) | Hai tiến trình cùng ghi vào một phiên, hoặc cùng sửa một worktree, sẽ làm hỏng phiên và trộn lẫn thay đổi |
| D9 | **Không theo dõi chi phí của phần làm tay** | Phiên tương tác chạy bằng đăng nhập của người dùng. Task Board không đọc được chi phí. Lịch sử ghi "chi phí: không rõ" thay vì 0 |
| D10 | **Lệnh chạy tiếp do từng agent cung cấp** (`adapter.interactiveResume`) | Claude: `claude --resume <id>`. Codex: `codex resume <id>`. Antigravity và Cursor cần spike. Agent nào chưa hỗ trợ thì ẩn nút |

### B3. Điều kiện được mở

| Trạng thái task | Mở được? | Xử lý |
|---|---|---|
| Review, Failed | ✅ | Mở ngay |
| Running, Needs Input | ⚠️ | Hỏi *"Dừng task để mở trong Claude Code?"*. Đồng ý thì Stop (FR-04) rồi mở |
| Queued | ⚠️ | Hỏi rồi bỏ khỏi hàng đợi |
| Backlog (chưa chạy lần nào), Done | ❌ | Chưa có phiên, hoặc task đã xong. Ẩn nút |
| Task không có `sessionId`, hoặc thư mục làm việc không còn | ❌ | Ẩn nút, tooltip ghi lý do |

### B4. Yêu cầu chức năng

| Mã | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-110 | Trang task có nút **"Mở trong Claude Code"** (tên agent đổi theo agent của lượt chạy cuối) theo điều kiện ở B3 | Must |
| FR-111 | **Trong VS Code** (webview của extension): bấm nút thì extension mở terminal tên `Task #<id>: <tiêu đề>`, với `cwd` = worktree của task, hoặc thư mục project ở mode Ghi thẳng, rồi chạy lệnh chạy tiếp phiên của agent. Có truyền `--model` của lượt cuối để giữ prompt cache (FR-74). Đường dẫn có dấu cách phải được quote đúng trên PowerShell và bash | Must |
| FR-112 | **Trên trình duyệt** (ngoài VS Code): nút mở link `vscode://vinhnguyen.agent-task-board/openTask?id=<id>`. Extension nhận URI này (cần thêm URI handler) và làm như FR-111. Kèm nút phụ **"Sao chép lệnh"** (`cd "<thư mục>" && claude --resume <id>`) cho người không dùng extension | Must |
| FR-113 | **Khoá task** khi đang làm tay: task giữ trạng thái hiện tại, thẻ có nhãn *"Đang mở trong Claude Code"*. Mọi thao tác chạy (Run, Queue, Retry, Request changes, Approve/Merge) bị chặn kèm giải thích. Phụ thuộc giữa task và lịch chạy cũng không lấy task này ra chạy | Must |
| FR-114 | **Mở khoá**:<br>(a) Mở bằng extension: terminal đóng thì tự mở khoá (`onDidCloseTerminal`).<br>(b) Bấm **"Đưa về Review"** trên board, cách duy nhất khi mở bằng lệnh sao chép.<br>(c) Sau 12 giờ không có thay đổi file trong thư mục task thì nhắc người dùng một lần, không tự mở khoá | Must |
| FR-115 | **Sau khi mở khoá**: ở mode Nhánh riêng, commit các thay đổi chưa commit trong worktree với message `Làm tay trong Claude Code`. Tính lại diff (`publishDiff`) và chuyển task về **Review**. Lịch sử run thêm một mục loại `manual`: giờ bắt đầu, giờ kết thúc, số file đổi, chi phí "không rõ". Các lượt *Request changes* sau đó resume **cùng phiên**, nên agent thấy được cả phần đã chat tay | Must |
| FR-116 | Project dùng **xác thực bằng API key**: trước khi mở, cảnh báo *"Phiên Claude Code sẽ dùng đăng nhập trên máy của bạn, không dùng API key của Task Board. Chi phí không được tính vào budget project."* | Should |

### B5. Tiêu chí chấp nhận

| Mã | Tiêu chí |
|---|---|
| AC-51 | Task Review ở mode Nhánh riêng: bấm nút thì terminal mở **đúng worktree**, `claude --resume` vào đúng phiên. Hỏi *"bạn vừa sửa những file nào?"* thì agent trả lời đúng |
| AC-52 | Đường dẫn project có dấu cách và ký tự tiếng Việt (`D:\Dự án\Repo A`) mở đúng trên Windows PowerShell |
| AC-53 | Task đang khoá: bấm Run, Queue, Request changes hay Approve đều bị chặn kèm thông báo. Task phụ thuộc vào task này vẫn chờ |
| AC-54 | Đóng terminal thì task được mở khoá trong vòng 5 giây. Diff mới có các thay đổi làm tay. Lịch sử có mục `manual` |
| AC-55 | Sau khi làm tay, chọn *Request changes*: agent resume cùng phiên và nhắc được nội dung vừa chat tay |
| AC-56 | Task đang Running: bấm nút thì hỏi xác nhận, đồng ý thì task dừng hẳn rồi mới mở terminal. Không lúc nào có hai tiến trình cùng một phiên |
| AC-57 | Mở từ trình duyệt bằng link `vscode://…` khi VS Code chưa mở: VS Code mở lên và terminal chạy đúng lệnh |
| AC-58 | Agent chưa hỗ trợ chạy tiếp phiên tương tác: nút bị ẩn, tooltip ghi lý do |
| AC-59 | Khởi động lại server trong lúc task đang khoá: sau khi khởi động, task vẫn khoá (khoá được lưu trong DB) |
| AC-60 | Mode Ghi thẳng: mở khoá không tạo commit, diff tính theo cách hiện tại của mode này |

---

## 4. Thay đổi dữ liệu

```
tasks    + plan_mode TEXT NOT NULL DEFAULT 'none'      -- none | first | only (FR-100)
         + plan_phase TEXT                             -- plan | execute | NULL (task none)
         + approved_plan TEXT                          -- FR-103, D5
projects + default_plan_mode TEXT NOT NULL DEFAULT 'none'
runs     + phase TEXT                                  -- plan | execute | NULL (FR-105)
         kind  += 'manual'                             -- FR-115
reviews  action += 'approve_plan'                      -- FR-103
task_handoffs (task_id PK, request_id, via, started_at, claimed_at, cwd, agent, reminded_at)   -- FR-113, bảng riêng
```

Đã bỏ cột `runs.cwd` dự kiến cho R-B1: spike cho thấy CLI vẫn tìm được phiên khi chữ hoa/thường của ký tự ổ đĩa khác nhau (mục 6).
Trạng thái khoá không lưu trên `tasks` mà ở bảng riêng `task_handoffs`, và được gắn vào task khi gửi cho web (`task.handoff`).

API mới:
```
POST /api/tasks/:id/review {action:'approve_plan', plan?}   FR-103 (plan trống = giữ nguyên kết quả lượt Kế hoạch)
POST /api/tasks/:id/handoff {via:'extension'|'copy', stop?} FR-110..112; 409 code NEEDS_STOP khi task đang chạy / Queued
GET  /api/handoffs/wait                                     long-poll cho extension (tối đa 25 giây)
POST /api/tasks/:id/handoff/claim {requestId}               extension nhận việc, chỉ lần đầu thành công
POST /api/tasks/:id/handoff/end {requestId?}                FR-114, FR-115
```

Thêm vào `AgentAdapter`:
- `interactiveResume?(sessionId, opts) → { command, args }`: không có thì ẩn nút "Mở trong…".
- Lượt Kế hoạch dùng lại `permissionModes` có sẵn (`plan`). Không cần năng lực mới.

---

## 5. Thay đổi giao diện

| Màn hình | Thay đổi |
|---|---|
| Form tạo/sửa task | Bộ chọn 3 nút **Làm luôn / Kế hoạch trước / Chỉ kế hoạch**, nằm gần ô prompt chứ không giấu trong phần nâng cao |
| Thẻ task | Nhãn giai đoạn: `Kế hoạch` hoặc `Thực hiện`. Nhãn `Đang mở trong Claude Code` kèm biểu tượng khoá |
| Trang Review (giai đoạn Kế hoạch) | Kế hoạch dạng Markdown, nút **Sửa**. Ba nút **Duyệt và thực hiện / Góp ý / Từ chối**. Không có tab Diff |
| Trang task | Nút **Mở trong Claude Code** cùng menu phụ **Sao chép lệnh**. Khi khoá thì hiện nút **Đưa về Review** |
| Projects | Trường "Mặc định khi tạo task" (`defaultPlanMode`) |
| File mẫu import | Thêm cột `plan_mode` và dòng giải thích trong sheet Hướng dẫn |

---

## 6. Spike cần làm trước

| # | Câu hỏi | Ảnh hưởng nếu không như dự kiến |
|---|---|---|
| S1 | Claude `-p --permission-mode plan` kết thúc ra sao: kế hoạch nằm trong event `result`, hay agent gọi `ExitPlanMode` qua permission prompt tool? Nếu gọi `ExitPlanMode` thì backend cần **lấy kế hoạch từ input của tool rồi từ chối** để kết thúc lượt chạy. Codex và Antigravity trả kế hoạch ở đâu? | Đổi cách lấy nội dung kế hoạch (FR-101) |
| S2 | `claude --resume <id>` trong terminal có tìm thấy phiên do `-p` tạo không, khi chạy đúng `cwd`, kể cả worktree? Lặp lại câu hỏi này cho `codex resume` | Nếu không được thì phần B chỉ còn "mở terminal ở đúng thư mục kèm tóm tắt", giá trị giảm nhiều |

**Kết quả S1 (19-11, CLI 2.1.327, chạy thật):** ở chế độ headless, `claude -p --permission-mode plan` **không có `ExitPlanMode`**. Claude ghi kế hoạch vào `~/.claude/plans/<slug>.md` (nằm ngoài repo) và trả kế hoạch trong `result`, kèm vài câu kiểu "hãy thoát plan mode để tôi làm". ⇒ FR-101 gắn chỉ dẫn yêu cầu câu trả lời cuối **chỉ** là kế hoạch theo khung, rồi lấy `result` của lượt Kế hoạch làm kế hoạch. Không cần chặn `ExitPlanMode`.

**Kết quả S2 bổ sung (19-11, chạy thật):** chạy `claude -p --resume <id>` từ thư mục `c:\...` (chữ thường) vẫn tìm thấy phiên tạo từ `C:\...`. ⇒ R-B1 rủi ro thấp, bỏ cột `runs.cwd`. Resume tương tác dùng cùng cơ chế tìm phiên này.

**Kết quả kiểm tra sơ bộ S2 (19-11, chỉ đọc file):**
- Phiên của lượt chạy `-p` được lưu chung chỗ với phiên tương tác: `~/.claude/projects/<cwd đã mã hoá>/<sessionId>.jsonl`. Ví dụ phiên của task UAT nằm ở `D--Projects-AI-Project-AI-Interface-uat-data-worktrees-p-990e0479-55/`. ⇒ Resume tương tác có cơ sở để làm được, với điều kiện terminal chạy **đúng `cwd`** của lượt chạy.
- ⚠️ **Rủi ro R-B1, chữ hoa/thường của ký tự ổ đĩa:** cùng một repo lại có thư mục `D--Projects-…` (lượt chạy của Task Board) và `d--Projects-…` (VS Code). Tên thư mục phiên phân biệt chữ hoa/thường của ổ đĩa. Nếu terminal mở ở `d:\…` mà lượt chạy dùng `D:\…` thì có thể không tìm thấy phiên. ⇒ FR-111 phải dùng **nguyên văn chuỗi `cwd` đã truyền khi spawn** (lưu vào run) thay vì tự dựng lại đường dẫn.
- ⚠️ **Rủi ro R-B2, phiên gắn với tài khoản:** dòng đầu file phiên có `session-owner` (`accountUuid`, `organizationUuid`). Phiên tạo bằng API key (tổ chức Console) có thể **không resume được** bằng đăng nhập Pro/Max và ngược lại. ⇒ Kiểm tra trong S3. Nếu đúng như vậy thì FR-116 đổi từ cảnh báo thành **chặn** ở project dùng API key.
- Ký tự tiếng Việt trong đường dẫn bị thay bằng `-` khi mã hoá (`10-B--Th-ng-Th-i`). Hai thư mục khác nhau có thể trùng tên mã hoá. Rủi ro thấp vì `sessionId` là duy nhất, nhưng vẫn cần đưa vào AC-52.
| S3 | Sau khi chat tay, `-p --resume` lần sau có đọc được các lượt chat tay không? Có xung đột gì với hook hay `--settings` mà Task Board gắn vào lượt chạy không? | AC-55 |
| S4 | Extension Claude Code có lệnh hay URI nào để mở panel ở một phiên cụ thể không? | Chỉ ảnh hưởng bản 2 (D7) |

---

## 7. Chỉ số thành công

| Chỉ số | Cách đo | Mục tiêu sau 4 tuần |
|---|---|---|
| Tỉ lệ task `first` được Approve ngay sau lượt Thực hiện | `runs` + `reviews` | Cao hơn task `none` ít nhất 15 điểm % |
| Chi phí lượt Kế hoạch / tổng chi phí task | `runs.phase` | ≤ 20% |
| Tỉ lệ kế hoạch bị góp ý hoặc từ chối | reviews có `plan_phase = plan` | Theo dõi. Đây là số lần sai hướng được chặn sớm |
| Số task được mở trong Claude Code mỗi tuần | `runs.kind = manual` | Theo dõi |
| Tỉ lệ task "cứu được" (mở tay rồi sau đó được Approve) | task có run `manual` rồi chuyển Done | ≥ 60% |

---

## 8. Thứ tự triển khai đề xuất

| Bước | Nội dung |
|---|---|
| P9-01 | Spike S1–S3, ghi kết quả vào [P0-SPIKE.md](P0-SPIKE.md) |
| P9-02 | Dữ liệu và chuyển đổi (mục 4, A5) + `planMode` trên form, template, import |
| P9-03 | Lượt Kế hoạch, trang Duyệt kế hoạch, lượt Thực hiện (FR-101..104) |
| P9-04 | Khoá task, mở khoá, run `manual` (FR-113..115) |
| P9-05 | Mở terminal trong extension, URI handler, sao chép lệnh (FR-110..112, FR-116) |
| P9-06 | Lịch sử và thống kê theo giai đoạn (FR-105), Telegram (FR-106) |

---

## 9. Câu hỏi cần chốt

| # | Câu hỏi | Đề xuất |
|---|---|---|
| Q1 | Lượt Kế hoạch có dùng model rẻ hơn lượt Thực hiện không? | **Bản 1: dùng cùng model.** Lượt Kế hoạch chỉ đọc nên vốn đã rẻ, và đổi model giữa hai lượt sẽ mất prompt cache (FR-74). Xem lại khi có số liệu ở mục 7 |
| Q2 | `defaultPlanMode` của project mới nên là gì? | `none`, để không thêm bước cho người dùng hiện tại. Hồ sơ project *Thận trọng* (đề xuất 3a) sẽ đặt `first` |
| Q3 | Có cho bỏ qua bước duyệt khi kế hoạch "đơn giản" không? | **Không** ở bản 1. Tự bỏ qua làm người dùng khó đoán hệ thống sẽ làm gì |
| Q4 | Đang khoá mà người dùng sửa file thẳng trong VS Code, không qua Claude Code, thì sao? | Vẫn tính vào diff khi mở khoá (FR-115). Board không phân biệt ai sửa |
| Q5 | Phần B có hỗ trợ mở từ máy khác (Telegram trên điện thoại) không? | Không. Phần B cần máy đang chạy VS Code |

---

## 10. Đã triển khai (bản 1, 2026-11-19)

| Hạng mục | Trạng thái | Ghi chú |
|---|---|---|
| FR-100..105 | ✅ | `planMode` có ở form task, project (`defaultPlanMode`), import (cột `plan_mode`), lịch chạy và **template** (P9-08, 2026-11-20) |
| FR-106 Telegram duyệt kế hoạch | ✅ (2026-11-20) | Tin "📝 Kế hoạch chờ duyệt" (hoặc "Kết quả phân tích chờ duyệt") kèm kế hoạch (cắt ở 3.500 ký tự) và một nút: **Duyệt và thực hiện** / **Chấp nhận kết quả**. Tin này thay cho tin "Cần review" chung. Duyệt trên web trước thì tin được sửa, bỏ nút. Mỗi lượt Kế hoạch (kể cả sau Góp ý) gửi một tin. Theo cài đặt thông báo Review |
| FR-110..113, FR-115, FR-116 | ✅ | |
| FR-114a/b | ✅ | Đóng terminal hoặc thoát agent thì task tự mở khoá; có nút "Đưa về Review" |
| FR-114c nhắc sau 12 giờ | ✅ (2026-11-20, bản rút gọn) | Task khoá quá 12 giờ thì nhắc **một lần** (thông báo web + Telegram), không tự mở khoá. **Khác spec:** không xét điều kiện "thư mục không đổi", vì phải chụp trạng thái thư mục định kỳ. Nhắc theo thời gian là đủ để không quên task đang khoá |
| Spike S3 (phiên tạo bằng API key có resume được bằng đăng nhập không) | ⏳ Chưa kiểm | FR-116 đang cảnh báo, chưa chặn |
| Spike S4 (mở thẳng panel Claude Code) | ⏳ Bản 2 | |

**Khác thiết kế ban đầu:**
- **Extension nhận yêu cầu bằng long-poll** (`GET /api/handoffs/wait`), không dùng WebSocket. Lý do: extension biên dịch với `lib: ES2022` nên không có kiểu WebSocket, còn long-poll là cách server đã dùng cho duyệt quyền. Cửa sổ VS Code đang mở đúng project nhận việc ngay, cửa sổ khác chờ 1,5 giây rồi mới nhận.
- **Giao diện web trong VS Code là iframe nên không gọi thẳng vào extension được.** Khi bấm "Mở trong Claude Code", server khoá task và phát yêu cầu, extension nhận việc rồi mở terminal. Nếu sau 4 giây chưa cửa sổ nào nhận, banner hiện link `vscode://vinhnguyen.agent-task-board/openTask?id=…&req=…` và nút "Sao chép lệnh".
- **Lượt Thực hiện đầu tiên** là một lượt `resume`, ghi feedback là "Thực hiện theo kế hoạch đã duyệt". Prompt thật do runner dựng từ `approvedPlan`. Mọi lượt phải mở phiên mới (đổi agent, mất phiên, nâng model, Chạy lại) đều gửi kèm prompt gốc cùng chỉ dẫn hoặc kế hoạch của giai đoạn hiện tại (AC-47).
- **Chạy lại** một task "Kế hoạch trước" đã có kế hoạch được duyệt thì vào thẳng lượt Thực hiện với kế hoạch đó, không lập lại kế hoạch.
- **Agent hỗ trợ mở phiên tương tác:** Claude (`claude --resume <id> [--model <alias>]`) và Codex (`codex resume <id>`). Với Antigravity và Cursor, nút bị ẩn.

- **Chỉ dẫn của lượt Kế hoạch theo cách làm (2026-11-20):** "Kế hoạch trước" ép khung kế hoạch (Hiểu yêu cầu · File sẽ sửa · Các bước · Rủi ro · Câu hỏi) để người dùng có bản chuẩn để duyệt. "Chỉ kế hoạch" chỉ yêu cầu không sửa gì, còn kết quả **theo đúng định dạng prompt yêu cầu**, vì task phân tích (phân rã task, phân tích tác động, kiểm tra yêu cầu) thường đã ghi rõ định dạng. Trên giao diện, task "Chỉ kế hoạch" hiện "Kết quả phân tích" và nút **Chấp nhận kết quả**.
- **Template mặc định** "Làm rõ yêu cầu", "Phân rã thành task", "Phân tích tác động", "Kiểm tra theo yêu cầu" có cách làm **Chỉ kế hoạch** (prompt của chúng đã ghi "Không sửa code"). "Viết đặc tả" vẫn làm luôn vì phải ghi file tài liệu. Chỉ áp dụng cho bản cài mới: template đã nạp trước đó không bị đổi.

**Test:** `server/src/handoff.test.ts`, `planMode.test.ts`, `planHandoff.test.ts` (qua API), `agents/runnerPlan.test.ts` (qua runner với agent giả), `telegramPlan.test.ts` (FR-106), `templates.test.ts` (P9-08).
