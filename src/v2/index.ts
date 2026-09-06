// This explicit offline check cannot log in, open user configuration or run
// installed plugins. Live startup is gated on account and migration validation.
export async function main(args: readonly string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--check") {
    const {offlineCheck} = await import("./offline-check.js");
    process.stdout.write(JSON.stringify(await offlineCheck()) + "\n");
    return;
  }
  if (args.length === 1 && args[0] === "--serve") {
    const {serve} = await import("./runtime.js");
    await serve();
    return;
  }
  throw new Error("Usage: node dist/v2/index.js --check|--serve");
}

if (require.main === module) {
  void main(process.argv.slice(2)).catch(error => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
    process.exitCode = 1;
  });
}
