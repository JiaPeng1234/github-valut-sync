// Mobile (iOS/Android) has no Node `buffer` builtin and no `Buffer` global.
// isomorphic-git's deps (readable-stream, sha.js, pako, crc-32) require both.
// esbuild injects this into every module so `Buffer` resolves at runtime.
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

export { Buffer };
