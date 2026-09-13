import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import type { MaterialKind } from "./Material"
import { LEAF_SIZE } from "../config/GameConfig"

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
      // Как и у листиков ниже — планка лежит только у поверхности (самого
      // начала) воды, не тянется на всю глубину увеличенного пруда: иначе
      // единственный слот выглядел бы сплошной коричневой стеной на фоне
      // мелких листиков у остальных.
      const plankHeight = Math.min(this.height, LEAF_SIZE * 1.4)
      this.platform.beginFill(0x6b4a2b)
      this.platform.drawRoundedRect(0, 0, this.width, plankHeight, 4)
      this.platform.endFill()
      this.platform.lineStyle(2, 0x4a3218)
      this.platform.moveTo(4, plankHeight / 2)
      this.platform.lineTo(this.width - 4, plankHeight / 2)
    } else {
      // Листики маленькие и фиксированного размера (тот же LEAF_SIZE, что и
      // у одиночного подбираемого листа) — не растянутые под ширину/высоту
      // слота, поэтому остаются маленькими даже когда пруд стал шире и
      // заметно глубже. Горизонтальный овал (шире, чем выше), та же
      // пропорция, что и у Leaf.ts (X/2 к X/2.6). Лежат только у самой
      // поверхности воды (leafCenterY у верхнего края слота) — глубже, в
      // толщу увеличенного пруда, не тянутся, это просто фон.
      const leafRadiusX = LEAF_SIZE / 2
      const leafRadiusY = LEAF_SIZE / 2.6
      // ceil + нахлёст (0.85 от диаметра), чтобы соседние листики
      // перекрывались и не оставляли щели воды между собой по ширине слота.
      const leafCount = Math.max(2, Math.ceil(this.width / (LEAF_SIZE * 0.85)))
      const leafSpacing = this.width / leafCount
      const leafCenterY = Math.min(this.height / 2, leafRadiusY + 3)
      for (let i = 0; i < leafCount; i++) {
        const lx = leafSpacing * (i + 0.5)
        this.platform.beginFill(0x5cb85c)
        this.platform.drawEllipse(lx, leafCenterY, leafRadiusX, leafRadiusY)
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
