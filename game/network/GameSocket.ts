import { io, type Socket } from "socket.io-client"
import type { ClientToServerEvents, ServerToClientEvents } from "@/shared/game-protocol"

const SESSION_STORAGE_KEY = "twin-morph.sessionId"

/**
 * Продакшн-адрес зашит запасным вариантом на случай, если NEXT_PUBLIC_SOCKET_URL
 * не долетел до билда (например, в Vercel переменная окружения ещё не была
 * настроена на момент первого деплоя — NEXT_PUBLIC_* значения впечатываются
 * в бандл на этапе сборки, а не читаются заново в браузере) — тогда прод-сборка
 * всё равно не пытается стучаться на localhost. process.env.NODE_ENV тоже
 * впечатывается сборщиком, так что это условие честно решается на этапе билда.
 */
const SERVER_URL =
  process.env.NEXT_PUBLIC_SOCKET_URL ?? (process.env.NODE_ENV === "production" ? "https://twin-morph.onrender.com" : "http://localhost:3001")

export type TypedGameSocket = Socket<ServerToClientEvents, ClientToServerEvents>

/** Адрес co-op сервера, которым реально пользуется GameSocket — нужен снаружи
 * (см. game/network/serverHealth.ts) для health-check пинга перед подключением. */
export function getGameServerUrl(): string {
  return SERVER_URL
}

/**
 * Единственный на вкладку Socket.IO-клиент (singleton) — весь co-op трафик
 * идёт через один и тот же экземпляр, а не создаёт новое соединение на
 * каждый вызов/ререндер компонента. Single player эту сущность вообще не
 * трогает: GameNetworkStore.startSolo() к ней не обращается.
 */
export class GameSocket {
  private static instance: GameSocket | undefined

  private socket: TypedGameSocket | null = null

  public static getInstance(): GameSocket {
    if (!GameSocket.instance) {
      GameSocket.instance = new GameSocket()
    }
    return GameSocket.instance
  }

  private constructor() {}

  /**
   * Персистентный (localStorage) id этого браузера/вкладки — сервер узнаёт
   * по нему "это тот же самый игрок" при reconnect (см. RoomService.joinRoom
   * на сервере). Генерируется один раз и переживает перезагрузку страницы.
   */
  public getSessionId(): string {
    if (typeof window === "undefined") return ""

    let sessionId = window.localStorage.getItem(SESSION_STORAGE_KEY)
    if (!sessionId) {
      sessionId = crypto.randomUUID()
      window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId)
    }
    return sessionId
  }

  /** Ленивое подключение — создаёт сокет при первом вызове, дальше переиспользует его. */
  public connect(): TypedGameSocket {
    if (!this.socket) {
      this.socket = io(SERVER_URL, {
        autoConnect: true,
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionDelayMax: 4000,
        transports: ["websocket"],
      })
    } else if (!this.socket.connected) {
      this.socket.connect()
    }

    return this.socket
  }

  public getSocket(): TypedGameSocket | null {
    return this.socket
  }

  public isConnected(): boolean {
    return this.socket?.connected ?? false
  }

  /** Полностью закрывает соединение — используется, когда игрок явно выходит из co-op. */
  public disconnect(): void {
    this.socket?.disconnect()
  }
}
