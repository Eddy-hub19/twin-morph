import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import { CHECKPOINT_WIDTH, CHECKPOINT_HEIGHT } from "../config/GameConfig"

/**
 * Маркер чекпоінта перед ставком — на відміну від SaveButton, оновлюється
 * КОЖЕН раз, коли активний гравець до нього торкається (можна проходити
 * туди-сюди), а не одноразово. GameScene сам вирішує, коли саме зберегти
 * позицію (див. GameScene.update — читає isColliding, а не якийсь внутрішній
 * стан "натиснуто"), ця сутність — лише прапорець-орієнтир.
 */
export class Checkpoint extends Entity {
  constructor(x: number, y: number) {
    super()
    this.container.x = x
    this.container.y = y

    this.width = CHECKPOINT_WIDTH
    this.height = CHECKPOINT_HEIGHT

    const pole = new Graphics()
    pole.beginFill(0x8a6238)
    pole.drawRect(-2, -40, 4, 40)
    pole.endFill()
    this.container.addChild(pole)

    const flag = new Graphics()
    flag.beginFill(0xffe066)
    flag.moveTo(2, -40)
    flag.lineTo(20, -33)
    flag.lineTo(2, -26)
    flag.closePath()
    flag.endFill()
    this.container.addChild(flag)
  }

  public update(): void {
    // Чекпоінт статичний, логіка оновлення не потрібна.
  }
}
