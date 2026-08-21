/// <reference types="vite/client" />

interface ImportMetaEnv {
  // No build-time secrets: Buddy ships credential-free (G8).
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
