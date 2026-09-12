import { Container } from "pixi.js"

export abstract class Entity {
  public container = new Container()
  public width: number = 0
  public height: number = 0

  /**
   * Где именно (container.x, container.y) находится относительно рамки
   * столкновений width x height — доля [0, 1] по каждой оси, тот же принцип,
   * что и у PIXI Sprite.anchor. 0 (по умолчанию) — container.x/y это ЛЕВЫЙ
   * ВЕРХНИЙ угол рамки, как у Wall/большинства остальных статичных сущностей
   * (их спрайты/Graphics и рисуются от (0,0), без anchor). 0.5 — центр, как у
   * спрайтов с anchor.set(0.5) (Worm/Frog/EnemyWorm/GuardWorm) и у Star (круг,
   * нарисованный вокруг локального (0,0)). У Ant originY = 0.85, а не 0.5, —
   * ровно её собственный sprite.anchor.set(0.5, 0.85) (см. Ant.ts): контейнер
   * стоит не в геометрическом центре спрайта, а ближе к его "ногам".
   * Без этого getBounds() у сущностей с центрированным спрайтом молчаливо
   * считал container.x/y их левым верхним углом — видимое касание съезжало
   * относительно реальной рамки столкновений на половину ширины/высоты
   * вправо-вниз (см. Worm/Ant/Frog/Star, где origin переопределён).
   */
  protected originX = 0
  protected originY = 0

  // walls/stars — не типизированы конкретно здесь специально: разным
  // сущностям нужны разные вещи (Worm/EnemyWorm/GuardWorm — WallLookup для
  // O(1)-поиска стены под точкой, см. entities/Wall.ts; большинству
  // остальных — вообще ничего, их update() пуст). Базовый класс намеренно
  // не знает о конкретных типах, чтобы не тянуть их сюда через импорт.
  public abstract update(deltaTime: number, walls?: unknown, stars?: unknown): void

  public getBounds() {
    return {
      x: this.container.x - this.width * this.originX,
      y: this.container.y - this.height * this.originY,
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
