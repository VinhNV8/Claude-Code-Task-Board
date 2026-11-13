// Bản dịch tiếng Anh: khoá là chuỗi tiếng Việt gốc truyền vào tr() (web/src/lib/i18n.ts).
// Thêm tr('…') mới thì thêm dòng ở đây; test server/src/i18n.test.ts báo chuỗi nào còn thiếu.
// Giữ nguyên các tham số {tên} trong bản dịch.
export const EN: Record<string, string> = {
  // Khung chung (Layout)
  'Công việc': 'Tasks',
  'Cần bạn': 'Needs you',
  'Thống kê': 'Stats',
  'Cài đặt': 'Settings',
  'Giao diện sáng': 'Light theme',
  'Giao diện tối': 'Dark theme',
  'Đăng xuất': 'Sign out',
  'Mở rộng menu': 'Expand menu',
  'Thu nhỏ menu': 'Collapse menu',
  'phím tắt': 'shortcut',
  'Phím tắt': 'Shortcut',
  'Tìm task hoặc chạy lệnh (Ctrl K)': 'Search tasks or run a command (Ctrl K)',
  'Tìm task, lệnh…': 'Search tasks, commands…',
  'Tìm task hoặc lệnh': 'Search tasks or commands',
  '{n} việc cần bạn xử lý': '{n} need your attention',
  'Giao việc': 'New task',
  'Mất kết nối tới server. Đang thử kết nối lại…': 'Lost connection to the server. Reconnecting…',
  'Đang tải dữ liệu…': 'Loading…',
  '{running} đang chạy, {waiting} chờ quyền, {queued} trong hàng đợi. Bấm để mở Điều phối':
    '{running} running, {waiting} waiting for permission, {queued} queued. Click to open Operations',
  slot: 'slots',
  '{n} chờ': '{n} queued',
  'Đóng': 'Close',
  'Bảng điều khiển demo': 'Demo controls',
  'Chỉ có trong prototype, dùng để thử các tình huống.': 'Prototype only, for trying out scenarios.',
  'Tốc độ giả lập: {n}×': 'Simulation speed: {n}×',
  'Lần chạy tới: Claude xin quyền': 'Next run: Claude asks for permission',
  'Cho mỗi task mới đi qua trạng thái Needs Input': 'Every new task goes through Needs Input',
  'Lần chạy tới: bị lỗi': 'Next run: fails',
  'Task sẽ kết thúc ở Failed': 'The task ends as Failed',
  'Lần Merge tới: conflict': 'Next merge: conflict',
  'Merge thất bại, task giữ ở Review': 'The merge fails and the task stays in Review',
  'Repo chính chưa sạch': 'Main repository has uncommitted changes',
  'Merge bị chặn cho tới khi bỏ chọn': 'Merge is blocked until unchecked',
  'Gói Claude hết lượt': 'Claude plan limit reached',
  'Hiện thông báo hết lượt 5 giờ trên mọi trang': 'Show the 5-hour limit banner on every page',
  'Nạp dữ liệu': 'Load data',
  'Mẫu': 'Sample',
  'Trống': 'Empty',
  'Nhiều task': 'Many tasks',
  'Chạy ngay #{id}?': 'Run #{id} now?',
  'Chạy ngay sẽ gỡ toàn bộ phụ thuộc của task này. Phần việc của các task đang chờ có thể chưa có trên nhánh chính.':
    "Running now removes all of this task's dependencies. Work from the tasks it waits on may not be on the main branch yet.",
  'Gỡ phụ thuộc và chạy': 'Remove dependencies and run',

  // Cài đặt: ngôn ngữ
  'Ngôn ngữ': 'Language',
  'Ngôn ngữ giao diện. Trong VS Code, mặc định theo ngôn ngữ của VS Code.': "Interface language. In VS Code, defaults to VS Code's language.",
}
