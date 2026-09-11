import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import { MATERIAL_SIZE } from "../config/GameConfig"

/** Виды переносимого материала — лист/ветка кладутся в обычные слоты моста
 * (BridgeSlot), большая ветка — отдельная сущность (BigBranch), не Material. */
export type MaterialKind = "leaf" | "branch"

/**
 * Кусочек материала (лист или ветка) на уровне 3 (индекс 2, пруд/мост).
 * Заменяет прежний Leaf.ts для этого уровня — стабильный id (как у Star),
 * чтобы клейм "кто сейчас несёт" был общим на комнату (см.
 * RoomLevelState.materialCarriers/GameNetworkStore.requestMaterialGrab) и не
 * давал двум игрокам подобрать один и тот же материал разом.
 */
export class Material extends Entity {
  public readonly id: string
  public readonly kind: MaterialKind

  constructor(x: number, y: number, id: string, kind: MaterialKind) {
    super()
    this.id = id
    this.kind = kind
    this.container.x = x
    this.container.y = y

    this.width = MATERIAL_SIZE
    this.height = MATERIAL_SIZE

    const graphics = new Graphics()

    if (kind === "leaf") {
      graphics.beginFill(0x5cb85c)
      graphics.drawEllipse(0, 0, MATERIAL_SIZE / 2, MATERIAL_SIZE / 2.6)
      graphics.endFill()
      graphics.lineStyle(1.5, 0x3d7a3d)
      graphics.moveTo(-MATERIAL_SIZE / 2 + 2, 0)
      graphics.lineTo(MATERIAL_SIZE / 2 - 2, 0)
    } else {
      graphics.lineStyle(4, 0x6b4a2b)
      graphics.moveTo(-MATERIAL_SIZE / 2, MATERIAL_SIZE / 3)
      graphics.lineTo(MATERIAL_SIZE / 2, -MATERIAL_SIZE / 3)
      graphics.lineStyle(2, 0x8a6238)
      graphics.moveTo(-MATERIAL_SIZE / 4, MATERIAL_SIZE / 6)
      graphics.lineTo(0, -MATERIAL_SIZE / 5)
    }

    this.container.addChild(graphics)
  }

  public update(): void {
    // Материал статичен, пока его не подобрали (тогда просто прячется —
    // "в щелепах" рисует сам Ant, см. Ant.setCarriedMaterial).
  }
}
