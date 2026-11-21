# ĐỀ XUẤT TÍNH NĂNG MỚI: Claude Task Board

| Mục | Giá trị |
|---|---|
| Ngày | 2026-11-19 |
| Trạng thái | ✅ **F1, F2 đã triển khai** (2026-11-21, SPEC FR-65, FR-66; spike F1-S1/S2 ở P0-SPIKE.md). F3–F7 vẫn là đề xuất chờ duyệt |
| Phạm vi | Các tính năng **chưa có** trong code và chưa có spec. Các hạng mục đã có spec được liệt kê ở mục 2 để tránh trùng |
| Liên quan | [SPEC.md](SPEC.md), [PLAN.md](PLAN.md), [BACKLOG.md](BACKLOG.md), [SPEC-PLAN-HANDOFF.md](SPEC-PLAN-HANDOFF.md), [SPEC-SCHEDULED-PUBLISH.md](SPEC-SCHEDULED-PUBLISH.md), [SPEC-MULTI-AGENT.md](SPEC-MULTI-AGENT.md), [SPEC-IMPORT.md](SPEC-IMPORT.md) |

---

## 1. Tóm tắt

Task Board đã có đủ luồng cơ bản: giao task, chạy, Review, Needs Input, budget, chọn model, đa agent, import hàng loạt, lên lịch. Các điểm thiếu hiện nay nằm ở **đầu vào của task** (không đính kèm được tài liệu, ảnh), **quản lý danh sách task khi lớn dần** (không lưu trữ, không nhân bản, không có bộ lọc đã lưu), **trao đổi trên task** (chỉ có ghi chú review theo dòng, không có thread chung), và **kiểm soát chi phí trước khi chạy**.

Đề xuất 7 tính năng, xếp theo ưu tiên:

| # | Tính năng | Giải quyết | Ưu tiên | Ước lượng |
|---|---|---|---|---|
| F1 | Đính kèm tài liệu và ảnh vào task | Claude thiếu mockup, log lỗi, file spec khi chạy | **High** | 2 ngày |
| F2 | Nhân bản task và chạy lại với prompt đã sửa | Phải gõ lại task tương tự nhiều lần | **High** | 0.5 ngày |
| F3 | Ước tính chi phí và thời gian trước khi chạy | Chỉ biết chi phí sau khi đã chạy | Normal | 1 ngày |
| F4 | Lưu trữ task và dọn dữ liệu run | Board dài dần, `data/runs/` phình to | Normal | 1 ngày |
| F5 | Checklist trong task | Task lớn không chia được việc nhỏ ngoài phụ thuộc | Normal | 1.5 ngày |
| F6 | Trao đổi trên task (ghi chú chung) | Ghi chú người dùng để lại chỉ có ở Review, không lưu theo task | Low | 1 ngày |
| F7 | Bộ lọc đã lưu và chế độ xem theo người dùng | Phải chọn lại bộ lọc mỗi lần mở Board | Low | 0.5 ngày |

Tổng ước lượng: khoảng **7.5 ngày** (nếu làm hết). Nên làm F1 và F2 trước, vì hai tính năng này trực tiếp làm task tốt hơn và ít rủi ro.

---

## 2. Đã có spec, không đề xuất lại

Các hạng mục dưới đây đã được nêu trong tài liệu hiện có. Đề xuất này không thay đổi chúng.

