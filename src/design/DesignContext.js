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

