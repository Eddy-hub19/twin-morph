import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // Позволяет открывать dev-сервер с телефона/другого устройства в локальной
  // сети (например, для проверки сенсорного управления на мобилке).
  allowedDevOrigins: ["192.168.31.251"],
}

export default nextConfig
