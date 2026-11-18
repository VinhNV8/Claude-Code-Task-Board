# SPEC bổ sung: Import task từ CSV / Excel

| Mục | Giá trị |
|---|---|
| Mã yêu cầu | **FR-01a** (mở rộng FR-01 Tạo task) |
| Ngày | 2026-11-18 |
| Trạng thái | ✅ **Đã duyệt và triển khai 2026-11-18**: làm cả CSV và `.xlsx`; QI2–QI7 theo đề xuất mặc định. Test: `server/src/taskImport.test.ts` (AC-14..21) |
| Đã gộp | [SPEC.md](SPEC.md) bản 0.5: mục 3.1, 5.3, 8 |

---

## 0. Yêu cầu gốc (nguyên văn)

> Thêm tính năng import task từ csv/excel -> hãy đánh giá vừa đưa đề xuất. Chú ý việc spec trước khi viết code

---

## 1. Đánh giá

### 1.1 Có nên làm không
**Nên làm.** Hiện tạo nhiều task chỉ có 2 cách: mở form từng task, hoặc chạy `npm run seed:backlog` (chỉ đọc `docs/backlog.json`, phải dùng dòng lệnh). Danh sách việc thường đã có sẵn trong Excel, Google Sheets hoặc xuất từ Jira/Trello ra CSV. Import giúp chuyển cả danh sách lên board trong một lần.

### 1.2 Điểm có sẵn để dùng lại
| Có sẵn | Ở đâu | Dùng cho import |
|---|---|---|
| Kiểm tra dữ liệu task (`validateTask`) | `server/src/routes.ts` | Kiểm tra từng dòng, cùng thông báo lỗi như form |
| Kiểm tra tag, phụ thuộc, vòng tròn | `tags.ts`, `taskDeps.ts` (`validateDeps`, `findCycle`) | Cột tag, cột phụ thuộc |
| Chuẩn hoá model (`normalizeModel`) | `model.ts` | Cột model |
| Bỏ qua task trùng tiêu đề | `scripts/seed-backlog.mjs` | Cùng quy tắc chống trùng |

### 1.3 Rủi ro chính cần xử lý trong spec
| # | Rủi ro | Hậu quả nếu bỏ qua |
|---|---|---|
| R1 | **Excel trên Windows tiếng Việt lưu CSV bằng dấu `;`** (vì dấu thập phân là `,`) và **không phải UTF-8** (trừ khi chọn "CSV UTF-8") | Cả file thành 1 cột, hoặc tiếng Việt bị lỗi font |
| R2 | Import thẳng vào **Hàng đợi** | 50 task tự chạy cùng lúc, hết hạn mức gói Claude |
| R3 | File của người khác có cột mức quyền `auto` | Claude tự chạy lệnh không cần duyệt theo prompt người khác viết |
| R4 | Import lỗi giữa chừng | Board có một nửa số task, chạy lại thì bị trùng |
| R5 | Thư viện đọc Excel: bản `xlsx` (SheetJS) trên npm đã ngừng cập nhật từ 0.18.5 và có lỗ hổng đã công bố | Kéo dependency có lỗ hổng vào dự án |
| R6 | `taskDeps.set` tự mở `BEGIN`, gọi trong transaction lớn sẽ lỗi lồng transaction | Không làm được import "tất cả hoặc không" |

---

## 2. Đề xuất

### 2.1 Luồng người dùng
```
Board ─► nút "Import" ─► chọn file (.csv / .xlsx) hoặc dán từ Excel
      ─► Xem trước: bảng các dòng, mỗi dòng ✅ hợp lệ / ⚠️ trùng / ❌ lỗi (kèm lý do)
      ─► Chọn: project mặc định, trùng thì [Bỏ qua | Vẫn tạo], trạng thái [Backlog | Hàng đợi]
      ─► "Tạo N task" ─► thông báo kết quả, board cập nhật realtime
```

### 2.2 Kiến trúc: đọc file ở trình duyệt, kiểm tra ở server
| Bước | Ở đâu | Lý do |
|---|---|---|
| Đọc file → mảng dòng (`rows`) | **Web** | Không cần upload multipart; file không rời máy; chạy được trong webview của extension VS Code |
| Kiểm tra từng dòng (`dryRun: true`) | **Server** | Một nơi kiểm tra duy nhất, dùng lại `validateTask`; web không phải viết lại quy tắc |
| Tạo task (`dryRun: false`) | **Server**, trong 1 transaction | Tất cả hoặc không (R4) |

