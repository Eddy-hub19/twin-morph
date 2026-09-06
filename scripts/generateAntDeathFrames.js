// Генерирует кадры анимации смерти для public/assets/ant/ant-flat.svg.
//
// Та же идея, что и в generateAntWalkFrames.js: муравей рисован вручную
// простым SVG, поэтому вместо спрайт-листа мы просто трансформируем разметку
// покадрово. Тут кадры отвечают только за поджатие ножек (это меняет форму,
// поэтому нужен пересчёт точек) и "потухший" крестик вместо глаза.
//
// Заваливание на спину сюда НЕ запечено: если повернуть весь силуэт на
// ~170° внутри исходного узкого viewBox (100x62), большая часть рисунка
// вылетает за его границы и обрезается. Вместо этого поворот тела делает
// PixiJS через sprite.rotation в рантайме (см. Ant.ts) — канвас остаётся
// прежнего размера, и masштаб не "плывёт" при переключении на кадры смерти.
//
// Кадр 0 — снова нейтральная поза, идентичная ant-flat.svg.
//
// Запуск: node scripts/generateAntDeathFrames.js

const fs = require("fs")
const path = require("path")

const ASSETS_DIR = path.join(process.cwd(), "public/assets/ant")
const OUT_DIR = path.join(ASSETS_DIR, "dead-flat")
const SOURCE_SVG = path.join(ASSETS_DIR, "ant-flat.svg")

const FRAME_COUNT = 6

// Те же ножки, что и в generateAntWalkFrames.js.
const LEGS = [
  { pivot: [20, 32], knee: [10, 40], foot: [4, 38] },
  { pivot: [27, 35], knee: [20, 46], foot: [13, 46] },
  { pivot: [35, 34], knee: [34, 46], foot: [28, 50] },
  { pivot: [55, 34], knee: [58, 46], foot: [52, 50] },
  { pivot: [61, 32], knee: [68, 44], foot: [64, 50] },
  { pivot: [67, 29], knee: [78, 38], foot: [84, 36] },
]

function fmt(n) {
  return Math.round(n * 100) / 100
}

function lerpPoint([x1, y1], [x2, y2], t) {
  return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]
}

function buildFrame(index) {
  const t = index / (FRAME_COUNT - 1)
  // Плавное замедление к концу.
  const easedT = 1 - (1 - t) * (1 - t)

  // Ножки поджимаются к телу по мере падения (от 1 = вытянуты, до 0.35 = поджаты).
  const curl = 1 - 0.65 * easedT
  const showDeadEyes = t > 0.55

  const legPaths = LEGS.map((leg) => {
    const knee = lerpPoint(leg.pivot, leg.knee, curl)
    const foot = lerpPoint(leg.pivot, leg.foot, curl)
    return `    <path d="M${fmt(leg.pivot[0])},${fmt(leg.pivot[1])} L${fmt(knee[0])},${fmt(knee[1])} L${fmt(foot[0])},${fmt(foot[1])}" />`
  }).join("\n")

  const eyeMarkup = showDeadEyes
    ? `  <path d="M73,15 L78,20 M78,15 L73,20" stroke="#151008" stroke-width="1.6" stroke-linecap="round" />`
    : `  <circle cx="76" cy="18" r="3.6" fill="#151008" />
  <circle cx="75" cy="16.5" r="1.2" fill="#ffffff" />`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="62" viewBox="0 -10 100 62">
  <!-- Ноги (под телом, чтобы силуэт читался по бокам) -->
  <g stroke="#3a1d10" stroke-width="2.6" stroke-linecap="round" fill="none">
${legPaths}
  </g>

  <!-- Усики -->
  <path d="M76,17 Q84,4 94,2" stroke="#3a1d10" stroke-width="2.4" stroke-linecap="round" fill="none" />
  <path d="M73,15 Q78,2 86,-4" stroke="#3a1d10" stroke-width="2.4" stroke-linecap="round" fill="none" />

  <!-- Брюшко -->
  <ellipse cx="25" cy="26" rx="22" ry="15" fill="#a8462e" stroke="#5c2416" stroke-width="2" />
  <path d="M14,15 Q25,20 14,37" stroke="#7a2f1c" stroke-width="2" fill="none" opacity="0.6" />
  <path d="M22,13 Q34,20 22,39" stroke="#7a2f1c" stroke-width="2" fill="none" opacity="0.6" />
  <path d="M31,14 Q41,20 31,38" stroke="#7a2f1c" stroke-width="2" fill="none" opacity="0.6" />
  <ellipse cx="18" cy="20" rx="7" ry="4" fill="#c96449" opacity="0.55" />

  <!-- Грудь -->
  <ellipse cx="51" cy="27" rx="13" ry="11" fill="#b14f34" stroke="#5c2416" stroke-width="2" />

  <!-- Голова -->
  <ellipse cx="73" cy="23" rx="12" ry="10.5" fill="#c1543a" stroke="#5c2416" stroke-width="2" />

  <!-- Челюсти -->
  <path d="M83,25 L92,22 L84,29 Z" fill="#3a1d10" />
  <path d="M83,20 L92,16 L85,24 Z" fill="#3a1d10" />

  <!-- Глаз (крестик — потух, как только муравей упал) -->
${eyeMarkup}
</svg>
`
}

function main() {
  if (!fs.existsSync(SOURCE_SVG)) {
    console.error(`❌ Не найден ${SOURCE_SVG}`)
    process.exit(1)
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })

  fs.copyFileSync(SOURCE_SVG, path.join(OUT_DIR, "frame-0.svg"))
  console.log("✅ frame-0.svg (= ant-flat.svg)")

  for (let i = 1; i < FRAME_COUNT; i++) {
    fs.writeFileSync(path.join(OUT_DIR, `frame-${i}.svg`), buildFrame(i))
    console.log(`✅ frame-${i}.svg`)
  }

  console.log(`\nГотово: ${FRAME_COUNT} кадров в ${OUT_DIR}`)
}

main()
