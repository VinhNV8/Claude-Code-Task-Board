# SPEC bổ sung: Task định kỳ tự tạo output và đăng ra kênh ngoài (Facebook, webhook…)

| Mục | Giá trị |
|---|---|
| Mã yêu cầu | **FR-90..FR-99** (mở rộng P4-06 Lên lịch task) · AC-22..AC-30 |
| Giai đoạn đề xuất | **P8** |
| Ngày | 2026-11-19 |
| Trạng thái | ⏳ **Chờ duyệt**. Chưa viết code |
| Nguồn | [Ideas Improvement.md](Ideas%20Improvement.md), ý ngày 18-11 |
| Sau khi duyệt | Gộp mục 4–9 vào [SPEC.md](SPEC.md), lập task P8-xx trong [PLAN.md](PLAN.md) và [backlog.json](backlog.json) |

---

## 0. Yêu cầu gốc (nguyên văn)

> Cấu hình task định kỳ (Claude sẽ dựa vào task định kỳ để tự động tạo output/đăng facebook,....) -> Nghiên cứu ý tưởng, đề xuất giải 3-5 giải pháp để triển khai được.

---

## 1. Mục tiêu và phạm vi

### 1.1 Mục tiêu
- **G-P8-1.** Một lịch định kỳ tự giao việc cho Claude để tạo **nội dung** (bài đăng, bản tin, báo cáo…) mà không cần mình giao tay mỗi lần.
- **G-P8-2.** Nội dung **không lặp lại** giữa các lần chạy và theo đúng một định dạng cố định để đem đi đăng được.
- **G-P8-3.** Sau khi được duyệt, nội dung được **đăng tự động** lên kênh đã cấu hình (Facebook Page, webhook sang n8n/Make/Zapier…), có lịch sử và link bài đăng.
- **G-P8-4.** Người dùng luôn kiểm soát được: **mặc định phải duyệt trước khi đăng**, duyệt được trên web hoặc Telegram.

### 1.2 Ràng buộc giữ nguyên
- **C1**: Claude chỉ chạy qua CLI `claude`. Việc gọi API của **Facebook** hay **webhook** là của Task Board, không phải gọi Claude API, nên không vi phạm C1.
- **C3**: chạy local. Lịch chỉ chạy khi máy bật (xem phương án hẹn giờ trên Meta ở FR-97 để giảm ảnh hưởng).
- Claude **không bao giờ** cầm token của kênh đăng (token chỉ nằm ở backend, mã hoá trong DB).

### 1.3 Ngoài phạm vi (bản này)
- Đăng lên **trang cá nhân** Facebook: Graph API không cho phép (Meta bỏ quyền này từ 2018). Chỉ hỗ trợ **Facebook Page**.
- Instagram, LinkedIn, X, TikTok gọi trực tiếp: làm qua **webhook** (n8n/Make/Zapier) ở bản này; bộ kết nối trực tiếp tính sau.
- Sinh ảnh bằng AI: Claude Code không tự tạo ảnh. Bài đăng chỉ dùng ảnh **có sẵn** trong thư mục project hoặc URL ảnh công khai.
- Chạy lịch trên cloud khi máy tắt.
- Nhiều người duyệt, phân quyền theo người.

---

## 2. Hiện trạng (P4-06)

Lịch hiện có ([schedules.ts](../server/src/schedules.ts), [scheduler.ts](../server/src/scheduler.ts)): theo cron, tới giờ thì tạo **một task Queued** với `title` + `prompt` cố định, mức quyền lấy theo project. Task chạy xong vào **Review** như task thường; Approve là kết thúc.

| Thiếu | Hậu quả |
|---|---|
| Prompt cố định, không có biến | Không đưa được ngày, thứ, số thứ tự lần chạy vào prompt |
| Không có "bộ nhớ" các lần trước | Claude dễ viết bài trùng ý với tuần trước |
| Output tự do | Không có gì chắc chắn để đem đăng |
| Không có bước đăng | Approve xong phải tự copy nội dung đi đăng |
| Lịch không có cấu hình riêng | Không chọn được model, mức quyền, tag, giới hạn chi phí cho từng lịch |