Thư viện Excel chỉ nạp khi người dùng chọn file `.xlsx` (dynamic `import()`), không làm nặng bundle chính. Đề xuất **`read-excel-file`** (nhỏ, MIT, chỉ đọc `.xlsx`, chạy trên trình duyệt), ghim phiên bản cụ thể lúc cài. Không dùng `xlsx` trên npm (R5). CSV tự viết parser nhỏ theo RFC 4180, không cần thư viện.

### 2.3 Định dạng file

**Cột** (dòng đầu là tiêu đề; không phân biệt hoa thường, dấu, khoảng trắng; nhận cả tên tiếng Việt và tiếng Anh):

| Cột | Tên nhận được | Bắt buộc | Giá trị |
|---|---|---|---|
| Tiêu đề | `title`, `tiêu đề`, `tên task` | ✅ | Chuỗi không rỗng |
| Mô tả | `prompt`, `mô tả`, `description` | ✅ | ≥ 10 ký tự (như form) |
| Mã | `key`, `code`, `mã` | | Mã riêng trong file (vd `P2-01`) để dòng khác tham chiếu. Không lưu vào task, chỉ dùng lúc import |
| Phụ thuộc | `depends_on`, `chờ task`, `phụ thuộc` | | Danh sách cách nhau bởi `,` hoặc `;`: `#12` (task đã có) hoặc mã của dòng khác trong file |
| Project | `project` | | Tên hoặc id project. Trống: dùng project chọn trên hộp thoại |
| Ưu tiên | `priority`, `ưu tiên` | | `urgent/high/normal/low` hoặc `khẩn/cao/thường/thấp`. Trống: `normal` |
| Tag | `tags`, `tag` | | Cách nhau bởi `,` hoặc `;` |
| Model | `model` | | `auto/haiku/sonnet/opus` hoặc ID `claude-…`. Trống: kế thừa |
| Mức quyền | `permission_mode`, `mức quyền` | | `manual/acceptEdits/plan/auto`. Trống: mặc định của project |
| Giới hạn chi phí | `max_cost_usd` | | Số > 0. Nhận cả `1,5` và `1.5` |

Cột không nhận ra thì bỏ qua và liệt kê ở màn xem trước. Thiếu cột bắt buộc thì báo lỗi ngay, không gửi lên server.

**Đọc CSV (xử lý R1):**
- Tự nhận dấu phân cách `,` `;` hoặc Tab theo dòng tiêu đề.
- Mã hoá: đọc UTF-8 (có hoặc không BOM) ở chế độ nghiêm ngặt. Không hợp lệ thì thử `windows-1258` và hiện cảnh báo kèm ô chọn mã hoá (UTF-8 / Windows-1258 / Windows-1252) để người dùng đổi nếu chữ vẫn sai.
- Hỗ trợ ô có xuống dòng và dấu `"` trong ngoặc kép (prompt nhiều dòng), CRLF/LF.
- Bỏ dòng trống hoàn toàn.

**Excel:** chỉ `.xlsx`, đọc **sheet đầu tiên**. Không hỗ trợ `.xls` cũ, công thức lấy giá trị đã tính, ô gộp không hỗ trợ.

**Dán từ Excel/Google Sheets:** ô dán nhận dữ liệu dạng Tab (khi copy vùng ô), xử lý như CSV có dấu Tab. Cách này không cần chọn file và không gặp R1.

**Tải file mẫu:** nút "Tải file mẫu" tạo `task-import-mau.csv` (UTF-8 có BOM để Excel mở đúng tiếng Việt), gồm dòng tiêu đề và 2 dòng ví dụ, trong đó dòng 2 chờ dòng 1.

