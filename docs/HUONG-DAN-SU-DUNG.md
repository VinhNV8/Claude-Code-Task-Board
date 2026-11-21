# Hướng dẫn sử dụng Claude Task Board

> Phiên bản tài liệu: 2026-11-13 · Ứng dụng: `claude-task-board` 0.1.0 (có bản Extension VS Code tên **Agent Task Board**)

## 1. Giới thiệu

**Claude Task Board** là bảng công việc để **giao việc cho Claude Code**, theo dõi tiến độ và review kết quả qua giao diện web. Bạn không cần mở VS Code để biết Claude đang làm gì.

Luồng làm việc cơ bản:

```
Giao task → Claude chạy (log realtime) → [Cần bạn: xin quyền / hỏi lại] → Review → Chấp nhận / Yêu cầu sửa / Từ chối
```

Tool chạy **Claude Code CLI ở chế độ headless** bằng một trong hai cách xác thực:

| | Đăng nhập Claude Code | API key |
|---|---|---|
| Phù hợp | Cá nhân tự dùng (gói Pro/Max) | Sản phẩm, doanh nghiệp |
| Chi phí | Nằm trong gói | Trả theo token (tài khoản Claude Console) |
| Budget project | Tuỳ chọn: cảnh báo hoặc tạm dừng | Giới hạn cứng: vượt budget là tạm dừng |

---

## 2. Cài đặt và khởi động

Có hai cách dùng. Chọn một.

### Cách A: Chạy từ mã nguồn (web)

**Yêu cầu:** Node.js ≥ 22.13, git, Claude Code đã cài và đăng nhập. Backend tự tìm `claude.exe` trong extension VS Code; nếu không thấy, đặt biến môi trường `CLAUDE_BIN` trỏ tới file chạy.

```bash
npm install        # lần đầu
npm run dev        # backend :3001 + giao diện :3000 (hot reload)
```

Mở **http://localhost:3000**.

| Lệnh | Mô tả |
|---|---|
| `npm run dev` | Chạy thật, hot reload |
| `npm start` | Build giao diện và chạy trên một port 3000 |
| `npm run dev:mock` | Bản dùng thử với dữ liệu giả, không cần backend |
| `npm run typecheck` | Kiểm tra kiểu dữ liệu |
| `npm test -w server` | Unit test |

### Cách B: Extension VS Code (Agent Task Board)

Không cần cài Node hay chạy lệnh: extension tự chạy server bằng chính VS Code (cần VS Code ≥ 1.101).

1. Cài extension (từ Marketplace hoặc `code --install-extension agent-task-board-<version>.vsix`).
2. Bấm biểu tượng **Agent Task Board** ở thanh bên trái.
3. Nếu workspace đang mở là git repo, chọn **Thêm** khi extension hỏi có thêm làm project không.
4. Tạo task, mô tả việc cần làm, bấm **Chạy**.

Các lệnh trong Command Palette (Ctrl+Shift+P):

| Lệnh | Việc |
|---|---|
| Agent Task Board: Mở Task Board | Mở bảng công việc (lọc theo project của workspace) |
| Agent Task Board: Thêm workspace này làm project | Thêm git repo đang mở |
| Agent Task Board: Cài đặt | Xác thực, thông báo, mặc định |
| Agent Task Board: Mở trong trình duyệt | Mở cùng giao diện trên trình duyệt |
| Agent Task Board: Đăng nhập Claude Code | Mở terminal chạy `claude auth login` |
| Agent Task Board: Khởi động lại server | Dừng rồi chạy lại server (task đang chạy sẽ dừng) |
| Agent Task Board: Xem log server | Mở file log |

Cài đặt trong `settings.json`: `agentTaskBoard.claudePath` (đường dẫn Claude CLI, mặc định tự tìm) và `agentTaskBoard.idleShutdownMinutes` (tự tắt server sau số phút rảnh, mặc định 30, `0` là không tắt).

---

## 3. Bắt đầu nhanh (5 bước)

