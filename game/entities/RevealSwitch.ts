import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import { REVEAL_SWITCH_WIDTH, REVEAL_SWITCH_HEIGHT } from "../config/GameConfig"

/**
 * Факел-выключатель — разовый предмет на уровень. Подобрав его, игрок на
 * минуту видит всю карту без тумана войны (см. GameScene.revealTimer).
 * Внешне — воткнутый в землю факел с ярким оранжевым пламенем, чтобы явно
 * отличаться от золотых звёзд и голубых пузырьков света.
 */
export class RevealSwitch extends Entity {
  /** Стабильный id ("level:switch") — см. Star.id, тот же принцип; факел один на уровень. */
  public readonly id: string

  constructor(x: number, y: number, id: string) {
    super()
    this.id = id
    this.container.x = x
    this.container.y = y

    this.width = REVEAL_SWITCH_WIDTH
    this.height = REVEAL_SWITCH_HEIGHT

    const graphics = new Graphics()

    // Рукоять факела
    graphics.beginFill(0x6b4a2b)
    graphics.drawRect(-3, 2, 6, 14)
    graphics.endFill()

    // Мягкое свечение вокруг пламени
    graphics.beginFill(0xffb84d, 0.35)
    graphics.drawCircle(0, -8, 14)
    graphics.endFill()

    // Само пламя
    graphics.beginFill(0xff8c1a)
    graphics.drawCircle(0, -8, 8)
    graphics.endFill()
    graphics.beginFill(0xffe066)
    graphics.drawCircle(0, -10, 4)
    graphics.endFill()

    this.container.addChild(graphics)
  }

  public update(): void {}
}
