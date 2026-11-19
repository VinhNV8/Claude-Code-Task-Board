// File mẫu import dạng .xlsx (SPEC FR-01b). Ghi Office Open XML tối giản rồi nén zip bằng fflate
// (đã có sẵn vì read-excel-file dùng), không cần thêm thư viện ghi Excel.
// Ô dùng chuỗi inline (t="inlineStr"); dòng đầu in đậm và cố định khi cuộn; ô tự xuống dòng.
import { strToU8, zipSync } from 'fflate'
import { TEMPLATE_GUIDE, TEMPLATE_ROWS } from './taskImport.ts'

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export interface XlsxSheet {
  name: string
  rows: string[][]
  /** Độ rộng cột (số ký tự). */
  widths?: number[]
}

const esc = (s: string) =>
  s
    // Ký tự điều khiển không hợp lệ trong XML 1.0 (trừ Tab, xuống dòng)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** Chỉ số cột (0) → tên cột Excel: 0 → A, 25 → Z, 26 → AA. */
export function columnName(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

// Style 0: mặc định, 1: đậm + tô nền (dòng tiêu đề), 2: tự xuống dòng, căn trên.
const STYLES =
  `${XML}<styleSheet xmlns="${NS}">` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE0E7FF"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'

function sheetXml(sheet: XlsxSheet): string {
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : ''
  const rows = sheet.rows
    .map((cells, r) => {
      const style = r === 0 ? 1 : 2
      const cs = cells
        .map((v, c) =>
          v === ''
            ? ''
            : `<c r="${columnName(c)}${r + 1}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${esc(v)}</t></is></c>`,
        )
        .join('')
      return `<row r="${r + 1}">${cs}</row>`
    })
    .join('')
  return (
    `${XML}<worksheet xmlns="${NS}" xmlns:r="${REL_NS}">` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData></worksheet>`
  )
}

/** Tạo file .xlsx từ các sheet (chuỗi). Sheet đầu tiên là sheet import đọc. */
export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      `${XML}<workbook xmlns="${NS}" xmlns:r="${REL_NS}"><sheets>` +
        sheets.map((s, i) => `<sheet name="${esc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    ),
    'xl/styles.xml': strToU8(STYLES),
  }
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s))))
  return zipSync(files, { level: 6 })
}

/** File mẫu import (FR-01b): sheet "Tasks" (được import) + sheet "Hướng dẫn". */
export function templateXlsx(): Uint8Array {
  return buildXlsx([
    { name: 'Tasks', rows: TEMPLATE_ROWS, widths: [8, 36, 60, 12, 10, 16, 10, 16, 13] },
    { name: 'Hướng dẫn', rows: TEMPLATE_GUIDE, widths: [18, 10, 90] },
  ])
}
