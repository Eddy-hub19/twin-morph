import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import { WATER_DEEP_COLOR, WATER_SHALLOW_COLOR, WATER_HIGHLIGHT_COLOR, WATER_HIGHLIGHT_COUNT } from "../config/GameConfig"

/**
 * Задник уровня 4+ (индекс 3+) — в отличие от Sky (небо только над травой),
 * Water закрывает СЕСЬ сегмент целиком, от верха до низа: жаба плавает не по
 * одной линии, а свободно во всей толще, так что "земли"/"неба" тут больше
 * нет вообще, весь уровень — вода.
 *
 * Рисуется вертикальным градиентом (Graphics.fill с FillGradient недоступен
 * в этой версии Pixi так же гибко, как canvas — поэтому, как и в Puddle/Fog,
 * применяем несколько полупрозрачных слоёв вместо честного градиента):
 * тёмный низ (глубина) и более светлый верх (ближе к поверхности), плюс
 * раскиданные блики — то же приём, что и у бликов Puddle, только по всей
 * площади сегмента, а не в одной узкой полосе.
 *
 * Координаты — левый верхний угол области (как у Sky/Wall), а не центр.
 */
export class Water extends Entity {
  constructor(x: number, y: number, width: number, height: number) {
    super()
    this.container.x = x
    this.container.y = y
    this.width = width
    this.height = height

    const bg = new Graphics()
    bg.beginFill(WATER_DEEP_COLOR)
    bg.drawRect(0, 0, width, height)
    bg.endFill()
    this.container.addChild(bg)

    // Полоса посветлее у самого верха — читается как более мелкая, ближе к
    // поверхности вода, без честного градиента.
    const shallow = new Graphics()
    shallow.beginFill(WATER_SHALLOW_COLOR, 0.55)
    shallow.drawRect(0, 0, width, height * 0.4)
    shallow.endFill()
    this.container.addChild(shallow)

    const drawHighlight = (cx: number, cy: number, scale: number) => {
      const highlight = new Graphics()
      highlight.beginFill(WATER_HIGHLIGHT_COLOR, 0.25 + Math.random() * 0.15)
      highlight.drawEllipse(0, 0, 30 * scale, 8 * scale)
      highlight.endFill()
      highlight.position.set(cx, cy)
      this.container.addChild(highlight)
    }

    for (let i = 0; i < WATER_HIGHLIGHT_COUNT; i++) {
      const cx = Math.random() * width
      const cy = Math.random() * height
      const scale = 0.6 + Math.random() * 1.1
      drawHighlight(cx, cy, scale)
    }
  }

  public update(): void {
    // Задник статичен, логика обновления не нужна.
  }
}
