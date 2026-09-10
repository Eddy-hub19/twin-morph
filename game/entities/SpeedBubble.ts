import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import { BUBBLE_SIZE } from "../config/GameConfig"

/**
 * Пузырёк скорости — разовый подбираемый предмет: на SPEED_BOOST_DURATION
 * секунд вдвое ускоряет ходьбу/копание (см. GameScene.speedBoostEndsAt). В
 * отличие от обычного пузырька света (Bubble — голубой, эффект постоянный),
 * этот жёлто-зелёный, с молнией внутри — явно читается как "скорость", а не
 * "свет", и эффект временный. В co-op действует сразу на обоих игроков
 * комнаты (см. RoomLevelState.speedBoostEndsAt) — как и факел-выключатель.
 */
export class SpeedBubble extends Entity {
  /** Стабильный id ("level:speed:index") — см. Star.id, тот же принцип. */
  public readonly id: string

  constructor(x: number, y: number, id: string) {
    super()
    this.id = id
    this.container.x = x
    this.container.y = y

    this.width = BUBBLE_SIZE
    this.height = BUBBLE_SIZE

    const graphics = new Graphics()

    graphics.beginFill(0xd4ff5e, 0.32)
    graphics.drawCircle(0, 0, BUBBLE_SIZE / 2)
    graphics.endFill()

    // Молния — понятный "скоростной" символ, без подписи и без спутывания
    // со светлым ядром обычного пузырька.
    graphics.beginFill(0xfff9c4)
    graphics.moveTo(1, -8)
    graphics.lineTo(-5, 1)
    graphics.lineTo(-1, 1)
    graphics.lineTo(-2, 8)
    graphics.lineTo(5, -1)
    graphics.lineTo(1, -1)
    graphics.closePath()
    graphics.endFill()

    this.container.addChild(graphics)
  }

  public update(): void {
    // Пузырёк статичен, логика обновления не нужна.
  }
}
