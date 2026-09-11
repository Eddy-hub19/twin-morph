import { Application } from "pixi.js"
import { Time } from "./Time"
import { Scene } from "../scenes/Scene"
import { GameScene } from "../scenes/GameScene"
import { InputManager } from "../input/InputManager"
import { AssetLoader } from "../assets/AssetLoader"

export class Engine {
  private app: Application | null = null
  private readonly time = new Time()
  private scene: Scene | null = null
  public readonly input = new InputManager()

  /** Dev-only FPS-подписчик (см. Game.tsx) — вызывается тем же ticker-колбеком,
   * что и update(), а не отдельным rAF-циклом. null, если оверлей не включён. */
  private onFpsSample: ((fps: number) => void) | null = null

  constructor(private container: HTMLDivElement) {}

  public async initialize(): Promise<void> {
    this.app = new Application()

    await this.app.init({
      resizeTo: this.container,
      background: "0x1A110B",
      antialias: true,
    })

    await AssetLoader.load()

    this.scene = new GameScene()
    this.scene.init(this.app, this.input)

    this.app.ticker.add(this.update)
    this.container.appendChild(this.app.canvas)
  }

  /** Полностью останавливает движок: снимает ticker-колбек, рвёт слушатели
   * клавиатуры (InputManager.destroy), уничтожает текущую сцену (Scene.destroy
   * -> Entity.destroy на всех сущностях) и сам PIXI Application вместе с
   * канвасом. Текстуры НЕ трогаем (texture: false) — они кешированы через
   * Assets.load и должны пережить повторный initialize() (следующий mount
   * компонента/HMR), иначе он либо упадёт, либо будет грузить всё заново. */
  public destroy(): void {
    if (!this.app) return

    // Опциональная цепочка — на случай, если destroy() всё же вызовут (или
    // будет вызван повторно) для Application, у которого init() ещё не
    // успел довыполниться (тикер/рендерер тогда ещё не существуют); в
    // норме этого не происходит — вызывающий код (Game.tsx) ждёт реального
    // завершения initialize(), прежде чем звать destroy().
    this.app.ticker?.remove(this.update)
    this.input.destroy()
    // Явно уничтожаем сцену САМИ (а не полагаемся на children:true у
    // app.destroy ниже) — иначе PIXI попытался бы рекурсивно уничтожить те
    // же самые контейнеры/спрайты ДВАЖДЫ (сцена уже уничтожена явно, потом
    // ещё раз через обход stage.children), что бросает исключение на уже
    // освобождённых внутренних WebGL-ресурсах.
    this.scene?.destroy()
    this.scene = null
    this.app.destroy(true, { children: false, texture: false })
    this.app = null
  }

  /** Dev-only: подписка на сглаженный FPS каждого тика (см. Time.getFps) —
   * используется только временным debug-оверлеем (Game.tsx), в проде не
   * вызывается вообще (см. гейт NODE_ENV там же). */
  public setFpsListener(listener: ((fps: number) => void) | null): void {
    this.onFpsSample = listener
  }

  /** Меню паузы (см. Game.tsx/PauseMenu) — тонкий проксі до текущей сцены
   * (см. Scene.setPaused/GameScene.setPaused). До готовности initialize()
   * (this.scene ещё null) — no-op, звать тут нечего. */
  public setPaused(paused: boolean): void {
    this.scene?.setPaused(paused)
  }

  /** "Начать уровень заново" из меню паузы — тот же проксі-принцип. */
  public restartLevel(): void {
    this.scene?.restartLevel()
  }

  private update = (): void => {
    if (!this.app) return

    this.time.update(this.app.ticker.deltaMS)
    this.scene?.update(this.time.deltaTime)
    this.onFpsSample?.(this.time.getFps())
  }
}