| Hạng mục | Tài liệu | Trạng thái |
|---|---|---|
| Duyệt kế hoạch trước khi sửa code (W1) | [SPEC-PLAN-HANDOFF.md](SPEC-PLAN-HANDOFF.md) FR-100..106 | Chờ duyệt |
| Mở task trong phiên Claude Code tương tác (W5) | [SPEC-PLAN-HANDOFF.md](SPEC-PLAN-HANDOFF.md) FR-110..116 | Chờ duyệt |
| Task định kỳ tự tạo output và đăng ra kênh ngoài | [SPEC-SCHEDULED-PUBLISH.md](SPEC-SCHEDULED-PUBLISH.md) FR-90..99 | Chờ duyệt |
| Chạy bằng nhiều agent (Codex, Antigravity, Cursor) | [SPEC-MULTI-AGENT.md](SPEC-MULTI-AGENT.md) | Đang làm |
| Import CSV / Excel | [SPEC-IMPORT.md](SPEC-IMPORT.md) | Đã triển khai |
| Budget theo project, chọn model tự động, duyệt quyền, Telegram, thống kê, template, tag | [SPEC.md](SPEC.md), [PLAN.md](PLAN.md) P4–P7 | Đã làm hoặc đã lập kế hoạch |

---

## 3. Chi tiết từng tính năng

### F1. Đính kèm tài liệu và ảnh vào task

**Vấn đề.** Khi giao việc như "làm trang theo mockup này" hoặc "sửa lỗi theo log này", người dùng phải dán nội dung dài vào prompt hoặc để file ở chỗ khác rồi gõ đường dẫn. Ảnh chụp màn hình gần như không đưa vào được. Claude Code CLI đọc được ảnh và PDF nếu được cung cấp đường dẫn, nên đây là khoảng trống dễ lấp.

**Mô tả.**
- Trong form tạo/sửa task (`TaskFormModal.tsx`) và trong thẻ chi tiết (`TaskPanel.tsx`), thêm mục **Tệp đính kèm**: kéo thả hoặc chọn file, có xem trước ảnh.
- Các loại file được phép: `png`, `jpg`, `webp`, `pdf`, `md`, `txt`, `csv`, `json`, `log`. Mỗi file tối đa 10 MB, mỗi task tối đa 20 file hoặc 50 MB tổng.
- File được lưu vào `data/attachments/<taskId>/` (không commit, giống `data/`). Không ghi file vào thư mục project của người dùng.
- Khi chạy, runner thêm vào prompt một khối liệt kê file kèm đường dẫn tuyệt đối, ví dụ: `Tài liệu đính kèm (đọc khi cần): <đường dẫn>`. Claude đọc bằng công cụ Read có sẵn.
- Khi Request changes hoặc Retry, file đính kèm được giữ nguyên. Người dùng có thể thêm hoặc xoá file ở bước đó.
- Trên thẻ task có biểu tượng số lượng file. Trong Review, người dùng mở được file đính kèm.

**Tiêu chí chấp nhận (đề xuất AC-A1..A5).**
- **A1.** Tải lên file `png` 2 MB và `pdf` 5 MB thành công, hiện trong danh sách, tải lại trang vẫn còn.
- **A2.** Tải file `.exe` hoặc file vượt 10 MB bị từ chối, có thông báo lý do. Tên file có ký tự `..` hoặc `/` được làm sạch, không thoát khỏi thư mục đính kèm.
- **A3.** Task chạy có file đính kèm: prompt gửi đi chứa đường dẫn đúng. Claude mở được file (kiểm tra bằng một task thử đọc ảnh và trả lời nội dung).
- **A4.** Xoá task thì thư mục đính kèm cũng bị xoá. Xoá một file thì file đó không còn trong prompt của lần chạy sau.
- **A5.** Mode Auto không tự duyệt việc đọc file ngoài thư mục project mà không qua kiểm tra. Cần kiểm chứng bằng spike F1-S1 (mục 4).

**Rủi ro và lưu ý.**
- Claude Code có thể hỏi quyền đọc file nằm ngoài thư mục làm việc. Nếu vậy, cần thêm đường dẫn `data/attachments` vào danh sách được phép, và chỉ cho đúng thư mục đó, không rộng hơn.
- Nội dung file đính kèm là dữ liệu không đáng tin. Nếu một file chứa lệnh giả mạo (prompt injection), Claude có thể làm theo. Cần ghi chú trong UI và trong prompt rằng file chỉ là tài liệu tham khảo, không phải chỉ dẫn hệ thống.
- Không đưa file đính kèm vào log `runs/*.jsonl` dưới dạng nội dung đầy đủ. Chỉ ghi tên và kích thước.

