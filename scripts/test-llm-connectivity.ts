/**
 * scripts/test-llm-connectivity.ts — quick smoke test for agent/openai.ts
 * Run: npx tsx scripts/test-llm-connectivity.ts
 */
import { chat, resolveLlmConfig } from "../src/agent/openai.js"

async function main() {
  const config = resolveLlmConfig()
  console.log(`✓ Config resolved: model=${config.model}, baseUrl=${config.baseUrl.replace(/\/$/, "")}`)
  console.log(`  API key: ${config.apiKey.slice(0, 6)}...${config.apiKey.slice(-4)}`)
  console.log()

  console.log("Sending test message...")
  const t0 = Date.now()
  const res = await chat({
    messages: [
      { role: "user", content: "Reply with exactly: CONNECTIVITY_OK" },
    ],
    maxTokens: 20,
    temperature: 0,
  }, config)
  const elapsed = Date.now() - t0

  console.log(`✓ Response in ${elapsed}ms`)
  console.log(`  finish_reason: ${res.finishReason}`)
  console.log(`  usage: ${res.usage.promptTokens} prompt + ${res.usage.completionTokens} completion tokens`)
  console.log(`  content: "${res.message.content}"`)

  if (res.message.content?.includes("CONNECTIVITY_OK")) {
    console.log("\n✅ LLM connectivity verified.")
  } else {
    console.log("\n⚠️ Got a response but content doesn't match expected. Check model behavior.")
  }
}

main().catch((err) => {
  console.error("❌ Connectivity test failed:")
  console.error(err.message)
  process.exit(1)
})