1. **Xác thực Claude:** vào **Cài đặt → Xác thực Claude**, chọn đăng nhập Claude Code hoặc nhập API key. Không có nút kiểm tra key: key sai sẽ báo lỗi ở lần chạy task đầu tiên.
2. **Thêm project:** vào **Projects → Thêm project**, chọn thư mục và cách giao output (mục 5).
3. **Giao việc:** bấm **Giao việc mới** (hoặc phím `N`), nhập tiêu đề và mô tả.
4. **Theo dõi:** mở task để xem log realtime. Khi task cần bạn, nó hiện ở mục **Cần bạn**.
5. **Review:** xem output và thay đổi, rồi **Chấp nhận output**, **Yêu cầu sửa** hoặc **Từ chối**.

---

## 4. Giao diện

Thanh bên trái gồm:

| Mục | Dùng để |
|---|---|
| **Công việc** | Bảng task, có 3 cách xem |
| **Cần bạn** | Các task đang chờ bạn (xin quyền, review) kèm số đếm |
| **Projects** | Quản lý project, budget |
| **Thống kê** | Chi phí theo model, dự báo cuối tháng, bảng tag × model |
| **Cài đặt** | Ngôn ngữ, thực thi, xác thực, thông báo, template, cron |

Nhãn **DEV** (vàng) / **UAT** (xanh) cạnh logo cho biết bạn đang ở môi trường nào (xem mục 11).

### 4.1 Ba cách xem trang Công việc

| Phím | Cách xem | Dùng khi |
|---|---|---|
| `1` | **Bảng** | Lên kế hoạch, kéo thả task giữa các cột Kanban |
| `2` | **Điều phối** | Xem việc cần bạn, agent đang chạy và pipeline |
| `3` | **Phân luồng** | Danh sách bên trái, chi tiết bên phải; `J`/`K` để chuyển task |

Trang nhớ cách xem gần nhất; màn hình hẹp (điện thoại) mặc định dùng **Điều phối**. Có thể lọc theo project, tag, trạng thái và tìm kiếm.

### 4.2 Phím tắt

| Phím | Tác dụng |
|---|---|
| `Ctrl+K` (hoặc `⌘K`) | Bảng lệnh: tìm task theo tên hoặc `#id`, đổi cách xem, giao việc, chuyển trang |
| `N` | Giao việc mới |
| `1` / `2` / `3` | Chuyển cách xem Bảng / Điều phối / Phân luồng |
| `J` / `K` | Task kế tiếp / trước (cách xem Phân luồng) |
| `[` | Thu/mở thanh bên |
| `Ctrl+Enter` | Gửi nhận xét đang soạn trên diff |
| `Esc` | Đóng hộp thoại, huỷ nhận xét |

Phím đơn (`N`, `1`…) không hoạt động khi bạn đang gõ trong ô nhập.

---

## 5. Quản lý project

Vào **Projects**. Mỗi project là một thư mục trên máy bạn.

| Trường | Ý nghĩa |
|---|---|
| Tên | Tên hiển thị |
| Thư mục project | Thư mục gốc, ví dụ `D:\Projects\my-repo` |
| Nhánh chính | Nhánh chính của repo (dùng ở chế độ nhánh riêng) |
| Cách giao output | Xem bảng dưới |
| Số task song song tối đa | Ở chế độ ghi thẳng luôn là 1 |
| Mức quyền mặc định | Xem mục 7 |
| Model mặc định | Tự động / Haiku / Sonnet / Opus |
| Lệnh test (tuỳ chọn) | Ví dụ `npm test`, chạy được trên trang review |
| Allowlist công cụ | Các lệnh/công cụ được tự cho phép (có preset và gợi ý, mục 7) |
| Budget tháng (USD) | Tuỳ chọn, kèm hành động: chỉ cảnh báo hoặc tạm dừng |

**Hai cách giao output:**

| Cách | Mô tả |
|---|---|
| **Ghi thẳng vào thư mục project** (mặc định) | Output nằm ngay trong thư mục, không cần git. Mỗi lúc chạy 1 task để các task không ghi đè nhau |
| **Nhánh git riêng cho từng task** | Cần git repo. Mỗi task làm trên nhánh local `claude/task-<id>` (worktree), chạy song song được. Bạn tự merge hoặc tạo PR theo quy trình riêng |

---

## 6. Giao và quản lý task

### 6.1 Tạo task

Bấm **Giao việc mới** (hoặc `N`):

