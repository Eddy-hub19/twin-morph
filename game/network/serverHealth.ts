/**
 * Co-op сервер задеплоен на бесплатном плане Render — после ~15 минут без
 * запросов контейнер "засыпает", и первый же запрос может ждать до минуты,
 * пока он поднимется заново. WebSocket-хендшейк для этого плохо подходит
 * (клиент видит просто зависшее подключение, без понятного прогресса),
 * поэтому перед тем как звать GameSocket.connect(), сперва дёргаем обычный
 * HTTP-эндпоинт /health (см. server/src/app.controller.ts) — как только он
 * ответил 200, сервер точно живой и WebSocket подключится почти мгновенно.
 *
 * Локальная разработка (NEXT_PUBLIC_SOCKET_URL не задан/указывает на
 * localhost) — принципиально другой случай: тут никакого "холодного старта"
 * не бывает, сервер либо уже запущен (npm run dev:server) и отвечает почти
 * сразу, либо не запущен вовсе и НИКОГДА не ответит, сколько ни жди. 90
 * секунд ожидания в этом случае — не забота о пользователе, а вводящий в
 * заблуждение "сервер просыпается" на ровном месте, поэтому для localhost
 * ждём заметно меньше и объясняем причину иначе (см. isLocalServerUrl).
 */

const HEALTH_PATH = "/health"
const RETRY_DELAY_MS = 1500
const PER_ATTEMPT_TIMEOUT_MS = 5000

const REMOTE_MAX_WAIT_MS = 90_000
const LOCAL_MAX_WAIT_MS = 6_000

export interface WaitForServerReadyOptions {
  /** Вызывается перед каждой попыткой — для отображения прогресса в UI. */
  onAttempt?: (attempt: number, elapsedMs: number) => void
  /** Сколько всего ждать, прежде чем сдаться. По умолчанию зависит от адреса
   * (см. isLocalServerUrl) — для localhost короче, ждать там нечего. */
  maxWaitMs?: number
}

/** true, если адрес указывает на локальный сервер (localhost/127.0.0.1) —
 * там нет ни хостинга, ни холодного старта: либо сервер уже поднят и
 * отвечает почти мгновенно, либо просто не запущен. */
export function isLocalServerUrl(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl)
    return hostname === "localhost" || hostname === "127.0.0.1"
  } catch {
    return false
  }
}

/** true, если сервер ответил на /health в пределах maxWaitMs; false, если не дождались. */
export async function waitForServerReady(baseUrl: string, options: WaitForServerReadyOptions = {}): Promise<boolean> {
  const defaultMaxWait = isLocalServerUrl(baseUrl) ? LOCAL_MAX_WAIT_MS : REMOTE_MAX_WAIT_MS
  const { onAttempt, maxWaitMs = defaultMaxWait } = options
  const startedAt = Date.now()
  let attempt = 0

  while (Date.now() - startedAt < maxWaitMs) {
    attempt += 1
    onAttempt?.(attempt, Date.now() - startedAt)

    if (await pingOnce(baseUrl)) return true

    await sleep(RETRY_DELAY_MS)
  }

  return false
}

async function pingOnce(baseUrl: string): Promise<boolean> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS)

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${HEALTH_PATH}`, {
      signal: controller.signal,
      cache: "no-store",
    })
    return response.ok
  } catch {
    // Сервер ещё не проснулся, сеть моргнула, CORS до полной загрузки не
    // настроился и т.п. — это ожидаемо во время "холодного" старта, просто
    // пробуем ещё раз на следующей итерации.
    return false
  } finally {
    clearTimeout(timeoutId)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
