import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    // Test và example import qua tên package nhưng chạy thẳng source, không cần build trước.
    // Subpath phải đứng TRƯỚC package gốc (alias match theo prefix).
    alias: {
      '@gm-net/transport-ws/server': fileURLToPath(
        new URL('./packages/transport-ws/src/server.ts', import.meta.url),
      ),
      '@gm-net/core': pkg('core'),
      '@gm-net/server': pkg('server'),
      '@gm-net/client': pkg('client'),
      '@gm-net/transport-ws': pkg('transport-ws'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
})
