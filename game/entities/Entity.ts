import { Container } from "pixi.js"

export abstract class Entity {
  public container = new Container()
  public width: number = 0
  public height: number = 0

  // walls/stars — не типизированы конкретно здесь специально: разным
  // сущностям нужны разные вещи (Worm/EnemyWorm/GuardWorm — WallLookup для
  // O(1)-поиска стены под точкой, см. entities/Wall.ts; большинству
  // остальных — вообще ничего, их update() пуст). Базовый класс намеренно
  // не знает о конкретных типах, чтобы не тянуть их сюда через импорт.
  public abstract update(deltaTime: number, walls?: unknown, stars?: unknown): void

  public getBounds() {
    return {
      x: this.container.x,
      y: this.container.y,
      width: this.width,
      height: this.height,
    }
  }

  public isColliding(other: Entity): boolean {
    const a = this.getBounds()
    const b = other.getBounds()
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  }

  public destroy(): void {
    this.container.destroy({ children: true })
  }
}
