# Hướng dẫn cài đặt Agent Task Board

Agent Task Board là extension cho VS Code, dùng để giao việc cho Claude Code theo dạng bảng công việc. Extension được phát hành dưới dạng file **`.vsix`** (ví dụ `agent-task-board-0.1.1.vsix`) tại trang [Releases](https://github.com/VinhNV8/Claude-Code-Task-Board/releases), không có trên VS Code Marketplace.

[English](INSTALL.md)

## 1. Chuẩn bị

- **VS Code phiên bản 1.101 trở lên.** Kiểm tra bằng menu **Help → About** (macOS: **Code → About Visual Studio Code**). Nếu cũ hơn, vào **Help → Check for Updates** để cập nhật.
- **Claude Code đã đăng nhập.** Cách đơn giản nhất:
  1. Trong VS Code, mở **Extensions** (`Ctrl+Shift+X`, macOS: `Cmd+Shift+X`).
  2. Tìm **Claude Code**, chọn extension của **Anthropic**, rồi bấm **Install**.
  3. Mở Claude Code và đăng nhập bằng tài khoản Claude (gói Pro hoặc Max).

  Nếu bạn dùng API key của Anthropic thay vì tài khoản Claude, vẫn cần cài Claude Code (bước 1–2) nhưng không cần đăng nhập. Nhập key sau khi cài (xem mục 3).
- **Git** (không bắt buộc): chỉ cần nếu muốn mỗi task chạy trên một nhánh riêng. Mặc định task ghi thẳng vào thư mục dự án. Tải tại https://git-scm.com nếu máy chưa có.

## 2. Cài extension từ file `.vsix`

### Tải file
Mở trang [Releases](https://github.com/VinhNV8/Claude-Code-Task-Board/releases), chọn bản mới nhất, tải file `agent-task-board-<phiên bản>.vsix` trong mục **Assets**.

Muốn kiểm tra file không bị sửa đổi: so mã SHA-256 của file với nội dung file `.vsix.sha256` đi kèm. Windows: `certutil -hashfile agent-task-board-0.1.1.vsix SHA256`. macOS/Linux: `shasum -a 256 agent-task-board-0.1.1.vsix`.

### Cách 1: Dùng giao diện (khuyên dùng)
1. Lưu file `.vsix` vào máy, ví dụ vào thư mục **Downloads**.
2. Mở VS Code.
3. Mở **Extensions** (`Ctrl+Shift+X`, macOS: `Cmd+Shift+X`).
4. Bấm dấu **`…`** (Views and More Actions) ở góc trên bên phải khung Extensions.
5. Chọn **Install from VSIX…**.
6. Chọn file `.vsix` vừa lưu, rồi bấm **Install**.
7. Khi VS Code báo cài xong, bấm **Reload** nếu được hỏi.

Cách khác: kéo thả file `.vsix` vào khung Extensions của VS Code.

### Cách 2: Dùng dòng lệnh
Mở Terminal ở thư mục chứa file rồi chạy:
```
code --install-extension agent-task-board-0.1.1.vsix
```
Nếu báo không tìm thấy lệnh `code`: trong VS Code, nhấn `Ctrl+Shift+P` (macOS: `Cmd+Shift+P`), gõ **Shell Command: Install 'code' command in PATH** rồi chạy lại lệnh trên. Trên Windows, lệnh `code` thường có sẵn.

## 3. Bắt đầu sử dụng

1. Mở thư mục dự án của bạn trong VS Code (**File → Open Folder…**).
2. Bấm biểu tượng **Agent Task Board** (3 cột) ở thanh bên trái. Bảng công việc sẽ mở trong một tab.
3. Extension hỏi có thêm thư mục đang mở làm project không. Chọn **Add** (Thêm).
4. Bấm **New task** (Giao việc), mô tả việc cần làm, rồi chạy.
5. Khi Claude cần quyền chạy lệnh, task chuyển sang trạng thái chờ. Bạn xem rồi bấm cho phép hoặc từ chối.
6. Khi task xong, xem lại thay đổi rồi chấp nhận.

**Dùng API key thay vì tài khoản Claude:** nhấn `Ctrl+Shift+P`, chạy **Agent Task Board: Settings**, vào mục **Claude authentication** (Xác thực Claude), dán key rồi bấm **Lưu** (key sai sẽ báo lỗi ở lần chạy task đầu tiên). Lưu ý: dùng API key sẽ bị tính tiền theo lượng sử dụng vào tài khoản Anthropic của bạn.

**Ngôn ngữ:** giao diện tự theo ngôn ngữ của VS Code. Đổi trong **Settings → Language** của bảng công việc.

## 4. Cập nhật lên bản mới

Bản cài từ file **không tự cập nhật**. Theo dõi trang [Releases](https://github.com/VinhNV8/Claude-Code-Task-Board/releases) (trên GitHub có thể bấm **Watch → Custom → Releases** để nhận thông báo), tải file `.vsix` mới rồi cài lại theo mục 2. Bản mới sẽ thay bản cũ, dữ liệu task và project vẫn được giữ. Sau khi cài, bấm **Reload** hoặc mở lại VS Code.

## 5. Gỡ cài đặt

Mở **Extensions**, tìm **Agent Task Board**, bấm biểu tượng bánh răng rồi chọn **Uninstall**.

Hoặc dùng dòng lệnh:
```
code --uninstall-extension vinhnguyen.agent-task-board
```

## 6. Gặp lỗi?

| Hiện tượng | Cách xử lý |
|---|---|
| Báo "requires VS Code 1.101 or later" hoặc không cài được | Cập nhật VS Code lên bản mới nhất (**Help → Check for Updates**) |
| Báo "Claude Code was not found" | Cài extension **Claude Code** của Anthropic (mục 1), rồi chạy **Agent Task Board: Restart server** |
| Báo "Claude Code is not signed in" | Bấm **Sign in** trong thông báo, hoặc `Ctrl+Shift+P` → **Agent Task Board: Sign in to Claude Code** |
| Bảng công việc trắng hoặc không mở được | `Ctrl+Shift+P` → **Agent Task Board: Restart server**. Nếu vẫn lỗi, chạy **Agent Task Board: Show server log** và gửi nội dung log cho người hỗ trợ |
| Copy/paste không chạy trong bảng | `Ctrl+Shift+P` → **Agent Task Board: Open in browser** để mở bảng trong trình duyệt |

**Cursor, Windsurf và các editor dựa trên VS Code:** cài theo **Cách 1** ở mục 2. Editor cần dựa trên VS Code 1.101 trở lên.

## Lưu ý
- Đây là extension độc lập, không phải sản phẩm của Anthropic.
- Code của bạn được gửi tới Anthropic qua Claude Code, theo tài khoản hoặc API key của chính bạn. Extension không gửi dữ liệu đi nơi nào khác, trừ thông báo Telegram nếu bạn bật.
- Chỉ cài file `.vsix` tải từ trang [Releases](https://github.com/VinhNV8/Claude-Code-Task-Board/releases) chính thức hoặc từ nguồn bạn tin cậy.
