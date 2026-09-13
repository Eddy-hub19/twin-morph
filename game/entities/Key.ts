import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import { KEY_SIZE } from "../config/GameConfig"

/**
 * Ключ, спрятанный среди кувшинок у поверхности уровня 3 (вертикальный
 * водоём) — единственный на весь уровень (id "3:key"). Подбор открывает
 * SubmergedPassage у дна того же уровня навсегда (см. GameScene.update,
 * ветка level === 3), в co-op — сразу для ОБОИХ игроков комнаты.
 */
export class Key extends Entity {
  public readonly id: string

  constructor(x: number, y: number, id: string) {
    super()
    this.id = id
    this.container.x = x
    this.container.y = y
    this.width = KEY_SIZE
    this.height = KEY_SIZE

    const graphics = new Graphics()
    // Головка ключа — кольцо.
    graphics.lineStyle(3, 0xffd700)
    graphics.drawCircle(-KEY_SIZE / 4, 0, KEY_SIZE / 4)
    // Стержень + бородка.
    graphics.moveTo(0, 0)
    graphics.lineTo(KEY_SIZE / 2, 0)
    graphics.moveTo(KEY_SIZE / 2.5, 0)
    graphics.lineTo(KEY_SIZE / 2.5, KEY_SIZE / 5)
    graphics.moveTo(KEY_SIZE / 2, 0)
    graphics.lineTo(KEY_SIZE / 2, KEY_SIZE / 4)
    this.container.addChild(graphics)
  }

  public update(): void {
    // Ключ статичен, логика обновления не нужна.
  }
}
