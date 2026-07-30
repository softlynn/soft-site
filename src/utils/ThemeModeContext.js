import { createContext } from "react";

const noop = () => {};

export const ThemeModeContext = createContext({
  themeMode: "dark",
  toggleThemeMode: noop,
  setThemeMode: noop,
});

