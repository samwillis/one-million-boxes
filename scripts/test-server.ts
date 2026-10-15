import { startTestStack } from "./test-stack"

const stack = await startTestStack(true)
console.log("Disposable browser-test stack: http://127.0.0.1:5174")
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void stack.stop().then(() => process.exit(0))
  })