| Trường | Ý nghĩa |
|---|---|
| Tiêu đề | Tên ngắn của việc |
| Mô tả (prompt) | Yêu cầu chi tiết gửi cho Claude |
| Template | Chọn prompt mẫu (quản lý ở Cài đặt) |
| Project | Project sẽ chạy task |
| Độ ưu tiên | Quyết định thứ tự trong hàng đợi |
| Cách làm | **Làm luôn** · **Kế hoạch trước** (agent lập kế hoạch, bạn duyệt rồi agent mới sửa code, mục 8.1) · **Chỉ kế hoạch** (chỉ phân tích, không sửa code). Mặc định theo project |
| Mức quyền | Manual / Edit automatically / Auto (mục 7) |
| Tag | Để lọc và để hệ thống học chọn model |
| Model | Để trống là kế thừa; form hiện model sẽ dùng và lý do ngay khi bạn gõ |
| Chờ task | Task chỉ chạy khi các task này đã **Done** |
| Tệp đính kèm | Mockup, ảnh chụp màn hình, log lỗi, PDF… (kéo thả hoặc chọn file, mục 6.1b) |

**Chọn model:** mặc định là **Tự động**. Hệ thống chấm điểm theo tag, mức quyền, từ khoá, độ dài prompt, số file nhắc tới (không gọi thêm model nên không tốn phí). Thứ tự ưu tiên: Task → Project → Hệ thống. Có thể chọn tay Haiku / Sonnet / Opus. Khi Retry sau lỗi, hoặc Yêu cầu sửa từ lần thứ 2, hệ thống tự nâng một bậc (Haiku → Sonnet → Opus), trừ model chọn tay; tắt được ở Cài đặt → Thực thi.

**Phụ thuộc giữa task:** ghi `#id` trong tiêu đề hoặc prompt để được gợi ý, hoặc chọn ở ô **Chờ task**. Nếu trong lúc chạy Claude báo `BLOCKED_BY: #A` thì task tự về hàng đợi, chờ task A.

### 6.1b Tệp đính kèm, nhân bản task

**Tệp đính kèm.** Kéo thả hoặc chọn file ở form tạo task, hoặc ở tab **Yêu cầu** của task. Nhận `png`, `jpg`, `webp`, `gif`, `pdf`, `md`, `txt`, `csv`, `json`, `log`; tối đa 10 MB mỗi file, 20 file hoặc 50 MB mỗi task.
- File lưu ở `data/attachments/<id task>/`, không ghi vào thư mục project.
- Mỗi lần chạy, đường dẫn các file được thêm vào cuối prompt và agent được quyền **đọc** đúng thư mục đó (Claude: `--add-dir`). Thêm/xoá file giữa các lần chạy thì lần sau dùng danh sách mới. Task đang chạy thì chưa đổi được file.
- Nội dung file chỉ là tài liệu tham khảo; prompt dặn agent không làm theo chỉ dẫn nằm trong file. Đừng đính kèm thông tin nhạy cảm.
- Xoá task thì file đính kèm cũng bị xoá. Thẻ task hiện biểu tượng 📎 kèm số file.

**Nhân bản.** Trong chi tiết task bấm **Nhân bản**: bản sao nằm ở Backlog, tiêu đề thêm "(bản sao)", giữ prompt, project, độ ưu tiên, mức quyền, cách làm, tag, model, agent, phạm vi ghi và file đính kèm; không giữ lịch sử chạy, kết quả, diff và các task cần chờ (chọn lại nếu cần). Form sửa bản sao mở ngay.
**Chạy lại với prompt mới** (task Done hoặc Failed): tạo bản sao, mở form để sửa prompt, bấm **Lưu & Chạy**. Task cũ và lịch sử của nó giữ nguyên.

### 6.1a Import nhiều task từ CSV / Excel

Bấm **Import** trên thanh đầu trang (hoặc `Ctrl K` → *Import task từ CSV / Excel*):