**Ước lượng.** 2 ngày (backend 1, web 0.5, kiểm thử 0.5).

---

### F2. Nhân bản task và chạy lại với prompt đã sửa

**Vấn đề.** Các task tương tự nhau (ví dụ "viết test cho module X", "viết test cho module Y") phải tạo lại từ đầu. Template (FR-06) giúp điền prompt, nhưng không giữ được model, mức quyền, project, tag và phụ thuộc đã chọn cho một task cụ thể. Với task đã Failed hoặc đã Done, người dùng cũng không có cách nhanh để tạo bản mới có sửa đổi.

**Mô tả.**
- Thêm nút **Nhân bản** trên thẻ và trong thẻ chi tiết. Bản sao nằm ở cột Backlog, tiêu đề thêm hậu tố "(bản sao)", giữ nguyên prompt, project, model đã chọn, mức quyền, tag, cách giao output và file đính kèm (nếu có F1).
- Không sao chép: lịch sử run, kết quả, diff, quyền đã duyệt, phụ thuộc đang trỏ tới task khác (người dùng chọn lại).
- Mở form sửa ngay sau khi nhân bản để người dùng chỉnh prompt.
- Thêm nút **Chạy lại với prompt mới** cho task Done hoặc Failed. Thao tác này nhân bản rồi đưa bản mới vào Queued, không ghi đè lịch sử cũ.

**Tiêu chí chấp nhận (đề xuất AC-B1..B4).**
- **B1.** Nhân bản task Done có model `opus`, mode `auto`, tag `[backend]`: bản sao giữ đúng ba thuộc tính đó, trạng thái là Backlog, không có kết quả cũ.
- **B2.** Nhân bản task có phụ thuộc vào task khác: bản sao không tự phụ thuộc. Người dùng thấy thông báo nhắc chọn lại.
- **B3.** Chạy lại task Failed: bản mới chạy được, task cũ vẫn ở Failed với đầy đủ log.
- **B4.** Nhân bản không làm thay đổi task gốc (kiểm tra cả `updatedAt`, trừ khi có thao tác khác).

**Ước lượng.** 0.5 ngày.

---

### F3. Ước tính chi phí và thời gian trước khi chạy

**Vấn đề.** Budget (P6) chặn việc chạy khi vượt hạn mức, nhưng người dùng không biết một task sẽ tốn bao nhiêu trước khi bấm chạy. Trang Stats chỉ có số liệu quá khứ. Với gói Pro/Max, người dùng cũng khó biết task này chiếm bao nhiêu phần hạn mức 5 giờ.

**Mô tả.**
- Khi người dùng chọn model và mức quyền, hiển thị **khoảng ước tính** (ví dụ "khoảng $0.40–$1.10, khoảng 4–9 phút").
- Ước tính dựa trên lịch sử các run cùng model và cùng tag (cột `model_usage` đã lưu theo run từ P5-01), lấy phân vị 50 và 90. Nếu chưa đủ dữ liệu (dưới 5 run), hiển thị "chưa đủ dữ liệu" và dùng bảng giá niêm yết để tính chi phí theo số token ước đoán từ độ dài prompt.
- Ghi rõ đây là ước lượng theo giá niêm yết, không phải số tiền thực trả với gói đăng nhập Claude Code (nhất quán với rủi ro đã nêu trong SPEC mục 9).
- Hiển thị ước tính trong hộp xác nhận khi bấm "Chạy ngay" với task có budget gần ngưỡng 80%.

