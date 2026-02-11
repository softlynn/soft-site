import { useState } from "react";
import { Drawer, ListItem, List, ListItemText, IconButton, Divider, Box, ListItemIcon } from "@mui/material";
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
        <List>
          {mainLinks.map(({ title, path, icon }) => (
            <Box key={title}>
              <ListItem onClick={() => setDrawerOpen(false)}>
                <ListItemIcon>{icon}</ListItemIcon>
                <ListItemText>
                  <CustomLink color="primary" href={path} rel={path.startsWith("http") ? "noopener noreferrer" : undefined} target={path.startsWith("http") ? "_blank" : undefined}>
                    {title}
                  </CustomLink>
                </ListItemText>
              </ListItem>
              <Divider />
            </Box>
          ))}
          {socials.length > 0 && (
            <>
              <Divider />
              <Box sx={{ display: "flex", p: 2 }}>
                {socials.map(({ path, icon }) => (
                  <Box key={path} sx={{ mr: 2 }}>
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
      <IconButton onClick={() => setDrawerOpen(!drawerOpen)}>
        <Menu color="primary" />
      </IconButton>
    </Box>
  );
}