1. Chọn project, rồi chọn file **.csv** hoặc **.xlsx** (đọc sheet đầu tiên), kéo thả file vào hộp thoại, hoặc copy vùng ô trong Excel / Google Sheets rồi dán vào ô bên dưới.
2. Xem trước: mỗi dòng hiện **Hợp lệ**, **Trùng** (đã có task cùng tiêu đề trong project, mặc định bỏ qua) hoặc **lỗi** kèm lý do. Bỏ tick dòng nào thì dòng đó không được import.
3. Chọn **Tạo ở** *Backlog* (mặc định, chưa chạy) hoặc *Hàng đợi* (tự chạy, phải xác nhận), rồi bấm **Tạo N task**. Còn dòng lỗi thì không tạo được; bấm **Bỏ chọn các dòng lỗi** để import phần còn lại.

Dòng đầu tiên là tên cột, không phân biệt hoa thường hay dấu. Bấm **Tải file mẫu (Excel)** để có file `.xlsx` mẫu: sheet *Tasks* để điền task, sheet *Hướng dẫn* giải thích từng cột. Cần CSV thì bấm **hoặc CSV**.

| Cột | Tên nhận được | Ghi chú |
|---|---|---|
| Tiêu đề | `title`, `Tiêu đề` | Bắt buộc |
| Mô tả | `prompt`, `Mô tả` | Bắt buộc, ít nhất 10 ký tự, được nhiều dòng |
| Mã | `key`, `Mã` | Mã riêng trong file (vd `A1`) để dòng khác chờ |
| Chờ task | `depends_on`, `Chờ task` | Mã của dòng khác, `#id` hoặc mã task đã có (`P2-01`), cách nhau bởi dấu phẩy |
| Project | `project` | Tên hoặc id; trống thì dùng project đã chọn |
| Độ ưu tiên | `priority`, `Ưu tiên` | `urgent/high/normal/low` hoặc `khẩn/cao/thường/thấp` |
| Tag | `tags` | Cách nhau bởi dấu phẩy hoặc `;` |
| Model | `model` | `auto/haiku/sonnet/opus`; trống là kế thừa |
| Mức quyền | `permission_mode`, `Mức quyền` | `manual/acceptEdits/plan/auto`; trống lấy mặc định của project. Có task Auto thì phải tick xác nhận |
| Giới hạn chi phí | `max_cost_usd` | USD, nhận `1,5` hoặc `1.5` |

Mỗi lần tối đa 200 dòng, 5 MB. Không đọc được file `.xls` cũ: hãy lưu lại thành `.xlsx` hoặc CSV.

> **CSV từ Excel tiếng Việt:** Excel thường lưu CSV bằng dấu `;` và mã hoá Windows-1258. Task Board tự nhận cả hai; nếu chữ vẫn lỗi, đổi ô **Mã hoá** ở màn xem trước, hoặc lưu bằng *CSV UTF-8*, hoặc dùng thẳng file `.xlsx`.

### 6.2 Vòng đời trạng thái

```
Backlog ─► Queued ─► Running ─┬─► Review ─┬─► Done (Chấp nhận)
                              │           ├─► Running (Yêu cầu sửa → resume)
                              │           └─► Failed / Rejected (Từ chối)
                              ├─► Needs Input ─► Running (sau khi bạn trả lời/cấp quyền)
                              └─► Failed ─► Queued (Retry)
```

| Trạng thái | Ý nghĩa |
|---|---|
| Backlog | Mới tạo, chưa chạy. Còn sửa/xoá được |
| Queued | Trong hàng đợi, tự chạy khi còn slot |
| Running | Claude đang làm |
| Needs Input | Claude xin quyền hoặc hỏi lại, **chờ bạn** |
| Review | Đã xong, **chờ bạn duyệt** (kể cả task chỉ phân tích, không sửa file) |
| Done / Failed | Hoàn thành / lỗi |

Hành động trên task: **Đưa vào hàng đợi**, **Dừng** (Stop), **Chạy lại** (Retry), **Sửa/Xoá** (khi còn Backlog hoặc Queued). Kéo thả thẻ giữa các cột ở cách xem Bảng.

### 6.3 Chi tiết task

Mở một task để xem:

