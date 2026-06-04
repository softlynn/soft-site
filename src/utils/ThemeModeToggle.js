import { useContext, useMemo } from "react";
import { IconButton, Tooltip } from "@mui/material";
import DarkModeRoundedIcon from "@mui/icons-material/DarkModeRounded";
import LightModeRoundedIcon from "@mui/icons-material/LightModeRounded";
import { ThemeModeContext } from "./ThemeModeContext";

export default function ThemeModeToggle({ sx = {}, variant = "floating", size = "small" }) {
  const { themeMode, toggleThemeMode } = useContext(ThemeModeContext);
  const label = useMemo(() => (themeMode === "dark" ? "light" : "dark"), [themeMode]);

  return (
    <Tooltip title={label}>
      <IconButton
        onClick={toggleThemeMode}
        color="primary"
        className={`soft-theme-toggle soft-theme-toggle--${variant}`}
        sx={sx}
        size={size}
        aria-label={label}
      >
        {themeMode === "dark" ? <LightModeRoundedIcon fontSize="small" /> : <DarkModeRoundedIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  );
}
