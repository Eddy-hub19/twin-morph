import { io, type Socket } from "socket.io-client"
import type { ClientToServerEvents, ServerToClientEvents } from "@/shared/game-protocol"

const SESSION_STORAGE_KEY = "twin-morph.sessionId"

/** Адрес NestJS co-op сервера — в single player эта переменная вообще не читается. */
const SERVER_URL = process.env.NEXT_PUBLIC_GAME_SERVER_URL ?? "http://localhost:3001"

export type TypedGameSocket = Socket<ServerToClientEvents, ClientToServerEvents>

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
        transports: ["websocket", "polling"],
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