- **Log** realtime: tin nhắn của Claude, công cụ đang dùng (đọc/sửa file, chạy lệnh).
- **Kết quả**: tóm tắt cuối cùng, thời gian chạy, số lượt, chi phí ước tính, model thực tế (kèm token và chi phí theo model).
- **Diff**: danh sách file thay đổi.
- **Lịch sử**: mọi lần chạy (run) và các nhận xét đã gửi; mỗi lần chạy có dòng Model (🤖 tự chọn, ✋ bạn chọn, ⬆ tự nâng) và bảng token/chi phí theo model.
- Thẻ task trên Board có badge model của lần chạy mới nhất.

---

## 7. Xin quyền (Needs Input)

Khi Claude cần chạy lệnh hoặc dùng công cụ cần duyệt, task chuyển sang **Needs Input** và hiện thẻ yêu cầu ở mục **Cần bạn**.

**Mức quyền:**

| Mức | Hành vi |
|---|---|
| **Manual** | Mọi thao tác ghi (sửa file, chạy lệnh) đều chờ bạn duyệt |
| **Edit automatically** | Tự sửa file; lệnh ngoài allowlist của project phải chờ duyệt |
| **Auto** | Tự duyệt mọi thao tác qua kiểm tra an toàn; chỉ dừng chờ bạn với lệnh rủi ro cao. Mọi thao tác tự duyệt đều ghi log. **Không phải mặc định**, hãy chỉ bật khi tin tưởng task |

Muốn agent chỉ phân tích, không sửa gì: chọn **Cách làm = Chỉ kế hoạch** (mục 8.1). Từ v0.6, Plan không còn là một mức quyền; task và project cũ đang để Plan được tự chuyển sang "Chỉ kế hoạch" với mức quyền Manual.

**Khi duyệt:**

- **Cho phép** / **Từ chối**. Từ chối có thể kèm **lý do**; lý do được gửi cho Claude để đổi cách làm.
- **Luôn cho phép**: thêm rule vào allowlist của project.
- **Cảnh báo đỏ**: lệnh rủi ro (xoá đệ quy, `git push`, `reset --hard`, tải script về chạy, ghi file ngoài thư mục task…) luôn phải duyệt tay, **không có** "Luôn cho phép" và allowlist không tự duyệt được.
- **Duyệt hàng loạt** các yêu cầu giống hệt nhau ở mục Cần bạn.
- **Preset allowlist** (Node/npm, Python, git chỉ đọc, chỉ đọc file) có sẵn khi sửa project. Preset không chứa lệnh có tác dụng phụ như `npm install`, `git push`.
- **Gợi ý rule**: rule được cho phép ≥ 3 lần trong 30 ngày và chưa bị từ chối sẽ được đề xuất; bấm **Thêm** hoặc **Bỏ qua**.
- Hết thời gian chờ (cấu hình ở Cài đặt → Xin quyền), quyền tự bị từ chối và Claude tiếp tục theo hướng khác.
- Có thể duyệt ngay trên **Telegram** nếu bạn bật (mục 9).

**Khi Claude hỏi lại:**

Claude có thể dừng giữa chừng để hỏi bạn (ví dụ chọn giữa hai cách làm). Thẻ màu xanh **Claude hỏi bạn** hiện câu hỏi và các lựa chọn, ở mọi mức quyền, kể cả Auto.

- Chọn một đáp án (hoặc nhiều, nếu câu hỏi cho phép) hoặc nhập vào ô **Khác**, rồi bấm **Gửi câu trả lời**. Claude chạy tiếp ngay với câu trả lời, không phải chạy lại từ đầu.
- **Bỏ qua** (có thể kèm ghi chú): Claude tự chọn phương án an toàn và ghi rõ giả định trong kết quả. Hết thời gian chờ cũng vậy.
- Trên Telegram, câu hỏi chỉ có một đáp án hiện mỗi lựa chọn thành một nút; câu hỏi khác cần trả lời trên web.

---

## 8. Review kết quả

Mọi task chạy xong đều vào **Review**.

**Xem:** output của Claude, danh sách file thay đổi, diff từng file (unified/side-by-side). Với file `.html` có chế độ **Giao diện** xem trước trang trong vùng cách ly (cổng riêng `PORT + 10`).