**Tiêu chí chấp nhận (đề xuất AC-C1..C3).**
- **C1.** Với dưới 5 run lịch sử cùng model, UI hiện "chưa đủ dữ liệu", không hiện số giả.
- **C2.** Với ≥ 5 run, khoảng ước tính chứa chi phí thực của ít nhất 80% các run trong bộ kiểm thử (kiểm chứng trên dữ liệu thật của repo).
- **C3.** Khi project đã dùng ≥ 80% budget và task ước tính vượt phần còn lại, hộp xác nhận hiện cảnh báo. Không chặn cứng (việc chặn vẫn do P6 đảm nhiệm).

**Ước lượng.** 1 ngày.

**Câu hỏi mở.** Có nên đưa ước tính vào bước chọn model (`modelPicker`) để gợi ý model rẻ hơn khi chi phí dự kiến cao không? Đề xuất: để sau, làm sau khi F3 chạy ổn định.

---

### F4. Lưu trữ task và dọn dữ liệu run

**Vấn đề.** Sau vài tháng, cột Done và Failed có hàng trăm thẻ, làm chậm bảng và khó tìm. Thư mục `data/runs/` lưu toàn bộ output gốc (`*.jsonl`) của mọi run và không được dọn tự động. Hiện chưa có cơ chế nào để giữ board gọn mà vẫn giữ được lịch sử.

**Mô tả.**
- Thêm trạng thái ẩn **Đã lưu trữ** (archived), không phải cột mới. Task lưu trữ không hiện trên Board mặc định, có bộ lọc "Hiện task đã lưu trữ".
- Tự động lưu trữ task Done sau N ngày (mặc định 30, cấu hình ở Settings, `0` = tắt). Task Failed và Needs Input không tự lưu trữ.
- Có nút **Lưu trữ** và **Khôi phục** thủ công.
- Dọn file run: với task đã lưu trữ, nén `data/runs/<runId>.jsonl` thành `.jsonl.gz` sau M ngày (mặc định 90). Metadata (kết quả, chi phí, model, diff) luôn giữ trong SQLite, không nén.
- Thống kê (Stats) có tuỳ chọn tính cả task đã lưu trữ.

**Tiêu chí chấp nhận (đề xuất AC-D1..D4).**
- **D1.** Task Done 31 ngày, cài đặt 30 ngày: sau lần quét tự động, task ở trạng thái lưu trữ và không hiện trên Board mặc định.
- **D2.** Khôi phục một task lưu trữ: task trở lại cột Done, kết quả và diff còn nguyên.
- **D3.** Sau nén, mở log của một run cũ vẫn xem được (giải nén khi đọc). Không mất dữ liệu nào trong bảng SQLite.
- **D4.** Task Done đang có phụ thuộc từ task khác (chưa Done) không bị lưu trữ tự động.

**Rủi ro.** Lưu trữ nhầm task còn cần xem lại. Giảm thiểu: cài đặt mặc định tắt cho đến khi người dùng bật, và có cửa sổ khôi phục.

**Ước lượng.** 1 ngày.

---

### F5. Checklist trong task

**Vấn đề.** Một task lớn như "thêm đăng nhập OAuth" có nhiều bước, nhưng hiện chỉ có một prompt và một kết quả. Người dùng không thấy tiến độ bên trong task khi task đang chạy, và không thể đánh dấu các bước đã xong khi Request changes. Phụ thuộc giữa task (FR-08) chỉ phù hợp khi các bước là task độc lập.

**Mô tả.**
- Trong thẻ chi tiết, thêm danh sách checklist (mỗi mục là một dòng văn bản, có trạng thái chưa xong hoặc đã xong).
- Khi chạy, checklist được đưa vào prompt dưới dạng danh sách, và Claude được yêu cầu cập nhật trạng thái bằng một dòng đánh dấu trong kết quả, ví dụ `[x] Bước 2`. Task Board đọc dòng này từ output để tick tự động.
- Khi Request changes, chỉ các mục chưa xong được gửi lại cho Claude, kèm ghi chú của người dùng.
- Trên thẻ Board, hiện tiến độ dạng `3/5`.
- Không tự chia task thành nhiều task. Checklist luôn thuộc một task.

