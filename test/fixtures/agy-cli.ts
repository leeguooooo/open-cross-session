// A headless agy CLI double: no authentication or network use.
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.OCS_AGY_TEST_LOG) appendFileSync(process.env.OCS_AGY_TEST_LOG, JSON.stringify({ args, cwd: process.cwd(),
  pid: process.pid, identity: process.env.OCS_NAME, codex: process.env.CODEX_THREAD_ID ?? null, claude: process.env.CLAUDECODE ?? null }) + "\n");
await new Promise((wait) => setTimeout(wait, Number(process.env.OCS_AGY_TEST_DELAY ?? 0)));
console.log(JSON.stringify({ status: "SUCCESS", conversation_id: "11111111-1111-4111-8111-111111111111",
  response: process.env.OCS_AGY_TEST_LARGE === "1" ? "结果".repeat(20000) : "FAKE_AGY_OK" }));
