import { styled, Typography, Box } from "@mui/material";
import CustomLink from "./CustomLink";
import Logo from "../assets/logo.png";
import { BRAND_NAME } from "../config/site";

const NotFound = styled((props) => {
  document.title = `Not Found - ${BRAND_NAME}`;
  return (
    <div {...props}>
      <Box className="soft-glass soft-shimmer" sx={{ px: 3, py: 2.5, borderRadius: "24px", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <img src={Logo} alt="" style={{ height: "auto", maxWidth: "160px" }} />
        <Typography variant="h6" sx={{ mt: 1.2, color: "text.primary" }}>
          lost in the clouds
        </Typography>
        <Typography variant="body2" sx={{ mt: 0.5, color: "text.secondary" }}>
          this route is not in the archive
        </Typography>
      </Box>
      <div style={{ display: "flex", justifyContent: "center", marginTop: "1rem" }}>
        <CustomLink href="/">
          <Typography variant="body2" sx={{ color: "text.secondary", fontWeight: 700 }}>
            Return Home
          </Typography>
        </CustomLink>
      </div>
    </div>
  );
})`
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  height: 100%;
  width: 100%;
  padding: 1rem;
`;

export default NotFound;
