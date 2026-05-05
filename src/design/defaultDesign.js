export const SITE_DESIGN_VERSION = 1;
export const SITE_DESIGN_PATH = `${process.env.PUBLIC_URL || ""}/data/site-design.json`;

export const SYSTEM_PAGE_TYPES = {
  VODS: "vods",
};

const makeId = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;

export const slugifyPagePath = (value) => {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^#?\/+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug ? `/${slug}` : "/";
};

const clone = (value) => JSON.parse(JSON.stringify(value));

export const createBlankPuckData = (title = "New Page") => ({
  root: {
    props: {
      pageTitle: title,
      pageDescription: "",
      backgroundMode: "gradient",
      backgroundColor: "#e2e9f3",
      backgroundGradient:
        "radial-gradient(circle at 15% 18%, rgba(212,107,140,0.13), transparent 36%), radial-gradient(circle at 82% 12%, rgba(89,145,226,0.15), transparent 44%), #e2e9f3",
      backgroundImage: "",
      textColor: "",
      maxWidth: "1180px",
      pagePaddingTop: 18,
      pagePaddingBottom: 24,
      sectionGap: 18,
      customCss: "",
    },
  },
  content: [
    {
      type: "TextBlock",
      props: {
        id: makeId("text"),
        eyebrow: "new page",
        title,
        body: "Add your text, images, links, and embeds here.",
        align: "left",
        width: "normal",
        surface: "glass",
        animation: "fade",
      },
    },
    {
      type: "DirectoryGrid",
      props: {
        id: makeId("directory"),
        title: "Start here",
        subtitle: "Replace these cards with the places, projects, images, or embeds you want this page to point to.",
        columns: "3",
        cardStyle: "glass",
        animation: "lift",
        items: [
          {
            title: "Image card",
            description: "Paste an image URL or a public image path.",
            imageUrl: "",
            href: "",
            buttonLabel: "Open",
            accentColor: "#d46b8c",
          },
          {
            title: "Embed card",
            description: "Add a Twitch, YouTube, Spotify, Discord, or custom iframe block below.",
            imageUrl: "",
            href: "",
            buttonLabel: "Open",
            accentColor: "#79a3e6",
          },
          {
            title: "Custom link",
            description: "Point this to another page, a social profile, or a project.",
            imageUrl: "",
            href: "",
            buttonLabel: "Open",
            accentColor: "#f2b36d",
          },
        ],
      },
    },
  ],
});

export const createPage = ({ title = "New Page", path, navLabel, navOrder = 20 } = {}) => {
  const normalizedPath = slugifyPagePath(path || title);
  const normalizedTitle = String(title || "New Page").trim() || "New Page";

  return {
    id: makeId("page"),
    type: "puck",
    title: normalizedTitle,
    path: normalizedPath,
    navLabel: String(navLabel || normalizedTitle).trim() || normalizedTitle,
    navVisible: true,
    navOrder,
    icon: "page",
    puck: createBlankPuckData(normalizedTitle),
  };
};

