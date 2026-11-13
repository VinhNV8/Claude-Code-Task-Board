# Claude Task Board

Giao việc cho Claude Code, theo dõi tiến độ và review kết quả qua trình duyệt, không cần mở VSCode.
Chạy Claude Code CLI (headless) bằng một trong hai cách xác thực, chọn ở **Cài đặt → Xác thực Claude**:
- **Đăng nhập Claude Code (gói Pro/Max)**: dùng phiên đăng nhập trên máy, chi phí nằm trong gói. Chỉ dành cho cá nhân tự dùng.
- **API key**: trả tiền theo token vào tài khoản Claude Console. Đây là cách dùng cho sản phẩm và doanh nghiệp. Xem [Xác thực Claude](#xác-thực-claude).

## Chạy

```bash
npm install        # lần đầu
npm run dev        # backend :3001 + giao diện :3000
```
Mở **http://localhost:3000**

| Lệnh | Mô tả |
|---|---|
| `npm run dev` | Chạy thật: backend + giao diện (hot reload) |
| `npm run dev:mock` | Prototype dữ liệu giả, không cần backend (có bảng Demo) |
| `npm start` | Build giao diện và chạy trên một port 3000 |
| `npm run typecheck` | Kiểm tra kiểu dữ liệu |
| `npm test -w server` | Unit test |
| `npm run uat:deploy [-- <ref>]` | Deploy môi trường UAT tại :4000 (xem [ENVIRONMENTS](docs/ENVIRONMENTS.md)) |

## Yêu cầu
- Node.js ≥ 22.13 (dùng `node:sqlite` có sẵn), git
- Claude Code đã đăng nhập. Backend tự tìm `claude.exe` trong extension VSCode; nếu không tìm thấy, đặt biến `CLAUDE_BIN`.

## Xác thực Claude

| | Đăng nhập Claude Code | API key |
|---|---|---|
| Chi phí | Nằm trong gói Pro/Max | Theo token, **riêng với gói** (gói Max không gồm credit API) |
| Giới hạn | Hạn mức theo 5 giờ / tuần của gói | Rate limit theo hạng tài khoản API |
| Budget project | Theo lựa chọn của project (cảnh báo hoặc tạm dừng) | **Giới hạn cứng**: vượt budget là tạm dừng, mỗi run có trần `--max-budget-usd` bằng phần budget còn lại |

| Biến môi trường | Ý nghĩa |
|---|---|
| `TASKBOARD_ANTHROPIC_API_KEY` | API key dùng cho chế độ API key. Ưu tiên hơn key lưu trong giao diện |
| `TASKBOARD_DEFAULT_AUTH_MODE` | `apiKey` để mặc định dùng API key khi chưa lưu cài đặt (bản thương mại). Mặc định `subscription` |
| `TASKBOARD_SECRET_KEY` | Khoá mã hoá (32 byte, hex hoặc base64) cho key lưu trong DB. Không đặt thì tự sinh ở `data/secret.key` |

- Key nhập trong giao diện được mã hoá AES-256-GCM trước khi lưu vào SQLite, không bao giờ trả ra API hay ghi log. Mất `data/secret.key` thì phải nhập lại key.
- Nút **Kiểm tra key** chỉ liệt kê model nên không tốn phí. Nút này không kiểm tra số dư credit.
- Task Board luôn bỏ `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` có sẵn trong môi trường, chỉ truyền key đã chọn, để không tính tiền nhầm tài khoản.
- Nên đặt giới hạn chi tiêu (spend limit) trong Claude Console. Chi phí Task Board hiển thị tính theo giá niêm yết.

## Truy cập từ xa qua Tailscale

Mặc định backend **chỉ lắng nghe `127.0.0.1`** và không cần đăng nhập. Muốn mở giao diện từ điện thoại/laptop khác,
nên đi qua [Tailscale](https://tailscale.com) (mạng riêng mã hoá, không mở port ra Internet) và **bắt buộc đăng nhập bằng token**.

| Biến môi trường | Ý nghĩa |
|---|---|
| `REMOTE_HOST` | Địa chỉ IP lắng nghe thêm, ví dụ IP Tailscale `100.x.y.z` (nhiều địa chỉ cách nhau dấu phẩy). Backend vẫn lắng nghe `127.0.0.1` cho các route nội bộ |
| `TASKBOARD_AUTH_TOKEN` | Token đăng nhập, **≥ 16 ký tự**. Bắt buộc khi có địa chỉ không phải localhost, thiếu thì backend không khởi động |
| `HOST` | Địa chỉ chính (mặc định `127.0.0.1`). Đặt `0.0.0.0` là mở mọi card mạng, **không khuyến khích** |

Các bước (Windows, PowerShell):

1. Cài Tailscale trên máy chạy Task Board và trên thiết bị muốn truy cập, đăng nhập **cùng một tailnet**.
2. Lấy IP Tailscale của máy chạy Task Board: `tailscale ip -4` (dạng `100.x.y.z`).
3. Tạo token ngẫu nhiên và lưu lại ở nơi an toàn (trình quản lý mật khẩu):
   ```powershell
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```
4. Chạy bản production với cấu hình truy cập từ xa (bản `npm run dev` dùng Vite chỉ nghe `127.0.0.1`, không truy cập từ xa được):
   ```powershell
   $env:REMOTE_HOST = "100.x.y.z"
   $env:TASKBOARD_AUTH_TOKEN = "<token vừa tạo>"
   npm start
   ```
   Log khởi động sẽ in `Server: http://127.0.0.1:3000`, `Server: http://100.x.y.z:3000` và `🔒 Bắt buộc đăng nhập bằng token`.
5. Nếu Windows Firewall hỏi, chỉ cho phép **Private network**. Có thể giới hạn chặt hơn bằng ACL của Tailscale (chỉ cho thiết bị của bạn vào port 3000).
6. Trên thiết bị khác mở `http://100.x.y.z:3000` (hoặc `http://<tên-máy>:3000` nếu bật MagicDNS), nhập token để đăng nhập.

Cách hoạt động:
- Đăng nhập thành công, backend đặt cookie `HttpOnly`, `SameSite=Strict`, hiệu lực 30 ngày. Mọi `/api` và `/ws` đều kiểm tra cookie (hoặc header `Authorization: Bearer <token>` cho script).
  Bật đăng nhập thì kể cả truy cập từ `localhost` cũng phải đăng nhập.
- Đổi `TASKBOARD_AUTH_TOKEN` rồi khởi động lại sẽ làm mọi phiên cũ hết hiệu lực. Nút **Đăng xuất** ở sidebar chỉ xoá cookie trên trình duyệt đó.
- Nhập sai token 10 lần trong 15 phút từ cùng một địa chỉ thì bị khoá tạm thời.
- Route nội bộ `/api/internal/*` và `/api/hooks/*` (MCP xin quyền, hook Notification) chỉ nhận kết nối trực tiếp từ localhost, không nhận qua mạng hay qua reverse proxy.
- Muốn có HTTPS: dùng `tailscale serve --bg 3000` (giữ `REMOTE_HOST` trống, chỉ đặt `TASKBOARD_AUTH_TOKEN`). Tailscale proxy về `127.0.0.1:3000`; cookie được thêm cờ `Secure` khi proxy gửi `X-Forwarded-Proto: https`.
  **Không** dùng `tailscale funnel` (mở ra Internet công cộng).

## Dữ liệu
`data/taskboard.db` (SQLite) và `data/runs/<runId>.jsonl` (output gốc của từng lần chạy). Thư mục `data/` không được commit.

## Tài liệu
[SPEC](docs/SPEC.md) · [Kế hoạch](docs/PLAN.md) · [Spike P0](docs/P0-SPIKE.md) · [Duyệt prototype](docs/PROTOTYPE-REVIEW.md)
