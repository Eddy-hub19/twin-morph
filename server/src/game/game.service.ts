import { Injectable } from "@nestjs/common"
import {
  createInitialPlayerState,
  stepPlayerState,
  type GameStateSnapshot,
  type PlayerForm,
  type PlayerInput,
  type PlayerPosePayload,
  type PlayerState,
} from "../../../shared/game-protocol"

/**
 * Держит игровое состояние игроков по комнатам и рассылает его остальным.
 * Два независимых пути записи в состояние сосуществуют:
 *
 *  - queueInput()/tickRoom() — generic-путь: сервер сам считает позицию через
 *    stepPlayerState (честный "server authoritative" для абстрактного 2D-
 *    движения). Оставлен как переиспользуемая инфраструктура.
 *
 *  - setPose() — путь, которым реально ходит Twin Morph: копание/трава/стены
 *    процедурны и генерируются на каждом клиенте отдельно, сервер их не
 *    знает и не может честно пересчитать столкновения. Поэтому тут сервер —
 *    не физический авторитет, а просто доверенный ретранслятор: держит
 *    последнюю присланную клиентом позу (уже посчитанную ЕГО собственным
 *    Worm/Ant с учётом стен) и рассылает её остальным в комнате.
 *
 * tickRoom() ничего не ломает при setPose(): раз для позы, переданной через
 * setPose(), никогда не приходит соответствующий playerInput, ветка
 * "input ? stepPlayerState(...) : state" в tickRoom просто пропускает шаг
 * интеграции и переносит текущее (уже установленное setPose) состояние как
 * есть — то есть один и тот же тик обслуживает оба пути без конфликтов.
 */
@Injectable()
export class GameService {
  private statesByRoom = new Map<string, Map<string, PlayerState>>()
  private latestInputByPlayer = new Map<string, PlayerInput>()
  private formByPlayer = new Map<string, PlayerForm>()
  private tickCounter = 0

  public ensurePlayerState(roomId: string, playerId: string): PlayerState {
    let states = this.statesByRoom.get(roomId)
    if (!states) {
      states = new Map()
      this.statesByRoom.set(roomId, states)
    }

    let state = states.get(playerId)
    if (!state) {
      state = createInitialPlayerState(playerId, this.formByPlayer.get(playerId) ?? "worm")
      states.set(playerId, state)
    }

    return state
  }

  public queueInput(playerId: string, input: PlayerInput): void {
    const current = this.latestInputByPlayer.get(playerId)
    if (!current || input.seq > current.seq) {
      this.latestInputByPlayer.set(playerId, input)
    }
  }

  /** Клиент прислал уже посчитанную у себя позицию (реальный Worm/Ant) — просто сохраняем её как текущую. */
  public setPose(roomId: string, playerId: string, pose: PlayerPosePayload): void {
    const states = this.statesByRoom.get(roomId)
    if (!states) return

    const current = states.get(playerId) ?? createInitialPlayerState(playerId, pose.form)
    states.set(playerId, { ...current, x: pose.x, y: pose.y, form: pose.form })
  }

  public setPlayerForm(roomId: string, playerId: string, form: PlayerForm): void {
    this.formByPlayer.set(playerId, form)

    const state = this.statesByRoom.get(roomId)?.get(playerId)
    if (state) state.form = form
  }

  public removePlayer(roomId: string, playerId: string): void {
    this.statesByRoom.get(roomId)?.delete(playerId)
    this.latestInputByPlayer.delete(playerId)
    this.formByPlayer.delete(playerId)
  }

  public removeRoom(roomId: string): void {
    this.statesByRoom.delete(roomId)
  }

  /** Один тик авторитетной симуляции для одной комнаты — вызывается из GameLoopService. */
  public tickRoom(roomId: string, deltaSeconds: number): GameStateSnapshot {
    const states = this.statesByRoom.get(roomId)
    const players: PlayerState[] = []

    if (states) {
      for (const [playerId, state] of states) {
        const input = this.latestInputByPlayer.get(playerId)
        const next = input ? stepPlayerState(state, input, deltaSeconds) : state
        const withSeq: PlayerState = { ...next, lastProcessedSeq: input?.seq ?? state.lastProcessedSeq }

        states.set(playerId, withSeq)
        players.push(withSeq)
      }
    }

    this.tickCounter += 1
    return { roomId, tick: this.tickCounter, timestamp: Date.now(), players }
  }
}
