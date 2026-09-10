"use client"

import { useEffect, useState } from "react"
import { useGameSocket } from "@/hooks/useGameSocket"
import { getGameServerUrl } from "@/game/network/GameSocket"
import { isLocalServerUrl, waitForServerReady } from "@/game/network/serverHealth"
import ServerLoadingScreen from "./ServerLoadingScreen"
import styles from "./ModeSelect.module.scss"

interface ModeSelectProps {
  /** Вызывается, как только режим выбран и (для co-op) комната успешно получена. */
  onReady: () => void
}

const ROOM_QUERY_PARAM = "room"

/** Дописывает (или убирает) ?room=<roomId> в адресной строке — не даёт React
 * Router'у, просто история браузера, чтобы не тянуть лишний роутинг ради
 * одного параметра. Именно так текущий URL становится ссылкой-приглашением:
 * скопировал адресную строку — отдал ссылку другу. */
function setRoomInUrl(roomId: string | null): void {
  if (typeof window === "undefined") return

  const url = new URL(window.location.href)
  if (roomId) {
    url.searchParams.set(ROOM_QUERY_PARAM, roomId)
  } else {
    url.searchParams.delete(ROOM_QUERY_PARAM)
  }
  window.history.replaceState(null, "", url.toString())
}

/**
 * Экран выбора режима перед стартом. Single Player стартует мгновенно, без
 * сети. Co-op подключается к NestJS-серверу через useGameSocket и ждёт ack
 * от комнаты, прежде чем пускать в игру — но перед самим подключением сперва
 * дожидается, пока сервер вообще проснётся (см. ServerLoadingScreen/
 * serverHealth.ts: бесплатный план Render "засыпает" после простоя).
 *
 * Подключение к комнате по ссылке: если открыть страницу с ?room=<id> в
 * адресе (ссылка, которую скопировал/отправил первый игрок — см.
 * RoomStatusBadge), экран сразу предлагает присоединиться именно к этой
 * комнате, а не к случайной свободной.
 */
export default function ModeSelect({ onReady }: ModeSelectProps) {
  const { startSolo, startCoop } = useGameSocket()
  const [isConnecting, setIsConnecting] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [invitedRoomId, setInvitedRoomId] = useState<string | null>(null)

  useEffect(() => {
    const roomId = new URLSearchParams(window.location.search).get(ROOM_QUERY_PARAM)
    setInvitedRoomId(roomId)

    // Будим сервер заранее, ещё пока игрок читает экран выбора режима — не
    // ждём, пока он нажмёт "Co-op": фоновый пинг молча запускает "холодный
    // старт" на Render немного раньше, реального UI это не блокирует (ошибки
    // тут не показываем — если не получилось, обычная попытка при клике по
    // Co-op всё равно подождёт сервер явно, с нормальным лоадером).
    //
    // maxWaitMs НЕ переопределяем тут явно — оставляем serverHealth решать
    // сам (90с для прод-адреса, но всего 6с для localhost, см. isLocalServerUrl):
    // раньше здесь стояло фиксированных 90с, и локально, если backend просто
    // не запущен, это означало 90 секунд повторяющихся GET .../health раз в
    // 1.5с в консоли — не "загрузка", а просто шум без единого шанса на успех.
    waitForServerReady(getGameServerUrl()).catch(() => {})
  }, [])

  const handleSolo = () => {
    // Одиночная игра по чужой ссылке-приглашению не имеет смысла — если
    // передумал присоединяться, убираем room из адреса, чтобы не сбивало с толку.
    setRoomInUrl(null)
    startSolo("worm")
    onReady()
  }

  const handleCoop = async (roomId?: string) => {
    setError(null)
    setIsConnecting(true)
    setElapsedMs(0)
    try {
      const serverUrl = getGameServerUrl()
      const serverReady = await waitForServerReady(serverUrl, {
        onAttempt: (_attempt, elapsed) => setElapsedMs(elapsed),
      })
      if (!serverReady) {
        throw new Error(
          isLocalServerUrl(serverUrl)
            ? "Локальный co-op сервер не отвечает — запусти его командой npm run dev:server"
            : "Сервер не отвечает — попробуйте ещё раз чуть позже",
        )
      }

      const room = await startCoop(roomId)
      setRoomInUrl(room.roomId)
      onReady()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось подключиться к серверу co-op")
    } finally {
      setIsConnecting(false)
    }
  }

  if (isConnecting) {
    return <ServerLoadingScreen elapsedMs={elapsedMs} isLocal={isLocalServerUrl(getGameServerUrl())} />
  }

  if (invitedRoomId) {
    return (
      <div className={styles.overlay}>
        <h1 className={styles.title}>Twin Morph</h1>
        <p className={styles.subtitle}>Тебя пригласили в комнату co-op — присоединиться к напарнику?</p>

        <div className={styles.options}>
          <button className={styles.option} onClick={() => handleCoop(invitedRoomId)} disabled={isConnecting}>
            <span className={styles.optionIcon}>🐜</span>
            <span className={styles.optionLabel}>Присоединиться</span>
            <span className={styles.optionHint}>{`Комната ${invitedRoomId.slice(0, 8)}`}</span>
          </button>

          <button className={styles.option} onClick={handleSolo} disabled={isConnecting}>
            <span className={styles.optionIcon}>🐛</span>
            <span className={styles.optionLabel}>Играть одному</span>
            <span className={styles.optionHint}>Без напарника</span>
          </button>
        </div>

        <div className={styles.status}>{error && <span className={styles.error}>{error}</span>}</div>
      </div>
    )
  }

  return (
    <div className={styles.overlay}>
      <h1 className={styles.title}>Twin Morph</h1>
      <p className={styles.subtitle}>Прогрызи тьму. Беги на свет.</p>

      <div className={styles.options}>
        <button className={styles.option} onClick={handleSolo} disabled={isConnecting}>
          <span className={styles.optionIcon}>🐛</span>
          <span className={styles.optionLabel}>Single Player</span>
          <span className={styles.optionHint}>Играть одному, без сети</span>
        </button>

        <button className={styles.option} onClick={() => handleCoop()} disabled={isConnecting}>
          <span className={styles.optionIcon}>🐜</span>
          <span className={styles.optionLabel}>Co-op (2 игрока)</span>
          <span className={styles.optionHint}>Подключиться к комнате</span>
        </button>
      </div>

      <div className={styles.status}>{error && <span className={styles.error}>{error}</span>}</div>
    </div>
  )
}