---

## 3. Các phương án đã cân nhắc

| # | Phương án | Ưu | Nhược | Kết luận |
|---|---|---|---|---|
| 1 | **Board tự đăng sau khi duyệt**: Claude viết file output, người duyệt, module trong board gọi Graph API | Luôn có người duyệt; có lịch sử, link bài; Claude không cầm token | Mỗi kênh mới phải viết thêm một bộ kết nối | ✅ **Chọn** (kênh Facebook Page) |
| 2 | Claude tự đăng qua MCP/script, lệnh đăng đi qua duyệt quyền | Linh hoạt | Token nằm trong môi trường của Claude; khó kiểm soát; đăng công khai khó rút lại | ❌ Không làm mặc định |
| 3 | **Webhook sang n8n / Make / Zapier** sau khi duyệt | Một tính năng chung dùng cho nhiều kênh; board không giữ token mạng xã hội | Phải chạy thêm một công cụ | ✅ **Chọn** (kênh Webhook, làm trước) |
| 4 | **Soạn trước theo lô, hẹn giờ trên Meta** (`scheduled_publish_time`) | Máy tắt vẫn đăng đúng giờ; sửa/huỷ trong Meta Business Suite | Nội dung kém "tươi" với chủ đề thời sự | ✅ **Chọn làm tuỳ chọn** của kênh Facebook |
| 5 | Chạy trên cloud bằng Claude Code routines | Không phụ thuộc máy bật | Nằm ngoài board, trái C3; không có Review/lịch sử | ❌ Ngoài phạm vi |

**Đề xuất: 1 + 3, kèm 4 là tuỳ chọn của kênh Facebook.**

---

## 4. Khái niệm

```
Lịch (Schedule) ──tới giờ──► Task (prompt đã thay biến + bài gần đây)
                                │ Claude chạy, ghi output theo định dạng cố định
                                ▼
                             Review: xem trước bài đăng ──► Từ chối / Yêu cầu sửa (như hiện tại)
                                │ Approve (hoặc tự duyệt theo chính sách của lịch)
                                ▼
                     Lần đăng (Publication) cho từng Kênh (Channel) × từng bài
                                │
              ┌─────────────────┴──────────────────┐
        Webhook (n8n/Make/Zapier)          Facebook Page (đăng ngay | hẹn giờ trên Meta)
```

- **Kênh (Channel)**: nơi đăng, thuộc một project. Loại: `webhook`, `facebook_page`.
- **Output dạng bài đăng**: file JSON do Claude ghi, chứa một hoặc nhiều **bài** (item).
- **Lần đăng (Publication)**: một bài × một kênh, có trạng thái và kết quả riêng. Đăng lỗi thì thử lại **chỉ phần đăng**, không chạy lại Claude.

---

## 5. Yêu cầu chức năng

### 5.1 Lịch nâng cấp
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-90 | **Biến trong tiêu đề và prompt của lịch**: `{{date}}` (vd. 19/11/2026), `{{weekday}}` (Thứ Năm), `{{time}}`, `{{week}}` (số tuần trong năm), `{{run_number}}` (lần chạy thứ mấy của lịch), `{{schedule_name}}`. Thay biến lúc tạo task, theo giờ máy chạy server. Biến không biết thì giữ nguyên và cảnh báo khi lưu lịch. Form lịch có nút **Xem trước prompt** | Must |
| FR-91 | **Bộ nhớ nội dung**: lịch có tuỳ chọn "Đưa N bài gần nhất vào prompt" (mặc định 5, tối đa 20). Biến `{{recent_outputs}}` là danh sách các bài **đã duyệt** gần nhất của lịch (ngày + nội dung cắt ≤ 300 ký tự mỗi bài). Không đặt biến trong prompt thì tự nối vào cuối prompt kèm câu "Không lặp lại ý của các bài sau" | Must |
| FR-92 | **Cấu hình riêng cho lịch**: model (Tự động / Haiku / Sonnet / Opus), mức quyền, tag, giới hạn chi phí mỗi lần chạy, template. Để trống thì kế thừa project như task thường | Should |
| FR-93 | **Output dạng bài đăng**: lịch chọn loại output `Tự do` (như hiện tại) hoặc `Bài đăng`. Với `Bài đăng`, board thêm hướng dẫn vào system prompt yêu cầu Claude ghi file `.taskboard/posts/task-<id>.json` trong thư mục làm việc theo schema ở mục 6. Hết lần chạy, board **kiểm tra file**: thiếu file, sai schema, ảnh không tồn tại, vượt độ dài → task vẫn vào Review nhưng có cảnh báo đỏ và **không cho Approve & Đăng** cho đến khi sửa (Yêu cầu sửa, hoặc sửa tay bằng chế độ Edit của FR-36) | Must |
| FR-94 | **Soạn theo lô**: lịch có `Số bài mỗi lần` (mặc định 1, tối đa 14). Ví dụ chạy thứ Hai, soạn 7 bài cho cả tuần; mỗi bài có `scheduledAt` riêng (Claude đề xuất, người duyệt sửa được) | Could |

