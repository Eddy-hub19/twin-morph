import { Application, Container } from "pixi.js"
import { InputManager } from "../input/InputManager"

export abstract class Scene {
  public readonly container = new Container()
  protected app!: Application
  protected input!: InputManager

  public init(app: Application, input: InputManager): void {
    this.app = app
    this.input = input

    this.app.stage.addChild(this.container)
    this.onCreate()
  }

  protected abstract onCreate(): void
  public abstract update(deltaTime: number): void

  /** Пауза (см. Engine.setPaused/GameScene.setPaused) — не абстрактный, а
   * пустая реализация по умолчанию: не у каждой сцены есть что ставить на
   * паузу (сейчас единственная сцена — GameScene, но интерфейс общий). */
  public setPaused(_paused: boolean): void {}

  /** Перезапуск текущего уровня "с нуля" (см. GameScene.restartLevel) — тоже
   * пустая реализация по умолчанию по той же причине, что и setPaused выше. */
  public restartLevel(): void {}

  public destroy(): void {
    this.onDestroy()
    this.container.destroy({ children: true })
  }

  protected onDestroy(): void {}
}
