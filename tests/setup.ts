import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every test worker gets its own state directory: suites run in parallel and must
// not share a download registry or event store (that made CI flaky).
const worker = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? String(process.pid);
const dataDir = path.join(os.tmpdir(), `songhub-tests-${worker}`);
process.env.SONGHUB_DATA_DIR = dataDir;
process.env.JAMENDO_CLIENT_ID = "";

// Share the pre-built fingerprint index (if `npm run index:audio` has been run)
// so parallel workers don't each spend ~16 s rebuilding it.
const source = path.join(process.cwd(), ".data", "cache");
const target = path.join(dataDir, "cache");
try {
  if (fs.existsSync(source)) {
    fs.mkdirSync(target, { recursive: true });
    for (const file of fs.readdirSync(source)) {
      if (!file.startsWith("fingerprint-index")) continue;
      fs.copyFileSync(path.join(source, file), path.join(target, file));
    }
  }
} catch {
  // missing cache is fine — the suite rebuilds it
}
