import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { DEFAULT_SITE_DESIGN, normalizeSiteDesign, SITE_DESIGN_PATH } from "./defaultDesign";

const DesignContext = createContext({
  design: normalizeSiteDesign(DEFAULT_SITE_DESIGN),
  loading: true,
  error: null,
  reloadDesign: async () => {},
  setDesign: () => {},
});

const fetchStaticDesign = async () => {
  const response = await fetch(`${SITE_DESIGN_PATH}?v=${Date.now()}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Failed to load site design (${response.status})`);
  }
  return response.json();
};

export function DesignProvider({ children }) {
  const [design, setDesignState] = useState(() => normalizeSiteDesign(DEFAULT_SITE_DESIGN));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const setDesign = useCallback((nextDesign) => {
    setDesignState(normalizeSiteDesign(nextDesign));
  }, []);

  const reloadDesign = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await fetchStaticDesign();
      setDesign(payload);
      setError(null);
    } catch (loadError) {
      setDesign(DEFAULT_SITE_DESIGN);
      setError(loadError);
    } finally {
      setLoading(false);
    }
  }, [setDesign]);

  useEffect(() => {
    reloadDesign();
  }, [reloadDesign]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const settings = design?.settings || {};
    const root = document.documentElement;
    const setVar = (name, value, fallback) => {
      root.style.setProperty(name, String(value || fallback));
    };

    setVar("--soft-bg", settings.backgroundColor, "#fff1a8");
    setVar("--soft-body-font", settings.bodyFontFamily, "\"Poppins\", \"Manrope\", \"Segoe UI\", sans-serif");
    setVar("--soft-heading-font", settings.headingFontFamily, "\"Poppins\", \"Manrope\", sans-serif");
    setVar("--soft-brand-font", settings.brandFontFamily, "\"Poppins\", \"Manrope\", sans-serif");
    setVar("--soft-button-font", settings.buttonFontFamily, "\"Poppins\", \"Manrope\", \"Segoe UI\", sans-serif");
    setVar("--soft-salmon", settings.accentColor, "#d38f38");
    setVar("--soft-salmon-deep", settings.accentColor, "#b97425");
    setVar("--soft-blue", settings.secondaryAccentColor, "#607fca");
    setVar("--soft-blue-deep", settings.secondaryAccentColor, "#4568b6");

    const faviconUrl = String(settings.faviconUrl || "").trim();
    if (faviconUrl) {
      const href = faviconUrl.startsWith("/") ? `${process.env.PUBLIC_URL || ""}${faviconUrl}` : faviconUrl;
      let link = document.querySelector('link[rel="icon"]');
      if (!link) {
        link = document.createElement("link");
        link.setAttribute("rel", "icon");
        document.head.appendChild(link);
      }
      link.setAttribute("type", faviconUrl.endsWith(".ico") ? "image/x-icon" : "image/png");
      link.setAttribute("href", href);
    }
  }, [design]);

  const value = useMemo(
    () => ({
      design,
      loading,
      error,
      reloadDesign,
      setDesign,
    }),
    [design, error, loading, reloadDesign, setDesign]
  );

  return <DesignContext.Provider value={value}>{children}</DesignContext.Provider>;
}

export const useSiteDesign = () => useContext(DesignContext);
