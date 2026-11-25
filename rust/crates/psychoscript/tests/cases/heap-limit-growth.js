// A heap that keeps growing stops the run with MemoryLimitExceeded, which no handler or finally block sees.
console.log("start")
try {
  const kept = []
  while (true) kept.push({ n: kept.length, label: "item " + kept.length })
} catch (e) {
  return "caught"
} finally {
  console.log("finally")
}