### 5.2 Kênh đăng
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-95 | **Quản lý kênh** theo project (trang Projects → mục Kênh đăng): thêm/sửa/xoá/bật-tắt; nút **Gửi thử** (webhook: gửi payload mẫu có `test: true`; Facebook: kiểm tra token và quyền trên Page, **không đăng bài**). Bí mật (secret webhook, Page access token) mã hoá như token Telegram, không bao giờ trả ra API, log hay truyền cho Claude | Must |
| FR-96 | **Kênh Webhook**: `POST` JSON tới URL đã cấu hình (schema mục 6.2), header `X-Taskboard-Signature: sha256=<HMAC của body>` khi có secret, timeout 10 giây, coi là thành công khi HTTP 2xx. Body trả về có `url` hoặc `id` thì lưu làm link/ID bài | Must |
| FR-97 | **Kênh Facebook Page**: đăng qua Graph API bằng Page access token có quyền `pages_manage_posts`. Hỗ trợ: chữ, link, 1 hoặc nhiều ảnh (file trong thư mục làm việc hoặc URL công khai). Hai chế độ: **Đăng ngay**, hoặc **Hẹn giờ trên Meta** (`published=false` + `scheduled_publish_time` theo `scheduledAt` của bài; khoảng thời gian cho phép theo quy định hiện hành của Meta, kiểm tra lại lúc làm). Lưu `post id` và link bài | Should |

### 5.3 Duyệt và đăng
| ID | Yêu cầu | Ưu tiên |
|---|---|---|
| FR-98 | **Bước đăng sau khi duyệt**: lịch chọn các kênh đăng. Với task tạo từ lịch có kênh, Review có nút **Duyệt & Đăng** (bên cạnh Chấp nhận/Yêu cầu sửa/Từ chối như cũ). Duyệt & Đăng tạo các lần đăng (bài × kênh) và gửi lần lượt. Task chuyển **Done** khi mọi lần đăng thành công. Có lần đăng lỗi thì task vẫn Done nhưng hiện cảnh báo, có nút **Đăng lại** cho từng lần đăng lỗi (không chạy lại Claude). **Không bao giờ đăng trùng**: mỗi cặp (task, bài, kênh) chỉ đăng thành công một lần | Must |
| FR-99 | **Chính sách duyệt của lịch**: ① **Luôn duyệt tay** (mặc định); ② **Tự đăng nếu không ai từ chối sau X phút** (X từ 15 phút đến 24 giờ): khi task vào Review, board báo web + Telegram "Sẽ tự đăng lúc hh:mm", có nút Từ chối/Hoãn; tới giờ mà vẫn ở Review, không có cảnh báo FR-93, không có nhận xét chưa gửi thì tự Duyệt & Đăng và ghi log "Tự đăng theo chính sách lịch". Telegram có tin xem trước bài kèm nút **Đăng** / **Từ chối** | Should |

---

## 6. Định dạng dữ liệu

