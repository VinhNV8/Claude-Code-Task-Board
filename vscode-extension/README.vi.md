# Agent Task Board

Bảng công việc ngay trong VS Code để giao việc cho **Claude Code**. Mặc định Claude ghi output thẳng vào thư mục project (không cần git); bạn review thay đổi rồi chấp nhận output hoặc yêu cầu sửa. Project cũng có thể chọn cho mỗi task một nhánh git riêng ở local (worktree) để chạy song song; việc merge do bạn làm theo quy trình riêng. Bạn duyệt quyền khi Claude cần chạy lệnh và theo dõi chi phí theo từng project.

> Đây là extension độc lập, **không phải sản phẩm của Anthropic** và không được Anthropic tài trợ hay xác nhận. "Claude" và "Claude Code" là thương hiệu của Anthropic, được nhắc tới ở đây chỉ để nói extension chạy cùng công cụ nào. Extension dùng Claude Code mà bạn đã cài và đăng nhập trên máy, hoặc API key Anthropic của chính bạn.

[English](README.md) · **Tiếng Việt**

## Bắt đầu

1. Cài extension.
2. Bấm biểu tượng **Agent Task Board** ở thanh bên trái.
3. Nếu workspace đang mở là git repo, extension hỏi có thêm nó làm project không. Chọn **Thêm**.
4. Tạo task, mô tả việc cần làm, rồi bấm Chạy.

Không cần cài Node hay chạy lệnh gì: extension chạy server bằng chính VS Code.

## Yêu cầu

- VS Code 1.101 trở lên.
- **git**.
- Một trong hai cách xác thực:
  - **Claude Code đã đăng nhập** (gói Pro/Max): cài extension [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) (có sẵn CLI) hoặc cài CLI `claude`, rồi đăng nhập. Extension tự tìm thấy CLI và báo nếu chưa đăng nhập (lệnh **Agent Task Board: Đăng nhập Claude Code**).
  - **API key Anthropic** (trả theo token): vào **Cài đặt → Xác thực Claude**, dán key rồi bấm Kiểm tra. Ở chế độ này budget tháng của project là giới hạn cứng.

## Lệnh

| Lệnh | Việc |
|---|---|
| Agent Task Board: Mở Task Board | Mở bảng công việc (lọc theo project của workspace) |
| Agent Task Board: Thêm workspace này làm project | Thêm git repo đang mở |
| Agent Task Board: Cài đặt | Xác thực Claude, thông báo, mặc định |
| Agent Task Board: Mở trong trình duyệt | Mở cùng giao diện trong trình duyệt |
| Agent Task Board: Đăng nhập Claude Code | Mở terminal chạy `claude auth login` |
| Agent Task Board: Khởi động lại server | Dừng và chạy lại server (task đang chạy sẽ dừng) |
| Agent Task Board: Xem log server | Mở file log |

## Cài đặt (settings.json)

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `agentTaskBoard.claudePath` | (tự tìm) | Đường dẫn file chạy Claude Code CLI |
| `agentTaskBoard.idleShutdownMinutes` | `30` | Tự tắt server sau số phút rảnh; `0`: không tự tắt |

## Cách hoạt động

- Server chạy nền trên `127.0.0.1` (cổng ngẫu nhiên) và dùng chung cho mọi cửa sổ VS Code. Đóng cửa sổ thì task vẫn chạy tiếp.
- Server tự tắt khi không còn cửa sổ nào mở Task Board và không còn task đang chạy, chờ hoặc lịch cron đang bật.
- Dữ liệu (database, snapshot, worktree, log) nằm trong thư mục lưu trữ riêng của extension. Output của task nằm trong thư mục project (mặc định) hoặc các nhánh local `claude/task-<id>` (mode worktree); Task Board không tự merge trừ khi bạn bấm Merge.
- Code được gửi tới Anthropic qua Claude Code, theo tài khoản hoặc API key của bạn. Extension không gửi dữ liệu đi đâu khác (thông báo Telegram chỉ gửi khi bạn tự bật).

## Hạn chế đã biết

- Trong khung VS Code, một số phím tắt sao chép/dán có thể không chạy trong giao diện (giới hạn của webview lồng iframe). Dùng **Mở trong trình duyệt** nếu cần.
- Khi làm việc qua Remote (SSH/WSL), server chạy trên máy remote; tính năng xem trước HTML dùng cổng phụ chưa được chuyển tiếp.
