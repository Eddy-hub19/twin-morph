const fs = require("fs")
const path = require("path")
const { packAsync } = require("free-tex-packer-core")

const ASSETS_DIR = path.join(process.cwd(), "public/assets")

async function buildAnimation(character, animation) {
  const inputDir = path.join(ASSETS_DIR, character, animation)

  const files = fs
    .readdirSync(inputDir)
    .filter((file) => file.endsWith(".png") && file !== `${animation}.png`)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  if (!files.length) {
    return
  }

  // ИСПРАВЛЕНО: Даем каждому кадру уникальный ID (path) вида "ant_walk_0.png",
  // чтобы они не конфликтовали в глобальном кэше PixiJS
  const textures = files.map((file) => ({
    path: `${character}_${animation}_${file}`,
    contents: fs.readFileSync(path.join(inputDir, file)),
  }))

  const options = {
    textureName: animation,
    width: 2048,
    height: 2048,
    fixedSize: false,

    exporter: "Pixi",
    removeFileExtension: false,
    prependFolderName: false,

    allowRotation: false,
    detectIdentical: false,
    trim: false,

    scale: 1,
  }

  const result = await packAsync(textures, options)

  const outputDir = inputDir

  result.forEach((file) => {
    const outputPath = path.join(outputDir, file.name)

    if (file.name.endsWith(".json")) {
      const json = JSON.parse(file.buffer.toString())

      // ИСПРАВЛЕНО: Массив анимаций тоже должен использовать уникальные имена кадров
      json.animations = {
        [animation]: files.map((file) => `${character}_${animation}_${file}`),
      }

      fs.writeFileSync(outputPath, JSON.stringify(json, null, 2))
    } else {
      fs.writeFileSync(outputPath, file.buffer)
    }
  })

  console.log(`✅ ${character}/${animation}`)
}

async function build() {
  const characters = fs.readdirSync(ASSETS_DIR).filter((name) => fs.statSync(path.join(ASSETS_DIR, name)).isDirectory())

  for (const character of characters) {
    const animations = fs
      .readdirSync(path.join(ASSETS_DIR, character))
      .filter((name) => fs.statSync(path.join(ASSETS_DIR, character, name)).isDirectory())

    for (const animation of animations) {
      await buildAnimation(character, animation)
    }
  }

  console.log("🎉 Done")
}

build()