### 2.4 Quy tắc import
| # | Quy tắc |
|---|---|
| I1 | **Mặc định tạo ở Backlog** (R2). Chọn "Đưa vào hàng đợi" phải xác nhận: "N task sẽ tự chạy theo thứ tự, tối đa `max_parallel` task cùng lúc". Thứ tự vào hàng đợi theo thứ tự dòng trong file |
| I2 | **Tất cả hoặc không** (R4): còn dòng lỗi thì nút Tạo bị khoá. Người dùng bỏ tick dòng lỗi để import phần còn lại. Server kiểm tra lại toàn bộ và chạy trong 1 transaction |
| I3 | **Trùng**: dòng có tiêu đề trùng task đã có trong cùng project (hoặc trùng dòng khác trong file) đánh dấu ⚠️. Mặc định **Bỏ qua**, có tuỳ chọn **Vẫn tạo** |
| I4 | **Phụ thuộc**: chỉ trong cùng project (như FR-08). Mã tham chiếu phải có trong file; `#id` phải là task đã có. Kiểm tra vòng tròn trên cả nhóm task mới. Dòng bị bỏ qua (trùng, bỏ tick) mà có dòng khác chờ nó: dòng chờ báo lỗi, trừ khi trùng thì nối vào task đã có cùng tiêu đề |
| I5 | **Mức quyền `auto`** (R3): màn xem trước hiện cảnh báo đỏ "K task dùng mức quyền Auto, Claude sẽ tự chạy lệnh không cần duyệt", phải tick xác nhận mới tạo được |
| I6 | **Giới hạn**: tối đa **200 dòng** và **5 MB** mỗi lần; mỗi ô tối đa 32.767 ký tự (giới hạn ô Excel) |
| I7 | Lỗi ghi theo **số dòng trong file** (dòng tiêu đề là dòng 1), dùng đúng thông báo của form tạo task |