export const DEFAULT_SITE_DESIGN = {
  version: SITE_DESIGN_VERSION,
  updatedAt: "2026-05-05T00:00:00.000Z",
  settings: {
    headerBrandText: "softu",
    headerTagline: "directory and vod archive",
    headerLogoUrl: "",
    headerLogoSize: 52,
    headerRadius: 20,
    headerSurface: "glass",
    showHeaderLogo: true,
    showHeaderTitle: true,
    showSocials: true,
    navStyle: "pill",
    footerEnabled: true,
    footerText: "softu \u00a9 2026",
    footerLink1Label: "Backend by OP",
    footerLink1Href: "https://github.com/OP-Archives",
    footerLink2Label: "made with TypeGPU",
    footerLink2Href: "https://github.com/software-mansion/TypeGPU",
    footerLink3Label: "docs",
    footerLink3Href: "https://docs.swmansion.com/TypeGPU/examples",
    footerShowBuild: true,
    footerRadius: 20,
    footerSurface: "glass",
  },
  pages: [
    {
      id: "home",
      type: "puck",
      title: "Home",
      path: "/",
      navLabel: "Home",
      navVisible: true,
      navOrder: 0,
      icon: "home",
      puck: {
        root: {
          props: {
            pageTitle: "Softu",
            pageDescription: "A simpler front page for live embeds, links, images, and the VOD archive.",
            backgroundMode: "gradient",
            backgroundColor: "#e2e9f3",
            backgroundGradient:
              "radial-gradient(circle at 13% 14%, rgba(212,107,140,0.14), transparent 34%), radial-gradient(circle at 88% 10%, rgba(121,163,230,0.16), transparent 42%), linear-gradient(180deg, #eef4fb 0%, #dde7f2 100%)",
            backgroundImage: "",
            textColor: "",
            maxWidth: "1180px",
            pagePaddingTop: 12,
            pagePaddingBottom: 24,
            sectionGap: 18,
            customCss: "",
          },
        },
        content: [
          {
            type: "HeroDirectory",
            props: {
              id: "home-hero",
              eyebrow: "softu",
              title: "softu",
              subtitle: "home base, live embeds, links, and archive things",
              body: "A cleaner directory you can reshape whenever you want. Keep the stream embed, add image cards, make new pages, and point everything where it needs to go.",
              imageUrl: "",
              imageAlt: "",
              mediaMode: "twitch",
              layout: "text-left",
              surface: "glass",
              backgroundColor: "",
              accentColor: "#d46b8c",
              animation: "fade",
              minHeight: 360,
              buttons: [
                {
                  label: "Open VODs",
                  href: "/vods",
                  variant: "contained",
                  tone: "accent",
                  animation: "sheen",
                },
                {
                  label: "Twitch",
                  href: "configured:twitch",
                  variant: "outlined",
                  tone: "blue",
                  animation: "lift",
                },
              ],
            },
          },
          {
            type: "DirectoryGrid",
            props: {
              id: "home-directory",
              title: "Directory",
              subtitle: "Swap these cards for your pages, image collections, socials, projects, or anything else you want on the front page.",
              columns: "4",
              cardStyle: "glass",
              animation: "lift",
              items: [
                {
                  title: "VOD Archive",
                  description: "Full archive with filters and chat replay.",
                  imageUrl: "",
                  href: "/vods",
                  buttonLabel: "Open",
                  accentColor: "#d46b8c",
                },
                {
                  title: "Twitch",
                  description: "Live channel and stream page.",
                  imageUrl: "",
                  href: "configured:twitch",
                  buttonLabel: "Open",
                  accentColor: "#8b5cf6",
                },
                {
                  title: "YouTube",
                  description: "Uploaded videos and archive parts.",
                  imageUrl: "",
                  href: "configured:youtube",
                  buttonLabel: "Open",
                  accentColor: "#ef4444",
                },
                {
                  title: "Discord",
                  description: "Community widget and server link.",
                  imageUrl: "",
                  href: "configured:discord",
                  buttonLabel: "Open",
                  accentColor: "#5865f2",
                },
              ],
            },
          },
          {
            type: "EmbedGrid",
            props: {
              id: "home-embeds",
              title: "Embeds",
              subtitle: "These are regular editable iframe blocks, so you can replace them later.",
              columns: "2",
              surface: "glass",
              embeds: [
                {
                  title: "stream playlist",
                  src: "https://open.spotify.com/embed/playlist/39yiDX8UItwk0hakJdFM93?utm_source=generator",
                  height: 352,
                  aspectRatio: "custom",
                  allow:
                    "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture",
                  sandbox: "",
                },
                {
                  title: "discord",
                  src: "https://discord.com/widget?id=1470662936950210601&theme=dark",
                  height: 352,
                  aspectRatio: "custom",
                  allow: "",
                  sandbox: "allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts",
                },
              ],
            },
          },
          {
            type: "RecentVods",
            props: {
              id: "home-recent-vods",
              title: "Recent VODs",
              subtitle: "Latest uploads only. Open the full VODs page for filters and the complete archive.",
              count: 4,
              showButton: true,
              surface: "glass",
            },
          },
        ],
      },
    },
    {
      id: "vods",
      type: "system",
      systemType: SYSTEM_PAGE_TYPES.VODS,
      title: "VODs",
      path: "/vods",
      navLabel: "VODs",
      navVisible: true,
      navOrder: 10,
      icon: "vods",
    },
  ],
};

const normalizePage = (page, index) => {
  const fallback = createPage({ title: `Page ${index + 1}`, navOrder: index * 10 });
  const type = page?.type === "system" ? "system" : "puck";
  const title = String(page?.title || fallback.title).trim() || fallback.title;
  const path = page?.id === "home" ? "/" : slugifyPagePath(page?.path || title);

  return {
    ...fallback,
    ...page,
    type,
    title,
    path,
    navLabel: String(page?.navLabel || title).trim() || title,
    navVisible: page?.navVisible !== false,
    navOrder: Number.isFinite(Number(page?.navOrder)) ? Number(page.navOrder) : index * 10,
    icon: String(page?.icon || (path === "/" ? "home" : type === "system" ? "vods" : "page")),
    puck: type === "puck" ? page?.puck || createBlankPuckData(title) : undefined,
  };
};

export const normalizeSiteDesign = (payload) => {
  const source = payload && typeof payload === "object" ? payload : {};
  const defaults = clone(DEFAULT_SITE_DESIGN);
  const pages = Array.isArray(source.pages) ? source.pages.map(normalizePage) : defaults.pages;
  const hasHome = pages.some((page) => page.path === "/");
  const hasVods = pages.some((page) => page.path === "/vods");
  const nextPages = [
    ...(hasHome ? [] : [defaults.pages[0]]),
    ...pages,
    ...(hasVods ? [] : [defaults.pages[1]]),
  ];

  return {
    ...defaults,
    ...source,
    version: SITE_DESIGN_VERSION,
    settings: {
      ...defaults.settings,
      ...(source.settings || {}),
    },
    pages: nextPages
      .map(normalizePage)
      .sort((a, b) => Number(a.navOrder || 0) - Number(b.navOrder || 0)),
  };
};

export const getVisibleNavPages = (design) =>
  normalizeSiteDesign(design).pages
    .filter((page) => page.navVisible !== false)
    .sort((a, b) => Number(a.navOrder || 0) - Number(b.navOrder || 0));

export const findDesignPageByPath = (design, pathname) => {
  const normalizedPath = pathname === "/" ? "/" : slugifyPagePath(pathname);
  return normalizeSiteDesign(design).pages.find((page) => page.path === normalizedPath) || null;
};