### 6.1 File bài đăng do Claude ghi (`.taskboard/posts/task-<id>.json`)
```json
{
  "items": [
    {
      "text": "Nội dung bài đăng (bắt buộc, ≤ 5.000 ký tự)",
      "link": "https://… (tuỳ chọn)",
      "images": ["assets/anh-1.jpg", "https://… (tuỳ chọn, tối đa 10)"],
      "hashtags": ["#tag (tuỳ chọn)"],
      "scheduledAt": "2026-11-20T08:00:00+07:00 (tuỳ chọn, dùng cho FR-94/FR-97 hẹn giờ)"
    }
  ],
  "notes": "Ghi chú cho người duyệt (tuỳ chọn, không đăng)"
}
```
- Đường dẫn ảnh tương đối tính từ thư mục làm việc, **không được ra ngoài** thư mục đó.
- Giới hạn 5.000 ký tự là giới hạn chung của board để bài đọc được. Giới hạn riêng của từng kênh kiểm tra thêm ở bộ kết nối.
- File nằm trong `.taskboard/` để không lẫn với output khác. Ở mode ghi thẳng, thư mục này nằm trong thư mục project của người dùng; board thêm `.taskboard/` vào danh sách bỏ qua khi chụp snapshot (giống `.claude/logs/`) nhưng vẫn hiện file bài đăng ở trang Review.

### 6.2 Payload webhook
```json
{
  "event": "taskboard.publish",
  "test": false,
  "publicationId": "pub-…",
  "project": { "id": "…", "name": "…" },
  "schedule": { "id": "…", "name": "…" },
  "task": { "id": 123, "title": "…", "url": "http://…/#/tasks/123" },
  "item": { "index": 0, "text": "…", "link": "…", "hashtags": [], "scheduledAt": "…",
            "images": [{ "name": "anh-1.jpg", "url": "https://… nếu là URL", "base64": "… nếu là file (≤ 5 MB mỗi ảnh)" }] },
  "approvedBy": "web | telegram | auto",
  "approvedAt": "2026-11-19T08:00:00+07:00"
}
```

### 6.3 Mô hình dữ liệu (bổ sung SPEC 5.2)
```
schedules    + model, permission_mode, tags, template_id, max_cost_usd,
               output_kind[free|post], items_per_run, recent_outputs_count,
               approval_policy[manual|auto_after], auto_publish_after_min, channel_ids (JSON)
channels     (id, project_id, kind[webhook|facebook_page], name, enabled,
              config_json   -- webhook: url · facebook: page_id, mode[now|scheduled]
              secret_enc,   -- secret HMAC / Page access token, mã hoá
              created_at)
publications (id, task_id, channel_id, item_index, status[pending|sending|scheduled|published|failed],
              external_id, url, error, attempts, scheduled_for, published_at, created_at,
              UNIQUE(task_id, channel_id, item_index))
tasks        + schedule_id, auto_publish_at
```

### 6.4 API (bổ sung SPEC 5.3)
| Method | Path | Mô tả |
|---|---|---|
| GET/POST | `/api/projects/:id/channels` | Danh sách / thêm kênh |
| PATCH/DELETE | `/api/channels/:id` | Sửa / xoá kênh |
| POST | `/api/channels/:id/test` | Gửi thử (FR-95) |
| POST | `/api/schedules/prompt-preview` | `{scheduleId?, title, prompt, recentOutputsCount}` → tiêu đề và prompt đã thay biến (FR-90, FR-91). Khác với `GET /api/schedules/preview` đang có (xem trước giờ chạy cron) |
| GET | `/api/tasks/:id/posts` | Bài đăng đọc từ file + kết quả kiểm tra (FR-93) |
| POST | `/api/tasks/:id/review` | Thêm `action: approve_publish` (FR-98) |
| POST | `/api/publications/:id/retry` | Đăng lại một lần đăng lỗi |
| POST | `/api/tasks/:id/auto-publish` | `{action: cancel | postpone, minutes?}` (FR-99) |

---

## 7. Giao diện