**Review từng file:**
- Đánh dấu **Đã xem**, có tiến độ x/y (tự bỏ đánh dấu khi file đổi sau lần chạy mới).
- **Nhận xét theo dòng** (rê chuột vào số dòng, bấm `+`) hoặc cho cả file. Nhận xét lưu nháp trên trình duyệt và được gửi kèm khi **Yêu cầu sửa**.
- File Markdown có 3 chế độ: **Preview** (mặc định), **Diff**, **Edit** (sửa trực tiếp, chỉ khi task ở Review).
- Có thể chạy **lệnh test** của project và xem kết quả ngay trên trang review.

**Quyết định:**

| Nút | Kết quả |
|---|---|
| **Chấp nhận output** | Task sang **Done**. Nếu còn nhận xét chưa gửi, tool sẽ hỏi lại |
| **Merge** (chế độ nhánh riêng, tuỳ chọn) | Merge nhánh task vào nhánh chính. Tool kiểm tra trước: repo đang ở nhánh chính, không có file đã stage, không có file chưa commit trùng file task sửa |
| **Yêu cầu sửa** | Nhập feedback (kèm nhận xét theo dòng); Claude tiếp tục **đúng phiên cũ** (`--resume`), giữ model để tận dụng cache |
| **Từ chối** | Huỷ thay đổi (chế độ nhánh riêng thì xoá worktree/nhánh) |

Việc merge/PR ở chế độ nhánh riêng do bạn quyết định, Task Board không tự merge.

### 8.1 Duyệt kế hoạch (task "Kế hoạch trước" / "Chỉ kế hoạch")

Task có cách làm **Kế hoạch trước** chạy thành 2 lượt:

1. **Lượt Kế hoạch:** agent chỉ đọc code và viết kế hoạch (Hiểu yêu cầu · File sẽ sửa · Các bước · Rủi ro · Câu hỏi còn mở), không sửa file nào, kể cả khi project để mức Auto.
2. Task vào **Review** với nhãn **Duyệt kế hoạch**. Lúc này task không chiếm slot chạy, nên bạn duyệt lúc nào cũng được.
   - **Duyệt và thực hiện**: có thể bấm **Sửa kế hoạch** trước khi duyệt. Task vào hàng đợi, rồi agent chạy tiếp **đúng phiên cũ** theo kế hoạch bạn đã duyệt, với mức quyền của task.
   - **Góp ý**: agent lập lại kế hoạch theo góp ý, vẫn chưa sửa code.
   - **Từ chối**: task sang Failed. Bấm Chạy lại thì agent lập kế hoạch mới.
3. **Lượt Thực hiện** xong thì task vào Review như bình thường.

Task **Chỉ kế hoạch** dừng ở bước 2: kết quả theo đúng định dạng prompt yêu cầu (ví dụ danh sách task, bảng tác động), nút **Chấp nhận kết quả** chuyển task sang Done. Các template phân tích có sẵn (Làm rõ yêu cầu, Phân rã thành task, Phân tích tác động, Kiểm tra theo yêu cầu) tự chọn cách làm này.

**Duyệt qua Telegram:** nếu đã bật Telegram và thông báo Review, bạn nhận tin kèm kế hoạch và nút **Duyệt và thực hiện** (hoặc **Chấp nhận kết quả**). Muốn sửa kế hoạch, góp ý hay từ chối thì làm trên web.

Nên dùng "Kế hoạch trước" cho việc lớn hoặc dễ hiểu sai: sai hướng được phát hiện khi agent mới đọc code, chưa tốn chi phí sửa. Đặt mặc định cho cả project ở trang Projects → **Cách làm mặc định của task mới**.

### 8.2 Mở task trong Claude Code

Khi task làm sai, hoặc bạn muốn tự hỏi đáp thêm với agent, bấm **Mở trong Claude Code** ở đầu trang task (có ở task Review, Failed, và cả task đang chạy hoặc đang chờ, sau khi xác nhận dừng):

