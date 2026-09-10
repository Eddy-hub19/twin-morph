/**
 * Единая точка правды для CORS-адреса фронтенда — используется и в
 * main.ts (Express/HTTP), и в game.gateway.ts (Socket.IO — у него своя,
 * отдельная от Express CORS-конфигурация). Прод-адрес зашит запасным
 * вариантом на тот же случай, что и NEXT_PUBLIC_SOCKET_URL на клиенте
 * (GameSocket.ts): если FRONTEND_URL забыли настроить в Render, CORS должен
 * по умолчанию разрешать реальный прод-домен, а не тихо падать обратно на
 * localhost:3000 — иначе с Vercel вообще ничего не подключится.
 */
const PRODUCTION_FRONTEND_URL = "https://twin-morph.vercel.app"

/** Render сам выставляет эту переменную на всех своих сервисах — используем
 * её как дополнительный сигнал "мы точно в проде", не полагаясь только на NODE_ENV. */
function isProductionEnvironment(): boolean {
  return process.env.RENDER === "true" || process.env.NODE_ENV === "production"
}

export function getFrontendUrl(): string {
  return process.env.FRONTEND_URL ?? (isProductionEnvironment() ? PRODUCTION_FRONTEND_URL : "http://localhost:3000")
}
