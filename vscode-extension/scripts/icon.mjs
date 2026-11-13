// Tạo media/icon.png (128×128, Marketplace bắt buộc PNG) từ media/icon.svg. Chạy lại khi đổi logo: npm run icon
import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const media = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'media')
const png = new Resvg(readFileSync(join(media, 'icon.svg'), 'utf8'), { fitTo: { mode: 'width', value: 128 } }).render().asPng()
writeFileSync(join(media, 'icon.png'), png)
console.log(`media/icon.png: ${png.length} bytes`)
