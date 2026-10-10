/**
 * Host half of the sound-notification bundle.
 *
 * Everything this plugin does happens in the browser: `client.js` subscribes to
 * the forwarded Host events through `ctx.remote.$on` and synthesizes the tones
 * with Web Audio. The Host row exists only so the package is composed as a
 * plugin entry with a client half.
 */
export function apply() {}