**Tiêu chí chấp nhận (đề xuất AC-E1..E4).**
- **E1.** Thêm 4 mục, tick 2 mục, reload trang: trạng thái giữ nguyên, thẻ hiện `2/4`.
- **E2.** Claude đánh dấu `[x] Bước 1` trong output: mục tương ứng tự tick. Dòng không khớp mục nào thì bỏ qua, không gây lỗi.
- **E3.** Request changes: prompt mới chỉ liệt kê mục chưa xong, không liệt kê mục đã xong.
- **E4.** Task không có checklist chạy như hiện tại (không đổi hành vi).

**Rủi ro.** Claude có thể đánh dấu sai hoặc quên đánh dấu. Checklist chỉ là chỉ báo tiến độ, không phải điều kiện để Done. Trạng thái Done vẫn do người dùng duyệt ở Review.

**Ước lượng.** 1.5 ngày.

---

### F6. Trao đổi trên task (ghi chú chung)

**Vấn đề.** Ghi chú hiện có ở Review gắn với dòng của diff và chỉ tồn tại trong lúc review. Khi người dùng muốn ghi "chờ anh A xác nhận API trước khi làm bước này" hoặc "đã trao đổi qua điện thoại, đổi yêu cầu thành…", chưa có chỗ để ghi lại trên task. Thông tin này nằm rải rác ở Telegram hoặc ghi chú bên ngoài.

**Mô tả.**
- Thêm mục **Ghi chú** trong thẻ chi tiết: danh sách ghi chú theo thứ tự thời gian, có tác giả (một người dùng, nên chỉ ghi thời gian), hỗ trợ Markdown cơ bản.
- Ghi chú không tự gửi cho Claude. Người dùng có tuỳ chọn **Đưa vào lần chạy tiếp theo**, khi đó ghi chú được gắn vào prompt của Request changes hoặc Retry.
- Ghi chú hiện trong lịch sử task, cùng thời điểm với các sự kiện run.

**Tiêu chí chấp nhận (đề xuất AC-F1..F3).**
- **F1.** Thêm và sửa ghi chú, reload vẫn còn. Xoá task thì ghi chú cũng bị xoá.
- **F2.** Ghi chú được đánh dấu "đưa vào lần chạy tiếp theo" xuất hiện trong prompt của lần chạy kế tiếp đúng một lần, không lặp lại ở lần sau.
- **F3.** Ghi chú không được thực thi như lệnh hoặc chèn vào shell. Chỉ là văn bản trong prompt.

**Ước lượng.** 1 ngày.

**Câu hỏi mở.** Có cần nhiều người dùng và tên tác giả không? Hiện tại không (ngoài phạm vi v1 theo SPEC mục 1.3), nên đề xuất giữ đơn giản.

---

### F7. Bộ lọc đã lưu và chế độ xem theo người dùng

**Vấn đề.** Bộ lọc hiện tại (`BoardFilters.tsx`, `taskFilter.ts`) bị reset khi tải lại trang. Người dùng dùng lặp lại một số bộ lọc như "Project A, chưa Done, tag backend" nhưng phải chọn lại mỗi lần.

**Mô tả.**
- Nút **Lưu bộ lọc** đặt tên, ví dụ "Sprint này". Bộ lọc đã lưu hiện trong sidebar hoặc menu lệnh (Command Palette đã có).
- Lưu trên server (một bảng nhỏ trong SQLite), không dùng `localStorage`, để giữ được khi đổi trình duyệt. Hiện chỉ có một người dùng, nên không cần phân quyền.
- Có bộ lọc mặc định khi mở Board (tuỳ chọn).

