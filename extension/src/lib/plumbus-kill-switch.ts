export function shouldRunGenerativeAudit(
  env: Record<string, string | undefined>,
  args: string[],
): boolean {
  if (env['PLUMBUS_GENERATIVE_AUDIT'] === 'off') return false;
  if (args.includes('--no-generative')) return false;
  return true;
}
