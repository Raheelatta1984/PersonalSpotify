import os from "node:os";
import path from "node:path";

// Keep every test run's state out of the repo working tree.
process.env.SONGHUB_DATA_DIR = path.join(os.tmpdir(), `songhub-tests-${process.pid}`);
process.env.JAMENDO_CLIENT_ID = "";