1. **Form lịch** (ScheduleManager): thêm các nhóm *Nội dung* (loại output, số bài mỗi lần, số bài gần nhất đưa vào prompt), *Chạy* (model, mức quyền, tag, giới hạn chi phí), *Đăng* (chọn kênh, chính sách duyệt). Nút **Xem trước prompt** hiện prompt đã thay biến và các bài gần nhất.
2. **Trang Projects → Kênh đăng**: danh sách kênh, trạng thái lần gửi thử gần nhất, nút Gửi thử.
3. **Review của task từ lịch**: tab **Bài đăng** hiện từng bài dạng xem trước (chữ, ảnh, link, giờ hẹn) cùng kết quả kiểm tra FR-93; nút **Duyệt & Đăng**; nếu có chính sách tự đăng thì hiện đếm ngược và nút **Hoãn** / **Huỷ tự đăng**.
4. **Chi tiết task sau khi đăng**: bảng lần đăng (kênh, bài, trạng thái, link, lỗi, nút Đăng lại).
5. **Telegram**: tin xem trước bài (chữ + ảnh đầu tiên) kèm nút **Đăng** / **Từ chối**; sau khi đăng, sửa tin kèm link bài.

---

## 8. Tiêu chí nghiệm thu

- **AC-22**: Lịch có prompt `Viết bài cho {{weekday}} {{date}}. {{recent_outputs}}`. Xem trước và task được tạo đều có đúng ngày, thứ và các bài đã duyệt gần nhất của lịch.
- **AC-23**: Lịch loại `Bài đăng`: Claude ghi file đúng schema → tab Bài đăng hiện xem trước. File sai schema hoặc ảnh không tồn tại → có cảnh báo, nút Duyệt & Đăng bị khoá.
- **AC-24**: Kênh webhook tới một server thử nghiệm: Duyệt & Đăng gửi đúng payload, chữ ký HMAC kiểm tra được; server trả 500 thì lần đăng Failed, bấm Đăng lại thì gửi lại đúng một lần và thành công.
- **AC-25**: Bấm Duyệt & Đăng hai lần (hoặc trên web và Telegram cùng lúc) chỉ tạo **một** bài trên kênh.
- **AC-26**: Kênh Facebook Page (Page thử nghiệm), chế độ Đăng ngay: bài xuất hiện trên Page, link bài lưu vào task. Chế độ Hẹn giờ: bài xuất hiện trong danh sách bài đã lên lịch của Page đúng giờ `scheduledAt`.
- **AC-27**: Lịch chính sách "Tự đăng sau 30 phút": task vào Review, Telegram báo giờ tự đăng; không ai từ chối thì đúng giờ tự đăng; bấm Từ chối trước giờ thì không đăng gì.
- **AC-28**: Token Facebook và secret webhook không xuất hiện trong bất kỳ response API, log, file cấu hình MCP hay biến môi trường của tiến trình Claude.
- **AC-29**: Lịch soạn 7 bài một lần (FR-94) với kênh Facebook chế độ Hẹn giờ: một lần duyệt tạo 7 bài hẹn giờ trên Page.
- **AC-30**: Lịch loại `Tự do` không chọn kênh hoạt động y như hiện tại (không hồi quy P4-06).

---

## 9. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Đăng nội dung sai/nhạy cảm (đăng công khai khó rút lại) | Mặc định duyệt tay; tự đăng phải bật riêng từng lịch và có thời gian chờ để từ chối; không cho Claude cầm token |
| Máy tắt đúng giờ chạy lịch | Lịch đã tạo bù 1 task khi bật lại (P4-06); dùng chế độ soạn theo lô + hẹn giờ trên Meta (FR-94, FR-97) |
| Token Facebook hết hạn / bị thu hồi / Page đổi quyền | Gửi thử kiểm tra quyền; lần đăng lỗi 190/200 hiện hướng dẫn tạo lại token; báo web + Telegram |
| Meta coi là spam khi đăng tự động dày đặc | Board giới hạn mặc định tối đa 5 bài/ngày/kênh (cấu hình được); khuyến nghị nội dung có giá trị, không đăng trùng (FR-91, FR-98) |
| Đăng trùng do bấm hai lần / mạng chập chờn | Khoá duy nhất (task, kênh, bài); trạng thái `sending` chặn gửi song song; webhook mang `publicationId` để bên nhận tự chống trùng |
| Nội dung lặp lại theo thời gian | Bộ nhớ nội dung FR-91; người duyệt thấy bài gần nhất ngay trong Review |
| Chi phí chạy định kỳ cộng dồn | Giới hạn chi phí mỗi lần chạy (FR-92) và budget tháng của project (P6) vẫn áp dụng |
| API của Facebook đổi phiên bản | Gom gọi Graph API vào một module, ghi phiên bản đã test; kênh webhook là đường dự phòng |

