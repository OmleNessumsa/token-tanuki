import { runBot } from "../src/bot.js";

runBot().catch((e) => { console.error(e); process.exit(1); });
