/**
 * Provider marks — simplified, monochrome identification glyphs.
 *
 * These are NOT brand assets. They are deliberately simplified, geometrically
 * constructed marks whose only job is to let a person tell one provider row
 * apart from another at 16–24px. They are not pixel-accurate reproductions of
 * any company's trademark, must not be used as logos in marketing or product
 * chrome that implies endorsement, and should be replaced with each provider's
 * official asset (under its own brand guidelines) if that is ever what is
 * wanted.
 *
 * Every path uses `fill="currentColor"` and no gradients or hardcoded colours,
 * so a mark inherits the colour of its surrounding text — set `color` on the
 * container to theme it, including hover and disabled states.
 *
 * Where a real mark could not be reproduced accurately from memory, a clean
 * geometric placeholder is used instead and the reason is stated in a comment
 * directly above that component. A truthful placeholder is preferred to a
 * mangled approximation of a real logo.
 */

type MarkProps = { size?: number };

/**
 * Anthropic / Claude.
 *
 * An evocation of the radiating burst (the "asterisk"/starburst of tapered
 * blades), constructed as eight identical blades rotated about the centre
 * rather than traced from the real artwork. Blade count, taper, and corner
 * treatment are approximations — it reads as the right family of shape, it is
 * not the trademark.
 */
export const ClaudeMark = ({ size = 20 }: MarkProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <g fill="currentColor">
      <path d="M12 2.4 L13.25 9.8 L12 12 L10.75 9.8 Z" />
      <path d="M12 2.4 L13.25 9.8 L12 12 L10.75 9.8 Z" transform="rotate(45 12 12)" />
      <path d="M12 2.4 L13.25 9.8 L12 12 L10.75 9.8 Z" transform="rotate(90 12 12)" />
      <path d="M12 2.4 L13.25 9.8 L12 12 L10.75 9.8 Z" transform="rotate(135 12 12)" />
      <path d="M12 2.4 L13.25 9.8 L12 12 L10.75 9.8 Z" transform="rotate(180 12 12)" />
      <path d="M12 2.4 L13.25 9.8 L12 12 L10.75 9.8 Z" transform="rotate(225 12 12)" />
      <path d="M12 2.4 L13.25 9.8 L12 12 L10.75 9.8 Z" transform="rotate(270 12 12)" />
      <path d="M12 2.4 L13.25 9.8 L12 12 L10.75 9.8 Z" transform="rotate(315 12 12)" />
    </g>
  </svg>
);

/**
 * OpenAI — PLACEHOLDER, not the real mark.
 *
 * The OpenAI mark is a single continuous interlocking knot: six lobes woven
 * through one another with precise over/under crossings and open, chamfered
 * terminals. I cannot reproduce that path data accurately from memory, and a
 * bad freehand version would read as a broken logo rather than a simplified
 * one. What follows is an honest geometric stand-in that keeps only the
 * hexagonal silhouette and centred core: a hexagon ring with a centre dot.
 * Swap in the official SVG when brand-accurate rendering is required.
 */
export const OpenAIMark = ({ size = 20 }: MarkProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M12 2 L20.66 7 L20.66 17 L12 22 L3.34 17 L3.34 7 Z
         M12 4.8 L18.24 8.4 L18.24 15.6 L12 19.2 L5.76 15.6 L5.76 8.4 Z"
    />
    <circle cx="12" cy="12" r="2.4" fill="currentColor" />
  </svg>
);

/**
 * GitHub — simplified circular mark, NOT the Octocat.
 *
 * The Octocat silhouette (ears, tentacle tail, the notch under the chin) is
 * far too much curve detail to recall exactly, and a wrong Octocat is worse
 * than no Octocat. Per the brief, this is the acceptable simplified
 * alternative: a ring enclosing a neutral branch/merge glyph, which reads as
 * "code host" without pretending to be the trademark.
 */
export const GitHubMark = ({ size = 20 }: MarkProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19Zm0 2a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15Z"
    />
    <g fill="currentColor">
      <rect x="9.1" y="8.6" width="1" height="6.8" rx="0.5" />
      <rect x="13.9" y="8.6" width="1" height="3.7" rx="0.5" />
      <rect x="9.6" y="11.3" width="5.3" height="1" rx="0.5" />
      <circle cx="9.6" cy="8.6" r="1.7" />
      <circle cx="9.6" cy="15.4" r="1.7" />
      <circle cx="14.4" cy="8.6" r="1.7" />
    </g>
  </svg>
);

/**
 * Built-in Novus agent — generic terminal / CLI mark.
 *
 * Wholly original geometry (no trademark involved): a rounded window frame
 * containing a prompt chevron and a caret rule.
 */
export const TerminalMark = ({ size = 20 }: MarkProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M5 3.5h14a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-11a3 3 0 0 1 3-3Z
         M5 5.2h14a1.3 1.3 0 0 1 1.3 1.3v11a1.3 1.3 0 0 1-1.3 1.3H5a1.3 1.3 0 0 1-1.3-1.3v-11A1.3 1.3 0 0 1 5 5.2Z"
    />
    <path fill="currentColor" d="M6.9 8.5 L10.4 12 L6.9 15.5 L6 14.6 L8.6 12 L6 9.4 Z" />
    <rect x="11.8" y="14.4" width="5.2" height="1.3" rx="0.65" fill="currentColor" />
  </svg>
);