- Extension VS Code mở một terminal **đúng thư mục của task** và chạy `claude --resume <phiên của task>`. Agent nhớ đầy đủ những gì đã làm, bạn chat tiếp như bình thường.
- Trong lúc đó task bị **khoá**: không chạy, duyệt hay sửa được, để không có hai tiến trình cùng làm trên một phiên.
- Làm xong, thoát Claude Code hoặc đóng terminal: task tự về **Review**, diff có cả thay đổi bạn làm tay, lịch sử có thêm lượt "Làm tay trong Claude Code" (chi phí phần này không tính được).
- Task khoá quá 12 giờ thì bạn được nhắc một lần (thông báo web và Telegram).
- Mở board bằng trình duyệt ngoài VS Code: nếu sau vài giây không có cửa sổ VS Code nào mở terminal, banner hiện nút **Mở bằng VS Code** và **Sao chép lệnh** để bạn tự chạy. Khi đó, làm xong thì bấm **Đưa về Review**.

Hỗ trợ task chạy bằng Claude và Codex. Project dùng **API key**: phiên tương tác dùng đăng nhập Claude Code trên máy, không dùng key của Task Board.

---

## 9. Cài đặt

| Mục | Nội dung |
|---|---|
| **Ngôn ngữ** | Tiếng Việt / English (trong VS Code mặc định theo VS Code) |
| **Thực thi** | Số task chạy song song toàn hệ thống (mặc định 2, tối đa 5), model mặc định, bật/tắt tự nâng model khi lỗi |
| **Xác thực Claude** | Chọn đăng nhập Claude Code hoặc API key |
| **Xin quyền** | Thời gian tự từ chối khi bạn không phản hồi |
| **Thông báo** | Thông báo trình duyệt khi task sang Review / Needs Input / Failed; Telegram (Bot token, Chat ID, địa chỉ giao diện cho liên kết mở task) |
| **Template prompt** | Tạo prompt dùng lại (Fix bug, Viết test, Refactor…), có thể chỉ định model |
| **Lên lịch task (cron)** | Tự tạo task theo lịch |
| **Hệ thống** | Thông tin phiên bản, môi trường |

**Telegram (tuỳ chọn):** tạo bot với BotFather, dán Bot token, nhắn `/start` cho bot rồi nhập Chat ID (số, nhóm bắt đầu bằng `-100`, hoặc `@tenkenh`). Chỉ callback từ đúng chat đã cấu hình mới được nhận.

**Lưu ý API key:** key nhập trong giao diện được mã hoá AES-256-GCM trước khi lưu và không bao giờ trả ra API hay ghi log. Mất `data/secret.key` thì phải nhập lại key. Nên đặt spend limit trong Claude Console.

---

## 10. Chi phí và budget

- Mỗi project có thể đặt **budget tháng (USD)**.
- Cảnh báo ở mức **80%** và **100%**, mỗi mức một lần mỗi tháng (thông báo web, và Telegram nếu bật).
- Hành động khi vượt: **Chỉ cảnh báo** (mặc định) hoặc **Tạm dừng**. Tạm dừng nghĩa là không chạy task mới của project (task đang chạy được chạy xong), tự chạy lại khi sang tháng. Khi đã ≥ 80% budget, tool không tự nâng model quá Sonnet.
- Ở chế độ API key, budget là **giới hạn cứng**; mỗi lần chạy có trần `--max-budget-usd` bằng phần budget còn lại.
- Trang **Projects** hiện thanh chi tiêu/budget; trang **Thống kê** hiện chi phí theo model và dự báo cuối tháng.
- Mọi số tiền là **ước tính theo giá niêm yết**. Gói Pro/Max không bị trừ tiền theo con số này.
- Chi phí mỗi lần chạy là của **riêng** lần đó. Khi chạy tiếp phiên cũ (Yêu cầu sửa, Tiếp tục), Claude CLI báo tổng cộng dồn của cả phiên; tool trừ phần của các lần trước để không tính trùng.

---

## 11. Truy cập từ xa và môi trường

### 11.1 Truy cập từ điện thoại/máy khác (Tailscale)

