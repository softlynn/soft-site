import { useState } from "react";
import { Drawer, ListItemButton, List, ListItemText, IconButton, Divider, Box, ListItemIcon, Typography } from "@mui/material";
import { Menu } from "@mui/icons-material";
import HomeIcon from "@mui/icons-material/Home";
import OndemandVideoIcon from "@mui/icons-material/OndemandVideo";
import ReportIcon from "@mui/icons-material/Report";
import CustomLink from "../utils/CustomLink";
import { GITHUB_ISSUES_URL } from "../config/site";

const mainLinks = [
  { title: `Home`, path: `/`, icon: <HomeIcon color="primary" /> },
  { title: `Vods`, path: `/vods`, icon: <OndemandVideoIcon color="primary" /> },
  { title: `Issues`, path: GITHUB_ISSUES_URL, icon: <ReportIcon color="primary" /> },
].filter(({ path }) => Boolean(path));

export default function DrawerComponent(props) {
  const { socials } = props;
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <Box sx={{ mr: 1 }}>
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <Box sx={{ p: 2, pb: 1 }}>
          <Typography variant="subtitle2" sx={{ color: "text.secondary", letterSpacing: "0.04em" }}>
            Softu
          </Typography>
          <Typography variant="h6">Navigation</Typography>
        </Box>
        <List sx={{ pt: 0 }}>
          {mainLinks.map(({ title, path, icon }) => (
            <Box key={title}>
              <ListItemButton onClick={() => setDrawerOpen(false)} sx={{ borderRadius: 2, mx: 1 }}>
                <ListItemIcon>{icon}</ListItemIcon>
                <ListItemText>
                  <CustomLink color="primary" href={path} rel={path.startsWith("http") ? "noopener noreferrer" : undefined} target={path.startsWith("http") ? "_blank" : undefined}>
                    {title}
                  </CustomLink>
                </ListItemText>
              </ListItemButton>
              <Divider sx={{ mx: 2 }} />
            </Box>
          ))}
          {socials.length > 0 && (
            <>
              <Divider sx={{ mx: 2, mt: 0.5 }} />
              <Box sx={{ display: "flex", p: 2, gap: 1, flexWrap: "wrap" }}>
                {socials.map(({ path, icon }) => (
                  <Box
                    key={path}
                    sx={{
                      width: 34,
                      height: 34,
                      borderRadius: 2,
                      display: "grid",
                      placeItems: "center",
                      background: "rgba(255,255,255,0.55)",
                      border: "1px solid rgba(255,255,255,0.7)",
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.8)",
                    }}
                  >
                    <CustomLink href={path} rel="noopener noreferrer" target="_blank">
                      {icon}
                    </CustomLink>
                  </Box>
                ))}
              </Box>
            </>
          )}
        </List>
      </Drawer>
      <IconButton onClick={() => setDrawerOpen(!drawerOpen)} sx={{ borderRadius: "14px", background: "rgba(255,255,255,0.42)" }}>
        <Menu color="primary" />
      </IconButton>
    </Box>
  );
}
