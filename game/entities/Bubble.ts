import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import { BUBBLE_SIZE } from "../config/GameConfig"

/**
 * Пузырёк света — разовый подбираемый предмет, который навсегда увеличивает
 * радиус видимости в тумане войны (см. GameScene.lightRadius). Внешне это
 * светящийся голубоватый шарик — мягкое свечение вокруг яркого ядра, чтобы
 * явно отличаться от золотых звёзд и жёлтых блоков руды.
 */
export class Bubble extends Entity {
  constructor(x: number, y: number) {
    super()
    this.container.x = x
    this.container.y = y

    this.width = BUBBLE_SIZE
    this.height = BUBBLE_SIZE

    const graphics = new Graphics()

    graphics.beginFill(0x8ee3ff, 0.3)
    graphics.drawCircle(0, 0, BUBBLE_SIZE / 2)
    graphics.endFill()

    graphics.beginFill(0xe3faff, 0.9)
    graphics.drawCircle(0, 0, 6)
    graphics.endFill()

    this.container.addChild(graphics)
  }

  public update(): void {
    // Пузырёк статичен, логика обновления не нужна.
  }
}
