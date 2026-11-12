# BACKLOG: Claude Task Board

Lập từ [PLAN.md](PLAN.md) v0.2 (2026-11-11). Nội dung đầy đủ của từng task (prompt giao cho Claude) nằm trong [backlog.json](backlog.json).

## Nạp vào board

```bash
npm run dev                         # hoặc npm start
npm run seed:backlog -- --dry-run   # xem trước
npm run seed:backlog                # tạo task ở cột Backlog
```
- Script tự tìm project có `repoPath` trỏ tới repo này. Không tìm thấy thì thêm project trên trang **Projects**, hoặc truyền `--project <id>`.
- `--only P2` chỉ nạp nhóm P2. Chạy lại nhiều lần vẫn an toàn vì task trùng tiêu đề sẽ được bỏ qua.

> ⚠️ **Khi cho board tự sửa chính repo này:**
> - Đến hết P2-02, task vẫn chạy thẳng trên repo, chưa có worktree. Hãy làm trên nhánh `phase/p2-review`.
> - Chạy server bằng `npm start`. `npm run dev` dùng `tsx watch`, nên khi Claude sửa `server/src` server sẽ khởi động lại và task đang chạy bị chuyển sang Failed (NFR-05).
> - Chạy lần lượt theo cột "Phụ thuộc" và duyệt từng task.

## Danh sách

| Mã | Task | Ưu tiên | Phụ thuộc | PLAN |
|---|---|---|---|---|
| **P2: Review flow** | | | | |
| P2-01 | Module `git.ts`: worktree và nhánh task | high | — | 2.1 |
| P2-02 | Runner chạy trong worktree, commit, chuyển sang Review | high | P2-01 | 2.1, 2.2 |
| P2-03 | API Diff | high | P2-02 | 2.3 |
| P2-04 | Bảng reviews + Approve & Merge | high | P2-03 | 2.4, 2.8 |
| P2-05 | Request changes (resume) + Reject | high | P2-04 | 2.5, 2.6 |
| P2-06 | Retry trên worktree sạch | normal | P2-05 | 2.7 |
| P2-07 | Web: Diff, thanh Review, Lịch sử, badge | high | P2-03..05 | 2.9–2.12 |
| P2-08 | Kiểm thử AC-02/03/04, cập nhật PLAN | normal | P2-06, P2-07 | Kiểm thử P2 |
| **P3: Needs Input và thông báo** | | | | |
| P3-01 | MCP permission server (stdio) | normal | P2-08 | 3.1 |
| P3-02 | Bảng `permission_requests` + API duyệt | normal | P3-01 | 3.3 |
| P3-03 | Runner: `--mcp-config`, `--permission-prompt-tool` | normal | P3-02 | 3.2 |
| P3-04 | Whitelist tự cho phép + "Luôn cho phép" | normal | P3-02 | 3.4 |
| P3-05 | Timeout tự Deny | normal | P3-02 | 3.5 |
| P3-06 | Hook Notification | low | P3-03 | 3.6 |
| P3-07 | Web: Needs Input, Settings, Web Notification | normal | P3-02, 04, 05 | 3.7–3.9 |
| P3-08 | Kiểm thử P3, cập nhật PLAN | normal | P3-03, 06, 07 | Kiểm thử P3 |
| **Chung** | | | | |
| C-01 | Rate limit: tự đưa task lại hàng đợi | normal | — | Rủi ro chung |
| **P4: Tùy chọn** | | | | |
| P4-01 | Template prompt | low | P3-08 | 4.1 |
| P4-02 | Tag, tìm kiếm, lọc nâng cao | low | P3-08 | 4.2 |
| P4-03 | Chạy test trên trang Review | low | P3-08 | 4.3 |
| P4-04 | Trang thống kê | low | P3-08 | 4.4 |
| P4-05 | Thông báo Telegram | low | P3-08 | 4.5 |
| P4-06 | Lên lịch task (cron) | low | P3-08 | 4.6 |
| P4-07 | Truy cập từ xa (Tailscale + token) | low | P3-08 | 4.7 |
| **P5: Chọn model tự động** | | | | |
| P5-01 | Lưu model thực tế + `model_usage` của run | high | — | P5 D8 |
| P5-02 | Web: hiển thị model (TaskCard, TaskDetail, Stats) | normal | P5-01 | P5 |
| P5-03 | Cấu hình model 3 tầng + `--model` | high | P5-01 | P5 D1–D3 |
| P5-04 | `modelPicker.ts` Lớp 1 + `auto` + `/api/model-suggest` | high | P5-03 | P5 D3–D4 |
| P5-05 | Web: chế độ Tự động, gợi ý khi gõ, model trong template | normal | P5-02, P5-04 | P5 |
| P5-06 | Lớp 3: tự nâng model khi thất bại | normal | P5-04 | P5 D6 |
| P5-07 | Lớp 2: học từ lịch sử + bảng tag × model | low | P5-06 | P5 D5 |
| P5-08 | Kiểm thử P5, cập nhật PLAN | normal | P5-01..07 | P5 |
| **P6: Budget theo project** | | | | |
| P6-01 | Backend budget, cảnh báo, tạm dừng hàng đợi | normal | — | P6 B1–B5 |
| P6-02 | Web: budget trên Projects/Stats | normal | P6-01 | P6 |
| **P7: Cải tiến duyệt quyền** | | | | |
| P7-01 | Preset allowlist | normal | — | P7 |
| P7-02 | Gợi ý rule từ lịch sử duyệt | normal | — | P7 |
| P7-03 | Duyệt quyền qua Telegram | low | — | P7 |
| P7-04 | Phân loại rủi ro lệnh | normal | — | P7 |
| P7-05 | Từ chối kèm lý do + duyệt hàng loạt | low | P7-04 | P7 |

## Việc của bạn (không giao cho Claude)
- [ ] **Điểm duyệt #1**: bấm thử giao diện P1 trên trình duyệt (PLAN, mục "Kết quả kiểm thử P1").
- [ ] Chọn hạng mục P4 muốn làm (PLAN, mục "Phê duyệt kế hoạch"). Task P4 nào không cần thì xóa khỏi board.
- [ ] Điểm duyệt #2 sau P2-08 và điểm duyệt #3 sau P3-08.
