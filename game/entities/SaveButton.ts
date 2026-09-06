import { Graphics, Text, TextStyle } from "pixi.js"
import { Entity } from "./Entity"
import { SAVE_BUTTON_WIDTH, SAVE_BUTTON_HEIGHT } from "../config/GameConfig"

/**
 * Кнопка сохранения — стоит на поверхности, доступна только муравью.
 * Прогресс (номер текущего уровня) сохраняется в localStorage только в
 * момент, когда муравей до неё доходит — никакого автосохранения на
 * переходах между уровнями (см. GameScene.saveLevelProgress). После
 * нажатия гаснет золотой цвет и загорается зелёный — видно, что сработало.
 */
export class SaveButton extends Entity {
  private knob: Graphics
  private label: Text
  private pressed = false

  constructor(x: number, y: number) {
    super()
    this.container.x = x
    this.container.y = y

    this.width = SAVE_BUTTON_WIDTH
    this.height = SAVE_BUTTON_HEIGHT

    const graphics = new Graphics()

    // Столбик-стойка
    graphics.beginFill(0x6b4a2b)
    graphics.drawRect(-3, -30, 6, 30)
    graphics.endFill()

    this.container.addChild(graphics)

    // Круглая кнопка сверху — отдельная Graphics, чтобы менять её цвет
    // после нажатия, не трогая стойку.
    this.knob = new Graphics()
    this.knob.lineStyle(3, 0x8a6238)
    this.knob.beginFill(0xffd23f)
    this.knob.drawCircle(0, -34, 14)
    this.knob.endFill()
    this.container.addChild(this.knob)

    this.label = new Text({
      text: "💾",
      style: new TextStyle({ fontSize: 16 }),
    })
    this.label.anchor.set(0.5)
    this.label.position.set(0, -34)
    this.container.addChild(this.label)
  }

  /** Помечает кнопку нажатой (один раз) — визуально гаснет в зелёный. */
  public press(): void {
    if (this.pressed) return

    this.pressed = true
    this.knob.clear()
    this.knob.lineStyle(3, 0x2e7d32)
    this.knob.beginFill(0x66bb6a)
    this.knob.drawCircle(0, -34, 14)
    this.knob.endFill()
  }

  public get isPressed(): boolean {
    return this.pressed
  }

  public update(): void {}
}