Mặc định backend chỉ nghe `127.0.0.1` và không cần đăng nhập. Muốn truy cập từ xa, dùng [Tailscale](https://tailscale.com) và **bắt buộc đặt token đăng nhập**:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"   # tạo token
$env:REMOTE_HOST = "100.x.y.z"            # IP Tailscale của máy chạy tool (tailscale ip -4)
$env:TASKBOARD_AUTH_TOKEN = "<token>"     # ≥ 16 ký tự
npm start
```

Trên thiết bị khác mở `http://100.x.y.z:3000` và nhập token. Cookie đăng nhập có hiệu lực 30 ngày; nhập sai 10 lần trong 15 phút sẽ bị khoá tạm. Muốn HTTPS dùng `tailscale serve --bg 3000`. **Không** dùng `tailscale funnel` (mở ra Internet công cộng). Nếu cần xem trước HTML từ xa, mở thêm cổng `PORT + 10`.

### 11.2 Môi trường DEV và UAT

| | DEV | UAT |
|---|---|---|
| Mục đích | Phát triển, hot reload | Kiểm thử bản build ổn định |
| URL | http://localhost:3000 | http://127.0.0.1:4000 |
| Dữ liệu | `data/` | `../AI-Interface-uat/data/` (riêng biệt) |

```bash
npm run uat:deploy                      # deploy nhánh main
npm run uat:deploy -- claude/task-12    # test riêng nhánh của một task
npm run uat:copy-db                     # chép dữ liệu DEV sang UAT
npm run uat:status | uat:logs | uat:stop | uat:start | uat:restart
```

UAT chỉ nhận code **đã commit** và không tự bật lại sau khi khởi động lại máy (chạy `npm run uat:start`).

---

## 12. Dữ liệu và bảo mật

- Dữ liệu nằm ở `data/taskboard.db` (SQLite), `data/runs/<runId>.jsonl` (output gốc từng lần chạy) và `data/attachments/<id task>/` (file đính kèm). Thư mục `data/` không được commit. Khởi động lại không làm mất task và log.
- Code được gửi tới Anthropic **thông qua Claude Code** theo tài khoản hoặc API key của bạn. Tool không gửi dữ liệu đi nơi khác (Telegram chỉ khi bạn bật).
- Tool bỏ `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` có sẵn trong môi trường, chỉ dùng key bạn chọn, để không tính tiền nhầm tài khoản.
- Biến môi trường hữu ích: `TASKBOARD_ANTHROPIC_API_KEY`, `TASKBOARD_DEFAULT_AUTH_MODE` (`apiKey`/`subscription`), `TASKBOARD_SECRET_KEY`, `REMOTE_HOST`, `TASKBOARD_AUTH_TOKEN`, `PORT`, `PREVIEW_PORT`, `CLAUDE_BIN`.

---

## 13. Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| Không tìm thấy Claude CLI | Cài extension Claude Code hoặc CLI `claude`; đặt `CLAUDE_BIN` (web) hoặc `agentTaskBoard.claudePath` (extension) |
| Chưa đăng nhập Claude | Chạy lệnh **Agent Task Board: Đăng nhập Claude Code** hoặc `claude auth login` |
| Task không chạy dù đã Queued | Kiểm tra số task song song tối đa, task đang chờ task khác (Chờ task), hoặc project đã bị **tạm dừng** do vượt budget |
| Task kẹt ở Needs Input | Vào **Cần bạn** để duyệt; task ở Needs Input vẫn chiếm slot |
| Báo giới hạn sử dụng (rate limit) | Chờ hết hạn mức của gói hoặc giảm số task song song |
| Không merge được | Đảm bảo repo chính đang ở nhánh chính, không có file đã stage, không trùng file chưa commit với task |
| Không xem trước được HTML từ xa | Mở cổng `PORT + 10` trong Firewall/Tailscale ACL |
| Phím tắt sao chép/dán lỗi trong VS Code | Giới hạn của webview; dùng **Mở trong trình duyệt** (khi import, chọn file thay vì dán) |
| Import báo thiếu cột hoặc chữ lỗi font | Kiểm tra dòng đầu có cột `title`/`Tiêu đề` và `prompt`/`Mô tả`; đổi **Mã hoá**, hoặc lưu lại thành `.xlsx` / CSV UTF-8 |
| Dùng VS Code Remote (SSH/WSL) | Server chạy trên máy remote; xem trước HTML chưa chuyển tiếp cổng phụ |

---

## 14. Tài liệu liên quan

[README](../README.md) · [SPEC](SPEC.md) · [Môi trường DEV/UAT](ENVIRONMENTS.md) · [Kế hoạch](PLAN.md) · [README extension](../vscode-extension/README.vi.md)