### 2.5 API
| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/tasks/import` | Body `{projectId, rows: ImportRow[], onDuplicate: 'skip'\|'create', run: boolean, confirmAuto?: boolean, dryRun: boolean}`. Trả `{rows: [{line, status: 'ok'\|'duplicate'\|'error', errors?, taskId?}], created, skipped}` |

- `ImportRow` là object đã map tên cột (`title`, `prompt`, `key`, `dependsOn: string[]`, `project`, `priority`, `tags: string[]`, `model`, `permissionMode`, `maxCostUsd`) kèm `line`. Web chỉ đọc file và map cột; mọi kiểm tra giá trị ở server.
- `dryRun: false` còn lỗi thì trả 400 kèm danh sách lỗi, không tạo gì.
- Tạo xong: broadcast từng task như `POST /api/tasks`, gọi `pump()` **một lần** ở cuối.
- `scripts/seed-backlog.mjs` có thể chuyển sang dùng endpoint này (không bắt buộc).

### 2.6 Thay đổi kỹ thuật dự kiến
| Phần | Thay đổi |
|---|---|
| `server/src/taskImport.ts` (mới) | Map giá trị (ưu tiên tiếng Việt, số kiểu `1,5`), giải mã tham chiếu, kiểm tra vòng tròn nhóm, chống trùng |
| `server/src/db.ts` | Tách phần ghi của `taskDeps.set` khỏi `BEGIN/COMMIT` (hoặc dùng `SAVEPOINT`) để gọi được trong transaction import (R6) |
| `server/src/routes.ts` | Route `/api/tasks/import`; tách lõi của `validateTask` để trả lỗi theo dòng thay vì ném ngay |
| `web/src/lib/csv.ts` (mới) | Parser CSV/TSV, nhận dấu phân cách, giải mã |
| `web/src/lib/importMap.ts` (mới) | Nhận diện tên cột (bỏ dấu), tạo file mẫu |
| `web/src/components/ImportModal.tsx` (mới) | Chọn file / dán, xem trước, tuỳ chọn, kết quả |
| `web/src/pages/Board.tsx` | Nút "Import" cạnh nút tạo task; kéo-thả file vào board (Could) |
| `web/src/store/store.ts`, `mock.ts` | Hàm `importTasks`, bản giả cho `dev:mock` |
| `web/src/i18n/en.ts` | Chuỗi tiếng Anh |
| `web/package.json` | Thêm `read-excel-file` (ghim phiên bản) |

---

## 3. Yêu cầu chức năng (đề xuất đưa vào SPEC 3.1)

| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-01a | **Import task hàng loạt** từ CSV, `.xlsx` hoặc dữ liệu dán từ bảng tính. Có xem trước từng dòng kèm lỗi, chống trùng tiêu đề, phụ thuộc giữa các dòng qua cột Mã. Mặc định tạo ở Backlog; tạo tất cả hoặc không. Theo quy tắc I1–I7 | Should |
| FR-01b | Tải file mẫu CSV (UTF-8 BOM) | Should |
| FR-01c | Map cột thủ công khi tên cột không nhận ra; nhớ cách map cho lần sau | Could |
| FR-01d | Export task ra CSV (lọc theo board hiện tại), dùng được làm file import | Could |

**Bản 1** làm FR-01a, FR-01b. FR-01c, FR-01d để sau, khi có nhu cầu thực tế.

---

## 4. Tiêu chí nghiệm thu

- **AC-14**: Lưu file từ Excel tiếng Việt bằng "CSV (dấu phân cách bằng dấu phẩy)" (thực tế ra `;`, Windows-1258) và bằng "CSV UTF-8": cả hai import đúng cột và tiếng Việt không lỗi.
- **AC-15**: File `.xlsx` 20 dòng, prompt nhiều dòng trong ô: tạo đủ 20 task ở Backlog, prompt giữ nguyên xuống dòng, không task nào tự chạy.
- **AC-16**: File có 1 dòng thiếu mô tả: xem trước báo lỗi đúng số dòng, nút Tạo bị khoá; bỏ tick dòng đó thì tạo được các dòng còn lại.
- **AC-17**: Dòng B có Phụ thuộc = mã của dòng A: sau import B chờ A (FR-08). A chờ B và B chờ A: báo lỗi phụ thuộc vòng tròn, không tạo task nào.
- **AC-18**: Import lại cùng file: mọi dòng đánh dấu trùng, mặc định không tạo thêm task.
- **AC-19**: File có dòng mức quyền `auto`: phải tick xác nhận cảnh báo mới tạo được.
- **AC-20**: Dán vùng ô copy từ Google Sheets cho kết quả như import file.
- **AC-21**: Server bị lỗi giữa lúc ghi (giả lập trong test): không có task nào được tạo.

---

## 5. Câu hỏi cần chủ dự án chốt

| # | Câu hỏi | Đề xuất mặc định |
|---|---|---|
| QI1 ✅ `.xlsx` | Có cần đọc `.xlsx` ngay bản 1, hay chỉ CSV + dán từ Excel? | **Có `.xlsx`**: thêm 1 thư viện nhỏ, nạp khi cần. Nếu muốn không thêm dependency thì bản 1 chỉ CSV + dán (dán đã tránh được lỗi mã hoá) |
| QI2 ✅ mặc định | Trạng thái mặc định sau import? | **Backlog** (I1) |
| QI3 ✅ mặc định | Còn dòng lỗi thì xử lý thế nào? | **Tất cả hoặc không**, cho bỏ tick dòng lỗi (I2) |
| QI4 ✅ mặc định | Dòng trùng tiêu đề? | **Bỏ qua**, có tuỳ chọn Vẫn tạo (I3) |
| QI5 ✅ mặc định | Một file được chứa task của nhiều project? | **Có**, qua cột Project (trống thì dùng project trên hộp thoại). Phụ thuộc vẫn chỉ trong cùng project |
| QI6 ✅ mặc định | Có cho cột Mức quyền nhận `auto` không? | **Có, nhưng phải xác nhận** (I5). Phương án chặt hơn: bỏ qua `auto` trong file, luôn dùng mặc định của project |
| QI7 ✅ mặc định | Giới hạn mỗi lần import? | **200 dòng / 5 MB** (I6) |

---

## 6. Ước lượng

| Phần | Thời gian |
|---|---|
| Server: endpoint, map giá trị, phụ thuộc nhóm, transaction, test | ~0,5–0,75 ngày |
| Web: parser CSV/TSV + mã hoá, nhận cột, file mẫu, test parser | ~0,5 ngày |
| Web: ImportModal (xem trước, tuỳ chọn, kết quả), mock, i18n | ~0,75 ngày |
| Kiểm thử AC-14..21, cập nhật SPEC/PLAN/hướng dẫn sử dụng | ~0,25 ngày |
| **Tổng** | **~2 ngày** |

---

## 7. Phê duyệt

- [x] Chủ dự án đồng ý phạm vi bản 1 (FR-01a, FR-01b), 2026-11-18
- [x] Đã chốt QI1–QI7 (QI1: có `.xlsx`; còn lại theo mặc định)
- [x] Gộp vào SPEC.md v0.5 và bắt đầu viết code

Thư viện đọc Excel: `read-excel-file` **9.3.14** (MIT), ghim đúng phiên bản; chọn bản đã phát hành ≥ 2 tuần.
