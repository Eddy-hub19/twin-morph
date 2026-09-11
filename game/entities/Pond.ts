import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import { WATER_DEEP_COLOR, WATER_SHALLOW_COLOR, WATER_HIGHLIGHT_COLOR } from "../config/GameConfig"

/**
 * Большой ставок посреди уровня 3 (индекс 2) — единственная преграда
 * сегмента, делящая его на два берега (заменяет прежние мелкие Puddle).
 * Муравей не умеет плавать: столкновение с прудом там, где соответствующий
 * BridgeSlot ещё не установлен, топит его (см. GameScene.update -> Ant.drown),
 * а не просто отталкивает назад, как раньше делала лужа.
 *
 * Координаты — левый верхний угол (как у Wall/Puddle), не центр.
 */
export class Pond extends Entity {
  constructor(x: number, y: number, width: number, height: number) {
    super()
    this.container.x = x
    this.container.y = y
    this.width = width
    this.height = height

    const water = new Graphics()
    water.beginFill(WATER_DEEP_COLOR)
    water.drawRoundedRect(0, 0, width, height, height / 4)
    water.endFill()

    water.beginFill(WATER_SHALLOW_COLOR, 0.5)
    water.drawRoundedRect(0, 0, width, height * 0.5, height / 4)
    water.endFill()

    this.container.addChild(water)

    const highlightCount = Math.max(4, Math.round(width / 60))
    for (let i = 0; i < highlightCount; i++) {
      const cx = ((i + 0.5) / highlightCount) * width
      const cy = height * (0.3 + Math.random() * 0.4)
      const highlight = new Graphics()
      highlight.beginFill(WATER_HIGHLIGHT_COLOR, 0.25 + Math.random() * 0.15)
      highlight.drawEllipse(cx, cy, 16 + Math.random() * 10, 5 + Math.random() * 3)
      highlight.endFill()
      this.container.addChild(highlight)
    }
  }

  public update(): void {
    // Ставок статичен, логика обновления не нужна.
  }
}
