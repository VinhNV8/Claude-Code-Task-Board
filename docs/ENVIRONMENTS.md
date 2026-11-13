# Môi trường DEV & UAT

| | DEV | UAT |
|---|---|---|
| Mục đích | Phát triển, hot reload | Kiểm thử các task đã giao (bản build ổn định) |
| Code | Thư mục hiện tại (kể cả thay đổi chưa commit) | Git worktree `../AI-Interface-uat`, checkout **đúng một commit** |
| URL | http://localhost:3000 (API :3001) | http://127.0.0.1:4000 |
| Dữ liệu | `data/` | `../AI-Interface-uat/data/` (DB, runs, worktree task riêng) |
| Chế độ | `vite` + `tsx watch` | `NODE_ENV=production`, giao diện đã build |
| Nhãn UI | **DEV** (vàng) | **UAT** (xanh) |

Hai môi trường không dùng chung port, DB hay dữ liệu, nên sửa code ở DEV không làm hỏng phiên UAT đang test.

## DEV

```bash
npm run dev
```

## UAT

```bash
npm run uat:deploy                      # deploy nhánh main
npm run uat:deploy -- claude/task-12    # test riêng nhánh của một task trước khi merge
npm run uat:deploy -- v0.2.0 --force    # tag/commit bất kỳ; --force = deploy dù UAT còn task đang chạy
npm run uat:copy-db                     # chép toàn bộ dữ liệu DEV → UAT (DB, log run, worktree task); DB UAT cũ được backup
npm run uat:deploy -- --copy-db         # deploy và chép dữ liệu DEV trong cùng một lần
npm run uat:status                      # bản nào đang chạy, pid, URL
npm run uat:logs                        # 80 dòng log cuối
npm run uat:stop | uat:start | uat:restart
```

`uat:deploy` thực hiện các bước sau:
1. Kiểm tra ref tồn tại. UAT **chỉ nhận code đã commit**.
2. Dừng lại nếu UAT còn task `running`/`needs_input` (bỏ qua kiểm tra này bằng `--force`).
3. Dừng UAT, checkout worktree về commit cần test. `data/` được giữ nguyên.
4. Chạy `npm ci` khi `package-lock.json` thay đổi.
5. Build giao diện với `APP_ENV=uat`, khởi động server chạy nền và chờ `/api/health`.

Tuỳ chỉnh: `UAT_PORT` (mặc định 4000), `UAT_DIR` (mặc định `../<tên-repo>-uat`).

## Cổng xem trước trang HTML

Khi review, file `.html` có chế độ **Giao diện**: trang chạy trong iframe từ một server riêng của backend,
trên cổng `PORT + 10` (đặt lại bằng `PREVIEW_PORT`). Cổng riêng = origin riêng, nên JavaScript trong trang
không đọc được cookie hay gọi được API của Task Board; link có token ký, hết hạn sau 30 phút.

| | DEV | UAT | `npm start` |
|---|---|---|---|
| Giao diện | 3000 | 4000 | 3000 |
| Xem trước HTML | 3011 | 4010 | 3010 |

Truy cập từ xa qua Tailscale: cho phép thêm cổng xem trước trong Firewall/ACL (cùng điều kiện với cổng chính).

## Quy trình đề xuất

1. Giao task ở DEV (hoặc UAT). Claude làm việc trên nhánh `claude/task-<id>`.
2. Cần test riêng một task: `npm run uat:deploy -- claude/task-<id>`.
3. Task đạt: merge vào `main`, rồi chạy `npm run uat:deploy` để kiểm thử hồi quy toàn bộ.

> Server UAT chạy nền và không tự bật lại sau khi khởi động lại máy. Khi đó chạy `npm run uat:start`.