---

## 10. Câu hỏi cần chủ dự án chốt

| # | Câu hỏi | Đề xuất mặc định |
|---|---|---|
| QP1 | Đăng lên **Facebook Page** là đủ (không phải trang cá nhân)? Đã có Page và quyền admin chưa? | Chỉ Page |
| QP2 | Ngoài Facebook, cần kênh nào? (Zalo OA, LinkedIn, email, Google Sheets…) | Đi qua **webhook** + n8n tự host |
| QP3 | Có cho phép **tự đăng sau X phút** không, hay luôn duyệt tay? | Có tính năng, **mặc định tắt** |
| QP4 | Kiểu dùng chính: mỗi ngày soạn 1 bài, hay mỗi tuần soạn cả lô? | Hỗ trợ cả hai; ưu tiên làm 1 bài/lần trước |
| QP5 | Ảnh cho bài đăng lấy từ đâu? | Ảnh có sẵn trong thư mục project hoặc URL; không sinh ảnh |
| QP6 | Thứ tự làm kênh: webhook trước hay Facebook trước? | **Webhook trước** (rẻ, phủ nhiều kênh), Facebook sau |
| QP7 | Giới hạn số bài/ngày/kênh mặc định? | 5 |

---

## 11. Lộ trình và ước lượng

| Mã | Nội dung | Phụ thuộc | Ước lượng |
|---|---|---|---|
| P8-01 | Biến trong prompt + Xem trước + bộ nhớ bài gần nhất (FR-90, FR-91) | — | 0,5 ngày |
| P8-02 | Cấu hình riêng cho lịch (FR-92) | — | 0,5 ngày |
| P8-03 | Output dạng bài đăng: system prompt, đọc + kiểm tra file, tab Bài đăng (FR-93) | P8-01 | 1 ngày |
| P8-04 | Kênh + mã hoá secret + Gửi thử; kênh Webhook (FR-95, FR-96) | — | 1 ngày |
| P8-05 | Duyệt & Đăng, bảng publications, chống trùng, Đăng lại (FR-98) | P8-03, P8-04 | 1 ngày |
| P8-06 | Kênh Facebook Page: đăng ngay, ảnh, hẹn giờ (FR-97) | P8-05 | 1–1,5 ngày |
| P8-07 | Chính sách tự đăng + Telegram xem trước/Đăng (FR-99) | P8-05 | 1 ngày |
| P8-08 | Soạn theo lô (FR-94) | P8-06 | 0,5 ngày |
| P8-09 | Kiểm thử AC-22..30 (Facebook với Page thử nghiệm), cập nhật SPEC/PLAN/hướng dẫn | tất cả | 0,5–1 ngày |

**Tổng: khoảng 7–8 ngày.** Có thể dừng sau P8-05 (khoảng 4 ngày) để dùng ngay với webhook + n8n, rồi mới làm Facebook trực tiếp.

---

## 12. Phê duyệt

- [ ] Đồng ý phương án **1 + 3 (+4)** và phạm vi ở mục 1
- [ ] Đã trả lời các câu hỏi ở mục 10
- [ ] Đồng ý thứ tự P8-01..09 (hoặc ghi rõ phần muốn bỏ/hoãn)
- [ ] Cho phép gộp vào SPEC.md và bắt đầu P8
