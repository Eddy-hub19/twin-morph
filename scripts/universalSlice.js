const fs = require("fs")
const path = require("path")
const sharp = require("sharp")

// Твоя корневая папка ассетов (та же, что и в buildSprites.js)
const ASSETS_DIR = path.join(process.cwd(), "public/assets")

/**
 * Основная функция нарезки для одного персонажа
 */
async function sliceCharacter(characterName) {
  const charDir = path.join(ASSETS_DIR, characterName)

  // Определяем пути к файлам согласно нашей конвенции
  const inputImage = path.join(charDir, `${characterName}.png`)
  const configPath = path.join(charDir, "slice_config.json")

  // ВАЛИДАЦИЯ: Пропускаем папку, если нет PNG или JSON конфига
  if (!fs.existsSync(configPath)) {
    console.warn(`⚠️ Пропущена папка ${characterName}: Не найден slice_config.json`)
    return
  }
  if (!fs.existsSync(inputImage)) {
    console.warn(`⚠️ Пропущена папка ${characterName}: Не найден ${characterName}.png`)
    return
  }

  console.log(`\n⏳ Начинаю нарезку для: ${characterName}...`)

  // Читаем и парсим JSON конфиг
  let config
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"))
  } catch (e) {
    console.error(`❌ Ошибка чтения JSON в ${characterName}: ${e}`)
    return
  }

  const { cols, rows, rowMap } = config

  // Читаем метаданные картинки, чтобы узнать ширину/высоту
  let metadata
  try {
    metadata = await sharp(inputImage).metadata()
  } catch (e) {
    console.error(`❌ Ошибка чтения PNG в ${characterName}: ${e}`)
    return
  }

  // Вычисляем размер одного кадра (пиксели)
  const frameW = Math.floor(metadata.width / cols)
  const frameH = Math.floor(metadata.height / rows)

  // ОСНОВНОЙ ЦИКЛ НАРЕЗКИ ПО СЕТКЕ
  for (let r = 0; r < rows; r++) {
    // Берем имя анимации из мапы (если её нет в JSON — используем "row_0", "row_1")
    const animName = rowMap && rowMap[r] ? rowMap[r] : `row_${r}`
    const animDir = path.join(charDir, animName)

    // Создаем папку анимации (например: assets/ant/walk), если её нет
    if (!fs.existsSync(animDir)) {
      fs.mkdirSync(animDir, { recursive: true })
    }

    // Вырезаем колонки для этой строки
    for (let c = 0; c < cols; c++) {
      const outputPath = path.join(animDir, `${c}.png`)

      // sharp умеет делать точную обрезку
      await sharp(inputImage)
        .extract({
          left: c * frameW,
          top: r * frameH,
          width: frameW,
          height: frameH,
        })
        .toFile(outputPath)
    }
  }

  console.log(`✅ ${characterName} успешно нарезан по папкам (${cols}x${rows})`)
}

/**
 * Точка входа в скрипт
 */
async function main() {
  if (!fs.existsSync(ASSETS_DIR)) {
    console.error(`❌ Директория ассетов не найдена: ${ASSETS_DIR}`)
    return
  }

  // Читаем все папки в assets/
  const allItems = fs.readdirSync(ASSETS_DIR)
  const characters = allItems.filter((name) => fs.statSync(path.join(ASSETS_DIR, name)).isDirectory())

  // Перебираем всех персонажей последовательно (async/await)
  for (const char of characters) {
    await sliceCharacter(char)
  }

  console.log("\n🎉 Нарезка всех персонажей завершена! Теперь можешь запускать упаковщик (buildSprites.js).")
}

main().catch(console.error)
