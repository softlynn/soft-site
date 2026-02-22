import { useContext, useEffect, useMemo, useState } from "react";
import { IconButton, Tooltip } from "@mui/material";
import DarkModeRoundedIcon from "@mui/icons-material/DarkModeRounded";
import LightModeRoundedIcon from "@mui/icons-material/LightModeRounded";
import { ThemeModeContext } from "./ThemeModeContext";

export default function ThemeModeToggle({ sx = {}, variant = "floating", size = "small", announceKey = "default" }) {
  const { themeMode, toggleThemeMode } = useContext(ThemeModeContext);
  const [announce, setAnnounce] = useState(true);

  useEffect(() => {
    setAnnounce(true);
    const timer = window.setTimeout(() => setAnnounce(false), 1650);
    return () => window.clearTimeout(timer);
  }, [announceKey]);

  const label = useMemo(() => (themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"), [themeMode]);

  return (
    <Tooltip title={label}>
      <IconButton
        onClick={toggleThemeMode}
        color="primary"
        className={`soft-theme-toggle soft-theme-toggle--${variant}${announce ? " is-announce" : ""}`}
        sx={sx}
        size={size}
        aria-label={label}
      >
        {themeMode === "dark" ? <LightModeRoundedIcon fontSize="small" /> : <DarkModeRoundedIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  );
}

