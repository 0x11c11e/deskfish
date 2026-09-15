/** Filled in by esbuild (`define`): package.json's version and an id per build. Under tsx (tests) they are undefined. */
declare const __DESKFISH_VERSION__: string | undefined;
declare const __DESKFISH_BUILD__: string | undefined;

/**
 * What `/status` and `hello` report, e.g. `0.1.0+m1abc2`. The build id makes a gateway left running
 * by an older build of the same version recognisable, so the extension can replace it.
 */
export const VERSION = `${typeof __DESKFISH_VERSION__ === 'string' ? __DESKFISH_VERSION__ : '0.0.0'}+${typeof __DESKFISH_BUILD__ === 'string' ? __DESKFISH_BUILD__ : 'dev'}`;
