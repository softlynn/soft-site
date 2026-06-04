# soft Site Design Intentions

Last updated: 2026-06-04

## Direction

soft should feel like a personal creator hub, not a dashboard or marketing site. The public shell is intentionally sparse: lowercase `soft` wordmark at top left, plain social icons at top right, pastel yellow background in light mode, and a near-black dark mode.

The site should stay quiet. Avoid heavy chrome, glassy stacked cards, large animated decorations, loading GIFs, or animated header interactions. Hover states should be understated: small opacity, color, or one-pixel lift changes.

## Typography

The Anny reference uses Poppins, so Poppins is the default and should remain available in admin font controls. Site-wide font settings should flow through design settings and CSS variables:

- `bodyFontFamily` for body/interface text.
- `headingFontFamily` for page headings.
- `brandFontFamily` for the top-left wordmark.
- `buttonFontFamily` for buttons.

Changing these settings should keep the site cohesive across editable pages, VOD cards, admin views, and utility pages.

## Shell

The header is not a framed header anymore. It is a simple top strip:

- Top-left brand text only.
- Top-right socials ordered Twitch, Twitter, YouTube, Discord.
- Bottom-left simple dark/light toggle.
- Optional VOD icon button may be enabled in admin, but the primary path to VODs should be an editable page button or Recent VODs block.

Admin access lives on the footer text. Clicking `soft © 2026` prompts for the admin password and opens `/admin`.

## Footer

Default footer on public pages, VOD archive, and VOD player: centered `soft © 2026`.

## VOD Cards

VOD thumbnails should look clean and reliable. Prefer stable YouTube thumbnail URLs generated from the video ID, then fall back through Twitch/game/default thumbnails. Avoid expired signed YouTube thumbnail URLs as the first choice.

Cards may keep admin-configurable style options, but the default should be cleaner than the previous glass/shimmer look. No automatic shimmer on the first card.

## Admin And Styling

The design editor is the long-term source of truth for public visual changes. Keep the following editable there:

- Site background and dark mode behavior.
- Favicon URL/upload.
- Header wordmark/social settings.
- Site font settings.
- VOD card style and thumbnail treatment.
- Footer text and VOD credit.
- 404 title/body/button/image.
- Editable home/page blocks, including embeds and Recent VODs.

When adding new backend-managed site data, prefer extending `public/data/site-design.json` and normalizing it in `src/design/defaultDesign.js` so missing settings get safe defaults.
