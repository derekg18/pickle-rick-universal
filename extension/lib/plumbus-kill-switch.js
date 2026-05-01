export function shouldRunGenerativeAudit(env, args) {
    if (env['PLUMBUS_GENERATIVE_AUDIT'] === 'off')
        return false;
    if (args.includes('--no-generative'))
        return false;
    return true;
}
