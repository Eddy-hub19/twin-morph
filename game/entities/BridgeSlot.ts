import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import type { MaterialKind } from "./Material"

/** Что можно установить в слот — обычный материал (лист/ветка, любой из
 * MaterialKind) или, только для последнего слота, большая ветка. */
export type SlotAccepts = "material" | "bigBranch"

/**
 * Один из BRIDGE_SLOT_COUNT последовательных слотов моста через Pond —
 * пока пуст, преграждает свою полосу пруда (муравей тонет, коснувшись её,
 * см. GameScene.update); после install() становится постоянной платформой
 * (аналог Puddle.placeBridge(), только по одной секции за раз, а не сразу
 * на весь пруд).
 *
 * Координаты — левый верхний угол (как у Pond/Wall), не центр.
 */
export class BridgeSlot extends Entity {
  public readonly id: string
  public readonly accepts: SlotAccepts

  private installedMaterialId: string | null = null
  private platform: Graphics

  constructor(x: number, y: number, width: number, height: number, id: string, accepts: SlotAccepts) {
    super()
    this.id = id
    this.accepts = accepts
    this.container.x = x
    this.container.y = y
    this.width = width
    this.height = height

    // Платформа скрыта, пока слот не заполнен — до этого тут просто видна
    // вода пруда (Pond рисуется отдельной сущностью позади).
    this.platform = new Graphics()
    this.platform.visible = false
    this.container.addChild(this.platform)
  }

  /** Ставит постоянную платформу поверх этой секции пруда — необратимо. */
  public install(materialId: string, kind: MaterialKind | "bigBranch"): void {
    if (this.installedMaterialId) return
    this.installedMaterialId = materialId

    this.platform.clear()
    if (kind === "bigBranch") {
      this.platform.beginFill(0x6b4a2b)
      this.platform.drawRoundedRect(0, 0, this.width, this.height, 4)
      this.platform.endFill()
      this.platform.lineStyle(2, 0x4a3218)
      this.platform.moveTo(4, this.height / 2)
      this.platform.lineTo(this.width - 4, this.height / 2)
    } else {
      const leafCount = Math.max(2, Math.round(this.width / (this.height * 0.9)))
      for (let i = 0; i < leafCount; i++) {
        const lx = (this.width / leafCount) * (i + 0.5)
        this.platform.beginFill(0x5cb85c)
        this.platform.drawEllipse(lx, this.height / 2, this.width / leafCount / 1.6, this.height / 2.2)
        this.platform.endFill()
      }
    }
    this.platform.visible = true
  }

  public get isInstalled(): boolean {
    return this.installedMaterialId !== null
  }

  public update(): void {
    // Слот статичен, логика обновления не нужна.
  }
}
