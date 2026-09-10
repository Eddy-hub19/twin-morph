import { Assets, type Container, Sprite, type Texture } from "pixi.js"
import { OutlineFilter } from "pixi-filters"
import {
  PARTNER_OUTLINE_THICKNESS,
  PARTNER_OUTLINE_ALPHA,
  PARTNER_OUTLINE_QUALITY,
  PARTNER_LOOK_HOST_COLOR,
  PARTNER_LOOK_GUEST_COLOR,
  PARTNER_ACCESSORY_WIDTH,
} from "../config/GameConfig"

/** "host" — игрок, зашедший в комнату первым (RoomInfo.players[0]), "guest" —
 * второй. Порядок в RoomInfo.players общий для обоих клиентов (задаётся
 * сервером), поэтому оба клиента всегда согласны, кто есть кто. */
export type PartnerRole = "host" | "guest"

const ACCESSORY_PATH = "/assets/accessories/badge.png"

const LOOK_BY_ROLE: Record<PartnerRole, { color: number }> = {
  host: { color: PARTNER_LOOK_HOST_COLOR },
  guest: { color: PARTNER_LOOK_GUEST_COLOR },
}

/**
 * Визуальные "надстройки" напарника поверх уже существующего PNG-спрайта
 * Worm/Ant — контур (Pixi-фильтр, не трогает сами кадры анимации) и
 * маленький аксессуар-бейдж (отдельный прозрачный PNG, тонированный под
 * роль игрока). Ничего не знает про Worm/Ant напрямую — просто вешается на
 * любой Sprite/AnimatedSprite и живёт вместе с ним.
 *
 * Аксессуар добавляется ВНУТРЬ самого спрайта (а не рядом с ним в контейнере)
 * — тогда он бесплатно наследует все трансформации спрайта целиком: позицию,
 * поворот, отражение (scale.x = -1 у муравья при развороте), масштаб,
 * прозрачность и видимость, — ровно то, что требуется, без ручной синхронизации
 * каждый кадр. Раз он нарисован ВНУТРИ уже отмасштабированного спрайта,
 * компенسируем масштаб спрайта в обратную сторону, чтобы бейдж всегда был
 * одного и того же видимого размера, а не "ужимался" вместе с телом.
 */
export class PlayerCosmetics {
  private accessorySprite?: Sprite

  /** Навешивает контур + аксессуар на спрайт. targetSprite — тот же
   * AnimatedSprite/Sprite, что уже отображает персонажа (Worm/Ant.sprite). */
  public async apply(targetSprite: Container, role: PartnerRole): Promise<void> {
    const look = LOOK_BY_ROLE[role]

    targetSprite.filters = [
      new OutlineFilter({
        thickness: PARTNER_OUTLINE_THICKNESS,
        color: look.color,
        alpha: PARTNER_OUTLINE_ALPHA,
        quality: PARTNER_OUTLINE_QUALITY,
      }),
    ]

    const texture = ((Assets.get(ACCESSORY_PATH) as Texture | undefined) ?? (await Assets.load(ACCESSORY_PATH))) as Texture

    const accessory = new Sprite(texture)
    accessory.anchor.set(0.5)
    accessory.tint = look.color

    // Компенсируем масштаб родительского спрайта (Ant уменьшен под
    // ANT_DESIRED_HEIGHT, Worm рисуется 1:1) — иначе один и тот же бейдж
    // выглядел бы разного размера на червяке и муравье, хотя должен быть
    // одинаково маленьким "аксессуаром" у обоих.
    const parentScale = targetSprite.scale.x || 1
    const targetWidth = PARTNER_ACCESSORY_WIDTH / Math.abs(parentScale)
    const accessoryScale = targetWidth / texture.width
    accessory.scale.set(accessoryScale)

    // Возле головы — спрайты нарисованы головой вправо (в локальных,
    // ещё не отмасштабированных координатах текстуры самого спрайта).
    const textureWidth = targetSprite.width / Math.abs(parentScale)
    const textureHeight = targetSprite.height / Math.abs(parentScale)
    accessory.position.set(textureWidth * 0.3, -textureHeight * 0.55)

    this.accessorySprite = accessory
    targetSprite.addChild(accessory)
  }

  /** Снимает контур/аксессуар — используется, если сущность вдруг возвращается
   * к обычному (не-remote) виду; сейчас не вызывается, но держим на будущее. */
  public remove(targetSprite: Container): void {
    targetSprite.filters = []
    if (this.accessorySprite) {
      targetSprite.removeChild(this.accessorySprite)
      this.accessorySprite.destroy()
      this.accessorySprite = undefined
    }
  }
}
