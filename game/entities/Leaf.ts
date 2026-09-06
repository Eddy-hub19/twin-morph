import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import { LEAF_SIZE } from "../config/GameConfig"

/**
 * Кусочек листа — подбираемый предмет на уровне 3 (индекс 2+, поверхность за
 * травой). Муравей носит подобранные листья с собой (GameScene.carriedLeaves)
 * и тратит по одному, чтобы навести временный мостик через лужу (см.
 * Puddle.placeBridge). Рисуется как обычный подбираемый предмет (Star,
 * Bubble) — центр формы в локальном (0,0), а не в углу (см. их же комментарий
 * про несовпадение визуального центра и AABB для столкновений).
 */
export class Leaf extends Entity {
  constructor(x: number, y: number) {
    super()
    this.container.x = x
    this.container.y = y

    this.width = LEAF_SIZE
    this.height = LEAF_SIZE

    const graphics = new Graphics()

    graphics.beginFill(0x5cb85c)
    graphics.drawEllipse(0, 0, LEAF_SIZE / 2, LEAF_SIZE / 2.6)
    graphics.endFill()

    graphics.lineStyle(1.5, 0x3d7a3d)
    graphics.moveTo(-LEAF_SIZE / 2 + 2, 0)
    graphics.lineTo(LEAF_SIZE / 2 - 2, 0)

    this.container.addChild(graphics)
  }

  public update(): void {
    // Лист статичен, логика обновления не нужна.
  }
}
