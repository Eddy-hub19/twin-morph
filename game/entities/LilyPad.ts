import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import { LILY_PAD_SIZE } from "../config/GameConfig"

/**
 * Кувшинка у поверхности уровня 3 (вертикальный водоём) — разовый подбираемый
 * предмет, чисто "флейвор"-коллекционка (подтверждает, что жаба всплыла к
 * поверхности), без влияния на прохождение. Среди таких же кувшинок спрятан
 * один Key — визуально другая сущность на том же месте розыгрыша позиций (см.
 * GameScene.generateNextLevel, level === 3).
 */
export class LilyPad extends Entity {
  /** Стабильный id ("3:lilypad:index") — тот же принцип, что и Star.id/Bubble.id. */
  public readonly id: string

  constructor(x: number, y: number, id: string) {
    super()
    this.id = id
    this.container.x = x
    this.container.y = y
    this.width = LILY_PAD_SIZE
    this.height = LILY_PAD_SIZE

    const graphics = new Graphics()
    graphics.beginFill(0x4caf50)
    graphics.drawEllipse(0, 0, LILY_PAD_SIZE / 2, LILY_PAD_SIZE / 2.6)
    graphics.endFill()
    graphics.beginFill(0xff8fb3, 0.9)
    graphics.drawCircle(0, -1, 3)
    graphics.endFill()
    this.container.addChild(graphics)
  }

  public update(): void {
    // Кувшинка статична, логика обновления не нужна.
  }
}
