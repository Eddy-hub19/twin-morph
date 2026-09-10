// Генерирует один маленький прозрачный PNG-аксессуар ("бейдж") для co-op —
// см. game/entities/PlayerCosmetics.ts. Один файл, белого цвета — конкретный
// цвет каждому игроку задаётся в рантайме через sprite.tint (см.
// PLAYER_LOOK_BY_ROLE), поэтому не нужно рисовать/хранить по PNG на каждого
// игрока отдельно, а тем более на каждый кадр анимации червяка/муравья —
// аксессуар накладывается как отдельный слой поверх уже существующего
// спрайта, не трогая ни один существующий PNG.
//
// Запуск: node scripts/generateAccessoryBadge.js
const fs = require("fs")
const path = require("path")
const sharp = require("sharp")

const OUT_DIR = path.join(process.cwd(), "public/assets/accessories")
const OUT_FILE = path.join(OUT_DIR, "badge.png")

// Маленький бант/бейдж — две "петли" и узел посередине. Белый с мягкой
// обводкой (обводка нужна, чтобы бейдж не терялся на светлом тинте в
// светлых сценах — сам цвет сверху всё равно красит tint в рантайме).
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="20" viewBox="0 0 24 20">
  <path d="M12 10 L2 3 C0.5 2 0.5 8 2 9 L11 10 L2 11 C0.5 12 0.5 18 2 17 Z"
        fill="#ffffff" stroke="#2a2a2a" stroke-width="1.1" stroke-linejoin="round" />
  <path d="M12 10 L22 3 C23.5 2 23.5 8 22 9 L13 10 L22 11 C23.5 12 23.5 18 22 17 Z"
        fill="#ffffff" stroke="#2a2a2a" stroke-width="1.1" stroke-linejoin="round" />
  <circle cx="12" cy="10" r="2.6" fill="#ffffff" stroke="#2a2a2a" stroke-width="1.1" />
</svg>
`.trim()

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  await sharp(Buffer.from(SVG)).png().toFile(OUT_FILE)
  console.log(`Wrote ${path.relative(process.cwd(), OUT_FILE)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
