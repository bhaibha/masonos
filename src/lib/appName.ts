/**
 * WHAT THIS APP IS CALLED — one place, because it was in nine.
 *
 * "Mason OS" was hard-coded into five screens, two exported documents, the
 * service worker and index.html. Renaming it meant finding all of them, and
 * the two that were missed would have been the ones a client sees: the NCR
 * PDF and the project archive.
 *
 * The two forms exist because they are shown in different amounts of space:
 *
 *   APP_NAME       the wordmark, and `short_name` in the manifest — what sits
 *                  under the icon on a phone home screen, where anything long
 *                  is truncated with an ellipsis by the operating system.
 *   APP_NAME_FULL  `name` in the manifest — the install prompt and splash
 *                  screen — and anything leaving the building, where an
 *                  unexplained acronym is worse than three extra words.
 *
 * index.html, public/manifest.webmanifest and public/sw.js cannot import this
 * (they are not part of the TypeScript build), so those three carry the string
 * literally. If the name changes again, they are the ones to grep for.
 */

export const APP_NAME = 'YMS'
export const APP_NAME_FULL = 'YMS — Your Masons'
