import { Injectable } from "@nestjs/common"
import {
  createInitialPlayerState,
  stepPlayerState,
  type GameStateSnapshot,
  type PlayerForm,
  type PlayerInput,
  type PlayerState,
} from "../../../shared/game-protocol"

/**
 * Держит авторитетное игровое состояние (позиции игроков) по комнатам и
 * применяет к нему ввод. Позиция игрока НИКОГДА не берётся из того, что
 * прислал клиент напрямую — только из stepPlayerState на сервере (это и
 * есть "server authoritative": клиент лишь предлагает ввод, а не координаты).
 *
 * Упрощение (осознанное, не забытая доработка): сервер держит не очередь
 * всех инпутов игрока, а только САМЫЙ СВЕЖИЙ (по seq) — и раз в тик
 * интегрирует по нему один раз. Полная история инпутов и их построчный
 * replay нужны только на клиенте (GameNetworkStore) для honest reconciliation
 * локального игрока; серверу для авторитетной позиции достаточно знать
 * "текущую волю" игрока на момент тика.
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
