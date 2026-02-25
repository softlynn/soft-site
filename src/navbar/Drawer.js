import { useState } from "react";
import { Drawer, ListItemButton, List, ListItemText, IconButton, Divider, Box, ListItemIcon, Typography } from "@mui/material";
import { Menu } from "@mui/icons-material";
import HomeIcon from "@mui/icons-material/Home";
import OndemandVideoIcon from "@mui/icons-material/OndemandVideo";
import CustomLink from "../utils/CustomLink";

const mainLinks = [
  { title: `Home`, path: `/`, icon: <HomeIcon color="primary" /> },
  { title: `Vods`, path: `/vods`, icon: <OndemandVideoIcon color="primary" /> },
];

export default function DrawerComponent(props) {
  const { socials, activeUploadCount = 0 } = props;
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
              <ListItemButton onClick={() => setDrawerOpen(false)} sx={{ borderRadius: 2, mx: 1, py: 0.75 }}>
                <ListItemIcon>{icon}</ListItemIcon>
                <ListItemText>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                    <CustomLink color="primary" href={path}>
                      {title}
                    </CustomLink>
                    {path === "/vods" && activeUploadCount > 0 && (
                      <Box
                        component="span"
                        sx={{
                          minWidth: 18,
                          height: 18,
                          px: 0.45,
                          borderRadius: "999px",
                          display: "grid",
                          placeItems: "center",
                          background: "rgba(212,107,140,0.18)",
                          border: "1px solid rgba(212,107,140,0.28)",
                          color: "secondary.main",
                          fontSize: 10.5,
                          fontWeight: 800,
                          lineHeight: 1,
                        }}
                      >
                        {activeUploadCount > 9 ? "9+" : activeUploadCount}
                      </Box>
                    )}
                  </Box>
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
                      background: "var(--soft-surface)",
                      border: "1px solid var(--soft-border)",
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14)",
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
      <IconButton onClick={() => setDrawerOpen(!drawerOpen)} sx={{ borderRadius: "14px", background: "var(--soft-surface)" }}>
        <Menu color="primary" />
      </IconButton>
    </Box>
  );
}
