// Preloaded to run a process as a browser would: without the host's Buffer.
delete (globalThis as { Buffer?: unknown }).Buffer
