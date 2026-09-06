// Генерирует кадры цикла ходьбы для public/assets/ant/ant-flat.svg.
//
// ant-flat.svg рисован вручную (не растеризован из PNG), поэтому вместо
// традиционной нарезки спрайт-листа (см. buildSprites.js / universalSlice.js,
// которые работают с растровыми кадрами) мы поворачиваем ножки и усики
// муравья вокруг их точек крепления к телу и слегка покачиваем всё тело —
// то же самое можно было бы сделать в рантайме, но так кадры остаются
// простыми статичными SVG, которые грузятся PixiJS как обычные текстуры.
//
// Кадр 0 идентичен исходному ant-flat.svg (нейтральная поза, угол 0), поэтому
// цикл 0..7..0 не даёт "скачка" в начале/конце анимации.
//
// Запуск: node scripts/generateAntWalkFrames.js

const fs = require("fs")
const path = require("path")

const ASSETS_DIR = path.join(process.cwd(), "public/assets/ant")
const OUT_DIR = path.join(ASSETS_DIR, "walk-flat")
const SOURCE_SVG = path.join(ASSETS_DIR, "ant-flat.svg")

const FRAME_COUNT = 8

// Ножки: [pivotX, pivotY, kneeX, kneeY, footX, footY].
// pivot — точка крепления к телу, она не двигается; вращаем колено и стопу.
const LEGS = [
  { pivot: [20, 32], knee: [10, 40], foot: [4, 38] },
  { pivot: [27, 35], knee: [20, 46], foot: [13, 46] },
  { pivot: [35, 34], knee: [34, 46], foot: [28, 50] },
  { pivot: [55, 34], knee: [58, 46], foot: [52, 50] },
  { pivot: [61, 32], knee: [68, 44], foot: [64, 50] },
  { pivot: [67, 29], knee: [78, 38], foot: [84, 36] },
]

// Чередующаяся "триподная" походка: ножки 0,2,4 качаются в одну сторону,
// 1,3,5 — в противофазе (как у насекомых).
const LEG_GROUP = [0, 1, 0, 1, 0, 1]
const LEG_AMPLITUDE = (14 * Math.PI) / 180 // ±14°

// Усики: [baseX, baseY, controlX, controlY, endX, endY] — квадратичная кривая.
const ANTENNAE = [
  { base: [76, 17], control: [84, 4], end: [94, 2] },
  { base: [73, 15], control: [78, 2], end: [86, -4] },
]
const ANTENNA_AMPLITUDE = (6 * Math.PI) / 180 // ±6°
const ANTENNA_PHASE = Math.PI / 4

const BODY_BOB_AMPLITUDE = 1.4 // px, вертикальное покачивание всего тела

function rotatePoint([x, y], [px, py], angle) {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = x - px
  const dy = y - py
  return [px + dx * cos - dy * sin, py + dx * sin + dy * cos]
}

function fmt(n) {
  return Math.round(n * 100) / 100
}

function buildFrame(index) {
  const phase = (2 * Math.PI * index) / FRAME_COUNT

  const legAngles = LEG_GROUP.map((group) => {
    const sign = group === 0 ? 1 : -1
    return sign * LEG_AMPLITUDE * Math.sin(phase)
  })

  const antennaAngle = ANTENNA_AMPLITUDE * Math.sin(phase + ANTENNA_PHASE)

  // Два "проседания" тела за полный цикл — по одному на каждую смену опорной тройки ног.
  const bobY = BODY_BOB_AMPLITUDE * ((1 - Math.cos(2 * phase)) / 2)

  const legPaths = LEGS.map((leg, i) => {
    const angle = legAngles[i]
    const knee = rotatePoint(leg.knee, leg.pivot, angle)
    const foot = rotatePoint(leg.foot, leg.pivot, angle)
    return `    <path d="M${fmt(leg.pivot[0])},${fmt(leg.pivot[1])} L${fmt(knee[0])},${fmt(knee[1])} L${fmt(foot[0])},${fmt(foot[1])}" />`
  }).join("\n")

  const antennaPaths = ANTENNAE.map((antenna) => {
    const control = rotatePoint(antenna.control, antenna.base, antennaAngle)
    const end = rotatePoint(antenna.end, antenna.base, antennaAngle)
    return `  <path d="M${fmt(antenna.base[0])},${fmt(antenna.base[1])} Q${fmt(control[0])},${fmt(control[1])} ${fmt(end[0])},${fmt(end[1])}" stroke="#3a1d10" stroke-width="2.4" stroke-linecap="round" fill="none" />`
  }).join("\n")

  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="62" viewBox="0 -10 100 62">
  <g transform="translate(0,${fmt(bobY)})">
  <!-- Ноги (под телом, чтобы силуэт читался по бокам) -->
  <g stroke="#3a1d10" stroke-width="2.6" stroke-linecap="round" fill="none">
${legPaths}
  </g>

  <!-- Усики -->
${antennaPaths}

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

  <!-- Глаз -->
  <circle cx="76" cy="18" r="3.6" fill="#151008" />
  <circle cx="75" cy="16.5" r="1.2" fill="#ffffff" />
  </g>
</svg>
`
}

function main() {
  if (!fs.existsSync(SOURCE_SVG)) {
    console.error(`❌ Не найден ${SOURCE_SVG}`)
    process.exit(1)
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })

  // Кадр 0 = оригинальный ant-flat.svg без изменений (угол 0 во всех формулах
  // выше даёт математически то же самое, но копируем исходник напрямую,
  // чтобы не было расхождений в форматировании).
  fs.copyFileSync(SOURCE_SVG, path.join(OUT_DIR, "frame-0.svg"))
  console.log("✅ frame-0.svg (= ant-flat.svg)")

  for (let i = 1; i < FRAME_COUNT; i++) {
    const svg = buildFrame(i)
    const outPath = path.join(OUT_DIR, `frame-${i}.svg`)
    fs.writeFileSync(outPath, svg)
    console.log(`✅ frame-${i}.svg`)
  }

  console.log(`\nГотово: ${FRAME_COUNT} кадров в ${OUT_DIR}`)
}

main()
