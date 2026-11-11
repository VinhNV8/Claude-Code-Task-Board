# Hướng dẫn duyệt Prototype (PT)

## Chạy prototype
```bash
cd "d:\Projects\AI Project\AI-Interface"
npm install     # lần đầu
npm run dev
```
Mở **http://localhost:3000**

> Prototype dùng **dữ liệu giả**: không có backend, không chạy Claude. Reload trang thì dữ liệu trở về trạng thái mẫu.
> Nút **Demo** (góc dưới bên trái) dùng để chỉnh tốc độ giả lập, bật các tình huống lỗi/conflict/xin quyền và nạp lại dữ liệu (Mẫu / Trống / Nhiều task).
> Phím tắt **N** mở form giao việc mới.

## 6 luồng cần bấm thử

| # | Luồng | Các bước |
|---|---|---|
| 1 | **Giao task mới** | Nút **Giao việc** → chọn template → **Lưu & Chạy** → xem log chạy realtime → task tự chuyển sang **Review** |
| 2 | **Review đạt** | **Cần xử lý** → task #101 → tab *Thay đổi / Review* → xem diff (Unified / Side-by-side) → **Approve & Merge** → Done |
| 3 | **Review chưa đạt** | Task #102 → **Request changes** → nhập feedback → Claude chạy tiếp (tab Log) → quay lại Review, xem tab *Lịch sử* |
| 4 | **Claude xin quyền** | Task #103 (Needs Input) → **Cho phép / Từ chối / Luôn cho phép**. Muốn thấy lại: Demo → bật “Lần chạy tới: Claude xin quyền” → tạo task mới |
| 5 | **Task lỗi** | Task #110 → đọc lý do lỗi → **Chạy lại**. Hoặc Demo → bật “Lần chạy tới: bị lỗi” → tạo task mới |
| 6 | **Thêm project** | **Projects** → **Thêm project** → thử đường dẫn chứa `notgit` để xem lỗi → thêm whitelist tool → Lưu |

**Tình huống bổ sung:** Demo → “Lần Approve tới: conflict” hoặc “Repo chính chưa sạch”, sau đó bấm Approve. Thử thêm Dừng task đang chạy, Sửa/Xoá task ở Backlog, giao diện tối, thu nhỏ cửa sổ.

## Danh sách màn hình (đối chiếu PLAN.md)

| Mã | Màn hình | Ở đâu |
|---|---|---|
| PT-01 | Layout, sidebar, badge "Cần xử lý" | Mọi trang |
| PT-02 | Kanban board | `/` |
| PT-03 | Modal tạo task | Nút **Giao việc** / phím N |
| PT-04 | Sửa / xoá task | Chi tiết task ở Backlog/Queued |
| PT-05 | Tab Log | Chi tiết task |
| PT-06 | Tab Kết quả | Chi tiết task |
| PT-07 | Tab Thay đổi / Review | Chi tiết task ở Review |
| PT-08 | Tab Lịch sử | Chi tiết task |
| PT-09 | Needs Input | Trang **Cần xử lý** và chi tiết task |
| PT-10 | Task Failed + Chạy lại | Task #110 |
| PT-11 | Projects | `/projects` |
| PT-12 | Cài đặt | `/settings` |
| PT-13 | Thông báo (toast + trình duyệt) | Góc dưới phải; bật thông báo trình duyệt trong Cài đặt |
| PT-14 | Sáng/tối, độ rộng màn hình | Nút ở sidebar |

## Mẫu ghi góp ý

```
PT-xx | <Mô tả vấn đề hoặc mong muốn> | Mức độ: Bắt buộc / Nên có / Tuỳ chọn
```
Ví dụ:
```
PT-07 | Muốn xem diff ngay trên trang Cần xử lý, không phải mở chi tiết | Nên có
PT-02 | Ẩn cột Backlog khi trống | Tuỳ chọn
```

## Trạng thái duyệt
- [x] Vòng 1: không có góp ý
- [ ] Vòng 2: đã góp ý
- [x] **Giao diện đã được duyệt** (2026-11-11), chuyển sang P0
