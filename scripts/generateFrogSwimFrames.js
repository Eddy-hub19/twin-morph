// Генерирует кадры цикла плавания для public/assets/frog/frog-flat.svg.
//
// Тот же приём, что и в generateAntWalkFrames.js: frog-flat.svg рисован
// вручную, поэтому вместо нарезки растрового спрайт-листа мы поворачиваем
// заднюю (толчковую) и переднюю лапки вокруг их точек крепления к телу и
// слегка покачиваем тело — кадры остаются простыми статичными SVG,
// загружаемыми PixiJS как обычные текстуры.
//
// Кадр 0 идентичен исходному frog-flat.svg (нейтральная поза, угол 0),
// поэтому цикл 0..N-1..0 не даёт "скачка" в начале/конце анимации.
//
// Запуск: node scripts/generateFrogSwimFrames.js

const fs = require("fs")
const path = require("path")

const ASSETS_DIR = path.join(process.cwd(), "public/assets/frog")
const OUT_DIR = path.join(ASSETS_DIR, "swim-flat")
const SOURCE_SVG = path.join(ASSETS_DIR, "frog-flat.svg")

const FRAME_COUNT = 6

// Задняя (толчковая) лапа — целиком вращается вокруг pivot как одна жёсткая
// группа (в отличие от муравья, где каждая ножка гнётся в колене, лапка
// лягушки на гребке распрямляется/поджимается практически прямой).
const BACK_LEG_PIVOT = [20, 38]
const BACK_LEG_POINTS = [
  [4, 46],
  [2, 50],
  [4, 54],
  [-4, 42],
  [-2, 48],
  [-2, 52],
]
const BACK_LEG_AMPLITUDE = (20 * Math.PI) / 180 // ±20° — основной гребок

// Передняя лапка — двигается заметно слабее и в противофазе (у настоящих
// лягушек передние лапки почти не участвуют в гребке, только подруливают).
const FRONT_LEG_PIVOT = [60, 44]
const FRONT_LEG_POINTS = [
  [67, 54],
  [71, 58],
  [65, 59],
  [61, 58],
]
const FRONT_LEG_AMPLITUDE = (8 * Math.PI) / 180 // ±8°

const BODY_BOB_AMPLITUDE = 1.6 // px, вертикальное покачивание всего тела на гребке

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

  const backAngle = BACK_LEG_AMPLITUDE * Math.sin(phase)
  const frontAngle = -FRONT_LEG_AMPLITUDE * Math.sin(phase)

  // Один "провал" тела за полный цикл гребка.
  const bobY = BODY_BOB_AMPLITUDE * Math.sin(phase)

  const [back1, back2, back3, back4, back5, back6] = BACK_LEG_POINTS.map((p) => rotatePoint(p, BACK_LEG_PIVOT, backAngle))
  const [front1, front2, front3, front4] = FRONT_LEG_POINTS.map((p) => rotatePoint(p, FRONT_LEG_PIVOT, frontAngle))

  const bp = (p) => `${fmt(p[0])},${fmt(p[1])}`
  const pivotBack = bp(BACK_LEG_PIVOT)
  const pivotFront = bp(FRONT_LEG_PIVOT)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="70" viewBox="-8 -16 108 82">
  <g transform="translate(0,${fmt(bobY)})">
  <!-- Задние (толчковые/плавательные) лапы -->
  <g stroke="#2f4a1d" stroke-width="2.4" stroke-linecap="round" fill="none">
    <path d="M${pivotBack} L${bp(back1)}" />
    <path d="M${pivotBack} L${bp(back2)}" />
    <path d="M${pivotBack} L${bp(back3)}" />
  </g>
  <path d="M${pivotBack} L${bp(back1)} L${bp(back4)} M${bp(back1)} L${bp(back5)} M${bp(back1)} L${bp(back6)}" stroke="#2f4a1d" stroke-width="1.6" stroke-linecap="round" fill="none" />

  <!-- Передние лапки -->
  <g stroke="#2f4a1d" stroke-width="2.2" stroke-linecap="round" fill="none">
    <path d="M${pivotFront} L${bp(front1)}" />
    <path d="M${bp(front1)} L${bp(front2)}" />
    <path d="M${bp(front1)} L${bp(front3)}" />
    <path d="M${bp(front1)} L${bp(front4)}" />
  </g>

  <!-- Тело -->
  <ellipse cx="42" cy="30" rx="30" ry="19" fill="#6b9c46" stroke="#33481f" stroke-width="2.4" />

  <!-- Брюшко -->
  <ellipse cx="37" cy="38" rx="19" ry="9" fill="#d7edac" opacity="0.75" />

  <!-- Пятна -->
  <ellipse cx="26" cy="20" rx="5" ry="3.5" fill="#4d7a30" opacity="0.6" />
  <ellipse cx="48" cy="16" rx="4.5" ry="3" fill="#4d7a30" opacity="0.6" />
  <ellipse cx="34" cy="34" rx="4" ry="2.6" fill="#4d7a30" opacity="0.45" />

  <!-- Глаза (бугорки на макушке, ближе к "лицевой" правой стороне) -->
  <circle cx="58" cy="12" r="8" fill="#6b9c46" stroke="#33481f" stroke-width="2" />
  <circle cx="72" cy="14" r="7.5" fill="#6b9c46" stroke="#33481f" stroke-width="2" />
  <circle cx="59" cy="11" r="3.6" fill="#151d0d" />
  <circle cx="73" cy="13" r="3.4" fill="#151d0d" />
  <circle cx="57.5" cy="9.5" r="1.2" fill="#ffffff" />
  <circle cx="71.5" cy="11.5" r="1.1" fill="#ffffff" />

  <!-- Улыбка -->
  <path d="M54,26 Q66,32 78,24" stroke="#33481f" stroke-width="2" fill="none" stroke-linecap="round" />
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

  // Кадр 0 = оригинальный frog-flat.svg без изменений (угол 0 во всех
  // формулах выше даёт математически то же самое, но копируем исходник
  // напрямую, чтобы не было расхождений в форматировании).
  fs.copyFileSync(SOURCE_SVG, path.join(OUT_DIR, "frame-0.svg"))
  console.log("✅ frame-0.svg (= frog-flat.svg)")

  for (let i = 1; i < FRAME_COUNT; i++) {
    const svg = buildFrame(i)
    const outPath = path.join(OUT_DIR, `frame-${i}.svg`)
    fs.writeFileSync(outPath, svg)
    console.log(`✅ frame-${i}.svg`)
  }

  console.log(`\nГотово: ${FRAME_COUNT} кадров в ${OUT_DIR}`)
}

main()
