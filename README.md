# Claude Task Board

Giao việc cho Claude Code, theo dõi tiến độ và review kết quả qua trình duyệt, không cần mở VSCode.
Dùng **Claude Code đã đăng nhập trên máy** (CLI headless). **Không gọi Claude API, không cần API key.**

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

## Yêu cầu
- Node.js ≥ 22.13 (dùng `node:sqlite` có sẵn), git
- Claude Code đã đăng nhập. Backend tự tìm `claude.exe` trong extension VSCode; nếu không tìm thấy, đặt biến `CLAUDE_BIN`.

## Dữ liệu
`data/taskboard.db` (SQLite) và `data/runs/<runId>.jsonl` (output gốc của từng lần chạy). Thư mục `data/` không được commit.

## Tài liệu
[SPEC](docs/SPEC.md) · [Kế hoạch](docs/PLAN.md) · [Spike P0](docs/P0-SPIKE.md) · [Duyệt prototype](docs/PROTOTYPE-REVIEW.md)
