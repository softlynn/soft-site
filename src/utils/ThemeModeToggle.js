import { useContext, useMemo, useState } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, IconButton, Tooltip } from "@mui/material";
import DarkModeRoundedIcon from "@mui/icons-material/DarkModeRounded";
import LightModeRoundedIcon from "@mui/icons-material/LightModeRounded";
import { ThemeModeContext } from "./ThemeModeContext";

export default function ThemeModeToggle({ sx = {}, variant = "floating", size = "small", confirmLightMode = false, onModeChange }) {
  const { themeMode, toggleThemeMode } = useContext(ThemeModeContext);
  const label = useMemo(() => (themeMode === "dark" ? "light" : "dark"), [themeMode]);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const applyMode = (mode) => {
    if (typeof onModeChange === "function") {
      onModeChange(mode);
      return;
    }
    toggleThemeMode();
  };

  const handleToggle = () => {
    if (confirmLightMode && themeMode === "dark") {
      setConfirmOpen(true);
      return;
    }
    applyMode(themeMode === "dark" ? "light" : "dark");
  };

  const confirmLightDefault = () => {
    setConfirmOpen(false);
    applyMode("light");
  };

  return (
    <>
      <Tooltip title={label}>
        <IconButton
          onClick={handleToggle}
          color="primary"
          className={`soft-theme-toggle soft-theme-toggle--${variant}`}
          sx={sx}
          size={size}
          aria-label={label}
        >
          {themeMode === "dark" ? <LightModeRoundedIcon fontSize="small" /> : <DarkModeRoundedIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} aria-labelledby="viewer-light-mode-title">
        <DialogTitle id="viewer-light-mode-title">Use light mode for VODs?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This will make light mode the default whenever you open the VOD viewer. You can switch back to dark mode at any time.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} color="inherit">Keep dark</Button>
          <Button onClick={confirmLightDefault} variant="contained">Use light mode</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
