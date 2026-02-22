import { createContext } from "react";

const noop = () => {};

export const ThemeModeContext = createContext({
  themeMode: "light",
  toggleThemeMode: noop,
});

