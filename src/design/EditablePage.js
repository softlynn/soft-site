import { useEffect, useMemo } from "react";
import { Render } from "@puckeditor/core";
import { Box } from "@mui/material";
import Footer from "../utils/Footer";
import HomeSponsor from "../utils/HomeSponsor";
import Loading from "../utils/Loading";
import NotFound from "../utils/NotFound";
import { SITE_TITLE } from "../config/site";
import { useSiteDesign } from "./DesignContext";
import { designConfig } from "./designConfig";
import { findDesignPageByPath } from "./defaultDesign";

export default function EditablePage({ path }) {
  const { design, loading } = useSiteDesign();
  const page = useMemo(() => findDesignPageByPath(design, path), [design, path]);

  useEffect(() => {
    if (!page) return;
    const rootProps = page?.puck?.root?.props || {};
    const title = rootProps.pageTitle || page.title || SITE_TITLE;
    document.title = page.path === "/" ? "soft" : title === SITE_TITLE ? SITE_TITLE : `${title} | ${SITE_TITLE}`;
  }, [page]);

  if (loading && !page) return <Loading />;
  if (!page || page.type !== "puck") return <NotFound />;

  const isHomePage = page.path === "/";

  return (
    <Box
      className={`soft-editable-page-scroll${isHomePage ? " soft-editable-page-scroll--home" : ""}`}
      sx={{
        minHeight: 0,
        height: "100%",
        overflowX: "hidden",
        overflowY: isHomePage ? { xs: "auto", md: "hidden" } : "auto",
        WebkitOverflowScrolling: "touch",
        overscrollBehaviorY: "contain",
      }}
    >
      <Box sx={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
        <Box sx={{ flex: "1 0 auto" }}>
          <Render config={designConfig} data={page.puck} metadata={{ page, design }} />
        </Box>
        {isHomePage && <HomeSponsor />}
        <Footer />
      </Box>
    </Box>
  );
}