**Tiêu chí chấp nhận (đề xuất AC-G1..G2).**
- **G1.** Lưu bộ lọc "Sprint này", đổi bộ lọc khác, bấm bộ lọc đã lưu: Board trở về đúng bộ lọc đó.
- **G2.** Xoá bộ lọc không ảnh hưởng đến task.

**Ước lượng.** 0.5 ngày.

---

## 4. Spike cần làm trước

| Mã | Câu hỏi | Cách kiểm chứng | Ảnh hưởng |
|---|---|---|---|
| F1-S1 | Claude Code (`claude -p`) có đọc được ảnh `png` và `pdf` khi cung cấp đường dẫn ngoài thư mục làm việc không? Có hỏi quyền không, và `--add-dir` có đủ không? | Chạy một task thử, đọc ảnh đặt trong `data/attachments/` | F1 (A3, A5) |
| F1-S2 | Mode Auto có tự duyệt việc đọc file ngoài thư mục project không? | Cùng task thử, mode Auto | F1 (A5) |
| F3-S1 | Thu thập dữ liệu thật từ `model_usage` để kiểm chứng khoảng ước tính có chứa ít nhất 80% các run không | Truy vấn cột `model_usage` của bảng runs trong `data/taskboard.db` | F3 (C2) |

Spike làm trước khi viết code. Mỗi spike ghi kết quả vào mục riêng trong [P0-SPIKE.md](P0-SPIKE.md) hoặc tài liệu tính năng tương ứng.

---

## 5. Thứ tự đề xuất

```
F2 (nhân bản, 0.5 ngày)   ──┐
F1-S1, F1-S2 (spike)      ──┤
F1 (đính kèm, 2 ngày)     ──┼──> F4 (lưu trữ, 1 ngày) ──> F7 (bộ lọc đã lưu, 0.5 ngày)
F3-S1 (spike)             ──┘
F3 (ước tính, 1 ngày)     ──> cân nhắc gợi ý model theo chi phí (sau này)
F5 (checklist, 1.5 ngày)  ──> F6 (ghi chú, 1 ngày)
```

- **Đợt 1 (3 ngày):** F2, F1 (kèm spike), F3.
- **Đợt 2 (2.5 ngày):** F4, F5.
- **Đợt 3 (1.5 ngày):** F6, F7.

Các đợt có thể đổi thứ tự. F2 và F1 không phụ thuộc nhau, nhưng F2 nên có hỗ trợ file đính kèm nếu F1 đã xong.

---

## 6. Câu hỏi cần chủ dự án chốt

1. **F1:** Có chấp nhận lưu file đính kèm trong `data/attachments/` (không commit) không, hay muốn lưu trong thư mục project để Claude đọc tự nhiên hơn? Đề xuất: `data/attachments/`, vì không làm bẩn repo.
2. **F4:** Ngưỡng mặc định lưu trữ tự động là 30 ngày và nén log là 90 ngày có phù hợp không? Hay tắt hẳn tính năng tự động và chỉ làm lưu trữ thủ công?
3. **F5:** Có muốn Claude tự tick checklist từ output, hay chỉ hiển thị để người dùng tự tick? Đề xuất: Claude tick, người dùng có thể sửa tay.
4. **F6:** Có cần ghi chú chung ngay không, hay để đến khi có nhiều người dùng?
5. **Thứ tự:** Có muốn ưu tiên một tính năng nào lên trước các đề xuất khác trong [SPEC-PLAN-HANDOFF.md](SPEC-PLAN-HANDOFF.md) không?

---

## 7. Phê duyệt

| Vai trò | Họ tên | Quyết định | Ngày |
|---|---|---|---|
| Chủ dự án | | ☐ Duyệt toàn bộ · ☐ Duyệt một phần (ghi rõ F#) · ☐ Từ chối | |

Sau khi duyệt: gộp các tính năng được chọn vào [SPEC.md](SPEC.md) (cập nhật mục 3 và 8), lập task P10-xx trong [PLAN.md](PLAN.md) và [backlog.json](backlog.json).
